//! Backup files (docs/adr/0007-backups-locking-updates.md): the key file and a copy of the database in
//! one file, laid out as
//!
//! ```text
//! "GVBACKUP" | header length (u32, little-endian) | header (JSON) | chunks
//! ```
//!
//! The header carries the key file as it was when the backup was made, so the backup opens with
//! that day's password or recovery key, and nothing else. The chunks are the SQLCipher database
//! file, encrypted again under a key from the database key, a chunk at a time so that neither
//! making nor restoring a backup holds the whole vault in memory (format 2). Each chunk is
//! XChaCha20-Poly1305 with everything before the chunks as associated data, and a nonce of the
//! header's prefix, the chunk's number and whether it is the last (the STREAM construction): a
//! backup that was cut short, reordered or changed anywhere does not restore.
//!
//! Format 1, from before attachments, had the whole database as one ciphertext after a nonce:
//! `header | nonce (24 bytes) | ciphertext`. It still restores.

use crate::crypto::{self, Key, b64};
use crate::error::{Error, Result};
use crate::files;
use crate::keyring::Keyring;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;
use uuid::Uuid;
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"GVBACKUP";
const FORMAT: u32 = 2;
const MAX_HEADER_BYTES: usize = 1024 * 1024;
const NONCE_BYTES: usize = 24;
const NONCE_PREFIX_BYTES: usize = 15;
const TAG_BYTES: usize = 16;
/// How much of the database each chunk holds.
const CHUNK_BYTES: usize = 1024 * 1024;

/// The file extension backups are saved with.
pub const EXTENSION: &str = "gvbackup";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub format: u32,
    pub vault_id: Uuid,
    pub created_at: i64,
    pub app_version: String,
    #[serde(with = "b64")]
    pub salt: Vec<u8>,
    /// Format 2: the first bytes of every chunk's nonce.
    #[serde(with = "b64", default, skip_serializing_if = "Vec::is_empty")]
    pub nonce_prefix: Vec<u8>,
    /// Format 2: how much of the database each chunk holds; the last holds less.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_bytes: Option<usize>,
    pub keyring: Keyring,
}

/// A backup file whose header has been read. The rest is read when it is restored.
pub struct Backup {
    pub header: Header,
    /// Everything before the chunks, exactly as it is in the file.
    aad: Vec<u8>,
    file: BufReader<File>,
}

impl Backup {
    /// Writes a backup of the database file at `database` to `path`, a chunk at a time, through
    /// a temporary file beside it.
    pub fn write(
        path: &Path,
        vault_id: Uuid,
        created_at: i64,
        keyring: Keyring,
        database_key: &Key,
        database: &Path,
    ) -> Result<()> {
        let header = Header {
            format: FORMAT,
            vault_id,
            created_at,
            app_version: env!("CARGO_PKG_VERSION").into(),
            salt: crypto::random::<32>().to_vec(),
            nonce_prefix: crypto::random::<NONCE_PREFIX_BYTES>().to_vec(),
            chunk_bytes: Some(CHUNK_BYTES),
            keyring,
        };
        let header_bytes = serde_json::to_vec(&header)?;
        let mut aad = Vec::with_capacity(MAGIC.len() + 4 + header_bytes.len());
        aad.extend_from_slice(MAGIC);
        aad.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
        aad.extend_from_slice(&header_bytes);
        let cipher = cipher(database_key, &header);
        let mut input = BufReader::new(File::open(database)?);

        files::write_atomically_with(path, |out| {
            let mut out = BufWriter::new(out);
            out.write_all(&aad)?;
            let mut chunk = Zeroizing::new(vec![0u8; CHUNK_BYTES]);
            let mut number = 0u64;
            loop {
                let filled = fill(&mut input, &mut chunk)?;
                // A short chunk is the last; one that fills up is followed by at least an empty one.
                let last = filled < CHUNK_BYTES;
                let sealed = cipher
                    .encrypt(
                        &nonce(&header.nonce_prefix, number, last),
                        Payload {
                            msg: &chunk[..filled],
                            aad: &aad,
                        },
                    )
                    .map_err(|_| std::io::Error::other("a backup chunk did not encrypt"))?;
                out.write_all(&sealed)?;
                if last {
                    break;
                }
                number += 1;
            }
            out.flush()
        })?;
        Ok(())
    }

