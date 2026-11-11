//! The host's backups, for an admin's computer (the plan's question 12, docs/adr/0025-host-backups-from-the-app.md):
//! the backups hostd keeps on the host computer, listed and put back from the app, and a backup
//! an admin's computer saves elsewhere as one file, laid out as
//!
//! ```text
//! "GVHOST01" | header length (u32, little-endian) | header (JSON) | the database file
//! ```
//!
//! The database is the host's SQLCipher file as it is, under the host's database key; the header
//! carries `host.json`, which has that key sealed to the host's key, and the host's key itself,
//! sealed to the organization's encryption key, so the file opens with the host computer or with
//! the organization's key, and nothing else. The header also has the database's length and
//! SHA-256, so a file cut short or changed does not go back.

use super::events::Body;
use super::{DATABASE_FILE, Vault, now_ms};
use crate::crypto::{self, KeyPair, SealedBox};
use crate::error::{Error, Result};
use crate::files;
use crate::sync::DeviceInfo;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::host::{BACKUP_PREFIX, HOST_FILE, HOST_KEY, HostStore, SAVED_SUFFIX, write_secret};

/// The folder in the host's own where hostd keeps its backups.
pub const BACKUPS: &str = "backups";
/// A file in the host's folder naming a backup to restore at the next start.
pub const RESTORE_FILE: &str = "restore-from";
/// The extension of a backup of the host saved elsewhere.
pub const HOST_BACKUP_EXTENSION: &str = "gvhost";

const MAGIC: &[u8; 8] = b"GVHOST01";
const FORMAT: u32 = 1;

fn host_key_info(vault: &Uuid) -> Vec<u8> {
    format!("glaze-vault v1 host-backup host-key vault {vault}").into_bytes()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    format: u32,
    vault_id: Uuid,
    created_at: i64,
    /// The organization's encryption key the host key is sealed to.
    #[serde(with = "crate::crypto::b64")]
    organization_key: Vec<u8>,
    host_key: SealedBox,
    /// `host.json` as it was.
    host_file: String,
    database_bytes: u64,
    #[serde(with = "crate::crypto::b64")]
    sha256: Vec<u8>,
}

/// One of the backups hostd keeps on the host computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBackup {
    /// Its folder's name, which names it to the host.
    pub name: String,
    pub made_at: i64,
    pub bytes: u64,
}

fn read_header(path: &Path) -> Result<(Header, BufReader<File>)> {
    let mut file = BufReader::new(File::open(path)?);
    let mut magic = [0u8; 8];
    let mut length = [0u8; 4];
    if file.read_exact(&mut magic).is_err() || &magic != MAGIC || file.read_exact(&mut length).is_err() {
        return Err(Error::NotABackup);
    }
    let length = u32::from_le_bytes(length) as usize;
    if length > 1024 * 1024 {
        return Err(Error::NotABackup);
    }
    let mut header = vec![0u8; length];
    file.read_exact(&mut header).map_err(|_| Error::NotABackup)?;
    let header: Header = serde_json::from_slice(&header).map_err(|_| Error::NotABackup)?;
    if header.format != FORMAT {
        return Err(Error::NotABackup);
    }
    Ok((header, file))
}

fn sha256_of(path: &Path) -> Result<(u64, Vec<u8>)> {
    let mut file = BufReader::new(File::open(path)?);
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut length = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        length += read as u64;
    }
    Ok((length, hash.finalize().to_vec()))
}

/// Copies `bytes` of `from` to `to`, and fails unless they are all there and hash to `sha256`.
fn copy_checked(from: &mut impl Read, to: &Path, bytes: u64, sha256: &[u8]) -> Result<()> {
    let mut hash = Sha256::new();
    files::write_atomically_with(to, |out| {
        let mut out = BufWriter::new(out);
        let mut left = from.take(bytes);
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            let read = left.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
            out.write_all(&buffer[..read])?;
        }
        out.flush()
    })?;
    if fs::metadata(to)?.len() != bytes || hash.finalize().as_slice() != sha256 {
        let _ = fs::remove_file(to);
        return Err(Error::NotABackup);
    }
    Ok(())
}

impl HostStore {
    fn backups_dir(&self) -> PathBuf {
        self.dir().join(BACKUPS)
    }

