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
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::host::{BACKUP_PREFIX, HOST_FILE, HOST_KEY, HostStore, SAVED_SUFFIX};

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
        self.conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        let copy = out.with_extension("db.tmp");
        let read = (|| {
            fs::copy(self.dir().join(DATABASE_FILE), &copy)?;
            let secret = Zeroizing::new(fs::read(self.dir().join(HOST_KEY))?);
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
}

fn opens(organization: &KeyPair, header: &Header) -> bool {
    crypto::open_key(organization, &header.host_key, &host_key_info(&header.vault_id))
        .and_then(|secret| KeyPair::from_secret(Zeroizing::new(secret.to_vec())))
        .is_some()
}