    /// Opens a backup file and reads its header. Nothing is decrypted yet.
    pub fn open(path: &Path) -> Result<Backup> {
        let mut file = BufReader::new(File::open(path)?);
        let mut magic = [0u8; MAGIC.len()];
        if fill(&mut file, &mut magic)? < MAGIC.len() || &magic != MAGIC {
            return Err(Error::NotABackup);
        }
        let mut length = [0u8; 4];
        if fill(&mut file, &mut length)? < length.len() {
            return Err(Error::BackupDamaged);
        }
        let length = u32::from_le_bytes(length) as usize;
        if length > MAX_HEADER_BYTES {
            return Err(Error::BackupDamaged);
        }
        let mut header_bytes = vec![0u8; length];
        if fill(&mut file, &mut header_bytes)? < length {
            return Err(Error::BackupDamaged);
        }
        let header: Header = serde_json::from_slice(&header_bytes).map_err(|_| Error::BackupDamaged)?;
        if header.format > FORMAT {
            return Err(Error::NewerBackup);
        }
        let well_formed = match header.format {
            1 => true,
            2 => {
                header.nonce_prefix.len() == NONCE_PREFIX_BYTES
                    && header
                        .chunk_bytes
                        .is_some_and(|bytes| bytes > 0 && bytes <= 64 * CHUNK_BYTES)
            }
            _ => false,
        };
        if !well_formed || header.keyring.vault_id != header.vault_id {
            return Err(Error::BackupDamaged);
        }
        let mut aad = Vec::with_capacity(MAGIC.len() + 4 + length);
        aad.extend_from_slice(MAGIC);
        aad.extend_from_slice(&(length as u32).to_le_bytes());
        aad.extend_from_slice(&header_bytes);
        Ok(Backup { header, aad, file })
    }

    /// Decrypts the database file into `out`, once the database key is known. Fails with
    /// BackupDamaged, having written part of it, if any of the file is not as it was made, so the
    /// caller writes to a temporary file and removes it then.
    pub fn restore_into(mut self, database_key: &Key, out: &mut impl Write) -> Result<()> {
        let cipher = cipher(database_key, &self.header);
        if self.header.format == 1 {
            let mut rest = Vec::new();
            self.file.read_to_end(&mut rest)?;
            if rest.len() < NONCE_BYTES {
                return Err(Error::BackupDamaged);
            }
            let (nonce, ciphertext) = rest.split_at(NONCE_BYTES);
            let nonce: [u8; NONCE_BYTES] = nonce.try_into().map_err(|_| Error::BackupDamaged)?;
            let database = cipher
                .decrypt(
                    &XNonce::from(nonce),
                    Payload {
                        msg: ciphertext,
                        aad: &self.aad,
                    },
                )
                .map(Zeroizing::new)
                .map_err(|_| Error::BackupDamaged)?;
            out.write_all(&database)?;
            return Ok(());
        }

        let sealed_bytes = self.header.chunk_bytes.unwrap_or(CHUNK_BYTES) + TAG_BYTES;
        let mut sealed = vec![0u8; sealed_bytes];
        let mut number = 0u64;
        loop {
            let filled = fill(&mut self.file, &mut sealed)?;
            let last = filled < sealed_bytes;
            let chunk = cipher
                .decrypt(
                    &nonce(&self.header.nonce_prefix, number, last),
                    Payload {
                        msg: &sealed[..filled],
                        aad: &self.aad,
                    },
                )
                .map(Zeroizing::new)
                .map_err(|_| Error::BackupDamaged)?;
            out.write_all(&chunk)?;
            if last {
                return Ok(());
            }
            number = number.checked_add(1).ok_or(Error::BackupDamaged)?;
        }
    }
}