    /// The backups hostd keeps, newest first.
    pub fn backups(&self) -> Result<Vec<HostBackup>> {
        let Ok(entries) = fs::read_dir(self.backups_dir()) else {
            return Ok(Vec::new());
        };
        let mut found = Vec::new();
        for path in entries.filter_map(|e| e.ok().map(|e| e.path())) {
            let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            let Some(at) = name.strip_prefix(BACKUP_PREFIX) else {
                continue;
            };
            if !path.is_dir() || path.extension().is_some() {
                continue;
            }
            let made_at = at.split('-').next().and_then(|at| at.parse().ok()).unwrap_or(0);
            let bytes = fs::metadata(path.join(DATABASE_FILE)).map_or(0, |m| m.len());
            found.push(HostBackup { name, made_at, bytes });
        }
        found.sort_by(|a, b| b.name.cmp(&a.name));
        Ok(found)
    }

    /// Asks hostd to put back the backup named `name` (one of `backups`): it stops, and the
    /// system's service manager starts it again, restoring it before the store opens.
    pub fn ask_restore(&self, name: &str) -> Result<()> {
        if !self.backups()?.iter().any(|b| b.name == name) {
            return Err(Error::NotABackup);
        }
        let folder = self.backups_dir().join(name);
        files::write_atomically(&self.dir().join(RESTORE_FILE), folder.to_string_lossy().as_bytes())?;
        Ok(())
    }

