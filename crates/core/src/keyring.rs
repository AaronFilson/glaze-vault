//! `vault.keys`, beside the database: what is needed to open the vault, and no secret in the clear
//! (docs/adr/0003-encryption-and-keys.md).

use crate::crypto::{PasswordKdf, Sealed, SealedBox};
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use uuid::Uuid;

pub const FORMAT: u32 = 1;

#[derive(Clone, Serialize, Deserialize)]
pub struct Keyring {
    pub format: u32,
    pub vault_id: Uuid,
    pub users: Vec<KeyringUser>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct KeyringUser {
    pub id: Uuid,
    pub name: String,
    /// The user's private key, under a key from their password.
    pub password_kdf: PasswordKdf,
    pub private_key: Sealed,
    /// The same private key, under a key from their recovery key.
    pub private_key_by_recovery: Sealed,
    /// The database key, sealed to the user's public key.
    pub database_key: SealedBox,
}

impl Keyring {
    pub fn read(path: &Path) -> Result<Self> {
        let keyring: Keyring = serde_json::from_slice(&fs::read(path)?)?;
        if keyring.format != FORMAT {
            return Err(Error::Corrupt(format!("unknown key file format {}", keyring.format)));
        }
        Ok(keyring)
    }

    /// Replaces the key file in one step, so a crash leaves the old keys or the new ones.
    pub fn write(&self, path: &Path) -> Result<()> {
        crate::files::write_atomically(path, &serde_json::to_vec_pretty(self)?)?;
        Ok(())
    }
}

pub fn private_key_aad(vault_id: &Uuid, user_id: &Uuid, by: &str) -> Vec<u8> {
    format!("glaze-vault v1 private-key by {by} vault {vault_id} user {user_id}").into_bytes()
}

pub fn database_key_info(vault_id: &Uuid, user_id: &Uuid) -> Vec<u8> {
    format!("glaze-vault v1 database-key vault {vault_id} user {user_id}").into_bytes()
}