fn cipher(database_key: &Key, header: &Header) -> XChaCha20Poly1305 {
    let info = match header.format {
        1 => format!("glaze-vault v1 backup vault {}", header.vault_id),
        _ => format!("glaze-vault v2 backup vault {}", header.vault_id),
    };
    let key = crypto::backup_key(database_key, &header.salt, info.as_bytes());
    XChaCha20Poly1305::new(&(*key).into())
}

/// A chunk's nonce: the backup's prefix, the chunk's number, and 1 for the last chunk.
fn nonce(prefix: &[u8], number: u64, last: bool) -> XNonce {
    let mut nonce = [0u8; NONCE_BYTES];
    nonce[..NONCE_PREFIX_BYTES].copy_from_slice(prefix);
    nonce[NONCE_PREFIX_BYTES..NONCE_BYTES - 1].copy_from_slice(&number.to_be_bytes());
    nonce[NONCE_BYTES - 1] = last as u8;
    XNonce::from(nonce)
}

/// Reads until `buffer` is full or the input ends, and says how much it read.
fn fill(input: &mut impl Read, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match input.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::random_key;

    fn keyring() -> Keyring {
        let dir = tempfile::tempdir().unwrap();
        let (vault, _) = crate::Vault::create(dir.path(), "cone six oxidation").unwrap();
        drop(vault);
        Keyring::read(&dir.path().join("vault.keys")).unwrap()
    }

    /// Database files of awkward sizes: empty, short, exactly one chunk, and more than one.
    #[test]
    fn databases_of_any_size_come_back_as_they_were() {
        let keyring = keyring();
        let key = random_key();
        let dir = tempfile::tempdir().unwrap();
        for size in [
            0,
            1,
            CHUNK_BYTES - 1,
            CHUNK_BYTES,
            CHUNK_BYTES + 1,
            2 * CHUNK_BYTES + 77,
        ] {
            let database: Vec<u8> = (0..size).map(|i| (i * 7 % 251) as u8).collect();
            let (db, backup) = (dir.path().join("vault.db"), dir.path().join("b.gvbackup"));
            std::fs::write(&db, &database).unwrap();
            Backup::write(&backup, keyring.vault_id, 1, keyring.clone(), &key, &db).unwrap();
            let mut out = Vec::new();
            Backup::open(&backup).unwrap().restore_into(&key, &mut out).unwrap();
            assert!(out == database, "size {size}");

            // Cut at a chunk boundary, it does not restore.
            let bytes = std::fs::read(&backup).unwrap();
            if size >= CHUNK_BYTES {
                let header = bytes.len() - (size / CHUNK_BYTES) * TAG_BYTES - TAG_BYTES - size;
                std::fs::write(&backup, &bytes[..header + CHUNK_BYTES + TAG_BYTES]).unwrap();
                let opened = Backup::open(&backup).unwrap();
                assert!(matches!(
                    opened.restore_into(&key, &mut Vec::new()),
                    Err(Error::BackupDamaged)
                ));
            }
        }
    }

    #[test]
    fn a_format_1_backup_still_restores() {
        let keyring = keyring();
        let key = random_key();
        let header = Header {
            format: 1,
            vault_id: keyring.vault_id,
            created_at: 1,
            app_version: "0.1.0".into(),
            salt: vec![7; 32],
            nonce_prefix: Vec::new(),
            chunk_bytes: None,
            keyring,
        };
        let header_bytes = serde_json::to_vec(&header).unwrap();
        let mut file = MAGIC.to_vec();
        file.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
        file.extend_from_slice(&header_bytes);
        let sealed = crypto::encrypt(
            &crypto::backup_key(
                &key,
                &header.salt,
                format!("glaze-vault v1 backup vault {}", header.vault_id).as_bytes(),
            ),
            b"the old database",
            &file,
        );
        file.extend_from_slice(&sealed.nonce);
        file.extend_from_slice(&sealed.ciphertext);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.gvbackup");
        std::fs::write(&path, &file).unwrap();
        let mut out = Vec::new();
        Backup::open(&path).unwrap().restore_into(&key, &mut out).unwrap();
        assert_eq!(out, b"the old database");
    }
}
