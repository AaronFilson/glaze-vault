//! Backup files (docs/adr/0007-backups-locking-updates.md): the key file and a copy of the database in
//! one file, laid out as
//!
//! ```text
//! "GVBACKUP" | header length (u32, little-endian) | header (JSON) | nonce (24 bytes) | ciphertext
//! ```
//!
//! The header carries the key file as it was when the backup was made, so the backup opens with
//! that day's password or recovery key, and nothing else. The ciphertext is the SQLCipher database
//! file, encrypted again under a key from the database key, with everything before it as associated
//! data: a backup that was cut short or changed anywhere does not restore.

use crate::crypto::{self, Key, Sealed, b64};
use crate::error::{Error, Result};
use crate::keyring::Keyring;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const MAGIC: &[u8; 8] = b"GVBACKUP";
const FORMAT: u32 = 1;
const MAX_HEADER_BYTES: usize = 1024 * 1024;
const NONCE_BYTES: usize = 24;

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
    pub keyring: Keyring,
}

pub struct Backup {
    pub header: Header,
    /// Everything before the nonce, exactly as it is in the file.
    aad: Vec<u8>,
    sealed: Sealed,
}

impl Backup {
    /// Encrypts `database` (the database file's bytes) and returns the whole backup file.
    pub fn seal(
        vault_id: Uuid,
        created_at: i64,
        keyring: Keyring,
        database_key: &Key,
        database: &[u8],
    ) -> Result<Vec<u8>> {
        let header = Header {
            format: FORMAT,
            vault_id,
            created_at,
            app_version: env!("CARGO_PKG_VERSION").into(),
            salt: crypto::random::<32>().to_vec(),
            keyring,
        };
        let header_bytes = serde_json::to_vec(&header)?;
        let mut file = Vec::with_capacity(header_bytes.len() + database.len() + 64);
        file.extend_from_slice(MAGIC);
        file.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
        file.extend_from_slice(&header_bytes);
        let key = crypto::backup_key(database_key, &header.salt, &info(&vault_id));
        let sealed = crypto::encrypt(&key, database, &file);
        file.extend_from_slice(&sealed.nonce);
        file.extend_from_slice(&sealed.ciphertext);
        Ok(file)
    }

    /// Reads the parts of a backup file. Nothing is decrypted yet.
    pub fn parse(file: &[u8]) -> Result<Backup> {
        let rest = file.strip_prefix(MAGIC).ok_or(Error::NotABackup)?;
        let (length, rest) = rest.split_first_chunk::<4>().ok_or(Error::BackupDamaged)?;
        let length = u32::from_le_bytes(*length) as usize;
        if length > MAX_HEADER_BYTES || rest.len() < length + NONCE_BYTES {
            return Err(Error::BackupDamaged);
        }
        let (header_bytes, rest) = rest.split_at(length);
        let header: Header = serde_json::from_slice(header_bytes).map_err(|_| Error::BackupDamaged)?;
        if header.format > FORMAT {
            return Err(Error::NewerBackup);
        }
        if header.format != FORMAT || header.keyring.vault_id != header.vault_id {
            return Err(Error::BackupDamaged);
        }
        let (nonce, ciphertext) = rest.split_at(NONCE_BYTES);
        Ok(Backup {
            header,
            aad: file[..MAGIC.len() + 4 + length].to_vec(),
            sealed: Sealed {
                nonce: nonce.to_vec(),
                ciphertext: ciphertext.to_vec(),
            },
        })
    }

    /// The database file's bytes, once the database key is known.
    pub fn open(&self, database_key: &Key) -> Result<Vec<u8>> {
        let key = crypto::backup_key(database_key, &self.header.salt, &info(&self.header.vault_id));
        crypto::decrypt(&key, &self.sealed, &self.aad)
            .map(|database| database.to_vec())
            .ok_or(Error::BackupDamaged)
    }
}

fn info(vault_id: &Uuid) -> Vec<u8> {
    format!("glaze-vault v1 backup vault {vault_id}").into_bytes()
}