    /// The organization's encryption key now, as the host was last told it.
    fn organization_encryption_key(&self) -> Result<Vec<u8>> {
        let body: Option<String> = self
            .conn
            .query_row(
                "SELECT e.body FROM events e JOIN changes c ON c.item_id = e.id
                 WHERE e.type = 'organization-key-added' ORDER BY c.seq DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match body.and_then(|b| serde_json::from_str::<Body>(&b).ok()) {
            Some(Body::OrganizationKeyAdded { encryption_key, .. }) => Ok(encryption_key),
            _ => Err(Error::Corrupt("the host has no organization key".into())),
        }
    }

    /// Writes a backup of the store now to `out`, as one file for an admin's computer to keep.
    pub fn export_backup(&mut self, out: &Path) -> Result<i64> {
        self.copy_for_export(out)?.write()
    }

    /// The part of [`export_backup`](Self::export_backup) that needs the store: its database
    /// copied beside `out`, for [`ExportCopy::write`] to make into the file with the store free
    /// for syncs again.
    pub fn copy_for_export(&mut self, out: &Path) -> Result<ExportCopy> {
        let organization_key = self.organization_encryption_key()?;
        let copy = out.with_extension("db.tmp");
        let read = (|| {
            self.snapshot(&copy)?;
            let secret = super::host_key::read(self.dir())?;
            let secret: crypto::Key = Zeroizing::new(
                secret
                    .as_slice()
                    .try_into()
                    .map_err(|_| Error::Corrupt("the host key is not valid".into()))?,
            );
            Ok((secret, fs::read_to_string(self.dir().join(HOST_FILE))?))
        })();
        match read {
            Ok((secret, host_file)) => Ok(ExportCopy {
                out: out.to_owned(),
                copy,
                vault_id: self.vault_id(),
                organization_key,
                secret,
                host_file,
            }),
            Err(e) => {
                let _ = fs::remove_file(&copy);
                Err(e)
            }
        }
    }

    /// Copies the database to `to` as it stands at one moment, under the same key. The store may
    /// be serving from another process meanwhile (`hostd export`), so the file is not copied as
    /// it lies: a checkpoint there could rewrite pages halfway through. SQLite's backup copies
    /// every page inside one read transaction, which a writer elsewhere cannot change under it.
    fn snapshot(&self, to: &Path) -> Result<()> {
        for stale in ["", "-wal", "-shm", "-journal"] {
            let _ = fs::remove_file(format!("{}{stale}", to.display()));
        }
        let key = super::host::database_key(self.dir())?;
        let mut copy = rusqlite::Connection::open(to)?;
        let pragma = Zeroizing::new(format!("PRAGMA key = \"x'{}'\";", hex::encode(key.as_ref())));
        copy.execute_batch(&pragma)?;
        {
            use rusqlite::backup::{Backup, StepResult};
            let backup = Backup::new(&self.conn, &mut copy)?;
            // Every page in one step, so in one read transaction; a step told to wait tries again.
            let mut tries = 0;
            loop {
                match backup.step(-1)? {
                    StepResult::Done => break,
                    _ if tries < 100 => {
                        tries += 1;
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    _ => return Err(Error::Corrupt("the store stayed busy while it was copied".into())),
                }
            }
        }
        // One file, with nothing left in a log beside it.
        copy.query_row("PRAGMA journal_mode = DELETE", [], |_| Ok(()))?;
        copy.close().map_err(|(_, e)| e)?;
        Ok(())
    }

    /// Takes a backup file an admin's computer kept, as one of the backups of the host in `dir`,
    /// and returns its name, for `ask_restore`. It must be of the vault `vault_id`, and open with
    /// this host's key. Only the latest one taken is kept. It needs only the host's folder, so
    /// the store goes on syncing meanwhile.
    pub fn import_backup(dir: &Path, vault_id: Uuid, file: &Path) -> Result<String> {
        let (header, mut database) = read_header(file)?;
        if header.vault_id != vault_id {
            return Err(Error::NotABackup);
        }
        let backups = dir.join(BACKUPS);
        fs::create_dir_all(&backups)?;
        let name = format!("{BACKUP_PREFIX}{}{SAVED_SUFFIX}", header.created_at);
        let folder = backups.join(&name);
        let partial = folder.with_extension("partial");
        let _ = fs::remove_dir_all(&partial);
        fs::create_dir_all(&partial)?;
        let unpacked = (|| {
            fs::write(partial.join(HOST_FILE), &header.host_file)?;
            copy_checked(
                &mut database,
                &partial.join(DATABASE_FILE),
                header.database_bytes,
                &header.sha256,
            )?;
            // It opens with this host's key, as a restore will open it.
            HostStore::check_backup(dir, &partial)?;
            let _ = fs::remove_dir_all(&folder);
            fs::rename(&partial, &folder)?;
            Ok(name)
        })();
        match &unpacked {
            Err(_) => {
                let _ = fs::remove_dir_all(&partial);
            }
            Ok(name) => {
                // Those sent before go: they are not pruned with the daily ones.
                for path in fs::read_dir(&backups)?.filter_map(|e| e.ok().map(|e| e.path())) {
                    let other = path.file_name().map(|n| n.to_string_lossy().into_owned());
                    if other.is_some_and(|n| n.ends_with(SAVED_SUFFIX) && &n != name) && path.is_dir() {
                        let _ = fs::remove_dir_all(&path);
                    }
                }
            }
        }
        unpacked
    }
}

/// The store's database copied for a backup file, from [`HostStore::copy_for_export`].
pub struct ExportCopy {
    out: PathBuf,
    copy: PathBuf,
    vault_id: Uuid,
    organization_key: Vec<u8>,
    secret: crypto::Key,
    host_file: String,
}

impl ExportCopy {
    /// Writes the backup file, and returns when it was made.
    pub fn write(self) -> Result<i64> {
        let written = (|| {
            let (database_bytes, sha256) = sha256_of(&self.copy)?;
            let created_at = now_ms();
            let header = Header {
                format: FORMAT,
                vault_id: self.vault_id,
                created_at,
                host_key: crypto::seal_key(&self.organization_key, &self.secret, &host_key_info(&self.vault_id)),
                organization_key: self.organization_key.clone(),
                host_file: self.host_file.clone(),
                database_bytes,
                sha256,
            };
            let header = serde_json::to_vec(&header)?;
            let mut database = BufReader::new(File::open(&self.copy)?);
            files::write_atomically_with(&self.out, |file| {
                let mut file = BufWriter::new(file);
                file.write_all(MAGIC)?;
                file.write_all(&(header.len() as u32).to_le_bytes())?;
                file.write_all(&header)?;
                std::io::copy(&mut database, &mut file)?;
                file.flush()
            })?;
            Ok(created_at)
        })();
        let _ = fs::remove_file(&self.copy);
        written
    }
}

impl Vault {
    /// When the backup of the host in `path` was made, for an admin: it must be of this vault,
    /// and its host key open with the organization's key.
    pub fn check_host_backup(&self, path: &Path) -> Result<i64> {
        let organization = self.admin()?;
        let (header, _) = read_header(path)?;
        if header.vault_id != self.keyring.vault_id || !opens(organization, &header) {
            return Err(Error::NotABackup);
        }
        Ok(header.created_at)
    }

    /// Makes the host's store in `staging` from a backup of this vault's host, opened with the
    /// organization's key, for an admin moving the host to this computer
    /// (docs/adr/0037-moving-the-host.md). The host keeps its key, so every computer's pin and
    /// the certificate for it hold; the store gets a new generation, so each computer sends again
    /// what reached the old host after the file was made. On a computer that syncs, the file must
    /// be of the host it pinned.
    ///
    /// The file may be older than what this computer knows (ADR 37): a computer revoked since it
    /// was made would sync again with the host it makes, since only the host keeps revocations.
    /// Such a file is refused with [`Error::HostBackupStale`] unless `anyway`, and then each
    /// revocation this computer knows of is made again in the new store. A file this computer's
    /// own device is not in, or is revoked in, is refused with [`Error::NotInHostBackup`].
    pub fn unpack_host_backup(&mut self, file: &Path, staging: &Path, anyway: bool) -> Result<HostStore> {
        let (header, mut database) = read_header(file)?;
        if header.vault_id != self.keyring.vault_id {
            return Err(Error::NotABackup);
        }
        let secret = crypto::open_key(self.admin()?, &header.host_key, &host_key_info(&header.vault_id))
            .ok_or(Error::NotABackup)?;
        // A folder of the caller's is used only if empty, and on failure only what this wrote goes.
        let created = !staging.exists();
        if !created && fs::read_dir(staging)?.next().is_some() {
            return Err(Error::VaultExists);
        }
        fs::create_dir_all(staging)?;
        let unpacked = (|| {
            write_secret(&staging.join(HOST_KEY), secret.as_slice())?;
            fs::write(staging.join(HOST_FILE), &header.host_file)?;
            copy_checked(
                &mut database,
                &staging.join(DATABASE_FILE),
                header.database_bytes,
                &header.sha256,
            )?;
            let mut host = HostStore::open(staging)?;
            // The hash says the file is as it was written; this says what was written is whole.
            let check: String = host.conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
            if check != "ok" {
                return Err(Error::NotABackup);
            }
            if self.is_replica() && self.host_key()? != host.identity() {
                return Err(Error::NotABackup);
            }
            let devices = host.devices()?;
            if self.is_replica() {
                let me = self.device()?;
                if !devices.iter().any(|d| d.id == me && !d.revoked) {
                    return Err(Error::NotInHostBackup);
                }
            }
            let missing: Vec<(Uuid, bool)> = self
                .known_revocations()?
                .into_iter()
                .filter(|(id, lost)| !devices.iter().any(|d| d.id == *id && d.revoked && (d.lost || !lost)))
                .collect();
            if !missing.is_empty() && !anyway {
                return Err(Error::HostBackupStale);
            }
            for (id, lost) in missing {
                match host.revoke_device(id, lost) {
                    // A computer that joined after the file was made is not in it to revoke.
                    Ok(_) | Err(Error::NotFound) => {}
                    Err(e) => return Err(e),
                }
            }
            host.new_generation()?;
            Ok(host)
        })();
        let host = match unpacked {
            Ok(host) => host,
            Err(e) => {
                if created {
                    let _ = fs::remove_dir_all(staging);
                } else {
                    for file in [HOST_KEY, HOST_FILE, DATABASE_FILE] {
                        for suffix in ["", "-wal", "-shm"] {
                            let _ = fs::remove_file(staging.join(format!("{file}{suffix}")));
                        }
                    }
                }
                return Err(e);
            }
        };
        // A host from before ADR 34 has its key certified now; it reaches the host at the next sync.
        self.certify_host(&host.identity())?;
        Ok(host)
    }
}

/// Where a replica keeps the computers it knows were revoked, as JSON: `[[id, lost], ...]`.
pub(super) const KNOWN_REVOKED: &str = "revoked_devices";

impl Vault {
    /// Remembers which computers the host says are revoked, from a listing of them an admin's
    /// computer fetched, so a host file made before can be told apart (ADR 37). Only the host
    /// keeps revocations; this is what this computer saw.
    pub fn note_revocations(&mut self, devices: &[DeviceInfo]) -> Result<()> {
        if !self.is_replica() {
            return Ok(());
        }
        let mut known = self.known_revocations()?;
        let before = known.clone();
        for device in devices.iter().filter(|d| d.revoked) {
            match known.iter_mut().find(|(id, _)| *id == device.id) {
                Some((_, lost)) => *lost |= device.lost,
                None => known.push((device.id, device.lost)),
            }
        }
        if known != before {
            self.set_meta(KNOWN_REVOKED, &serde_json::to_string(&known)?)?;
        }
        Ok(())
    }

    /// The computers this computer knows were revoked, and whether as lost.
    pub fn known_revocations(&self) -> Result<Vec<(Uuid, bool)>> {
        Ok(match self.meta(KNOWN_REVOKED)? {
            Some(text) => serde_json::from_str(&text)?,
            None => Vec::new(),
        })
    }
}

fn opens(organization: &KeyPair, header: &Header) -> bool {
    crypto::open_key(organization, &header.host_key, &host_key_info(&header.vault_id))
        .and_then(|secret| KeyPair::from_secret(Zeroizing::new(secret.to_vec())))
        .is_some()
}
