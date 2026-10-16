//! `vault.keys`, beside the database: what is needed to open the vault, and no secret in the clear
//! (docs/adr/0003-encryption-and-keys.md).

use crate::crypto::{PasswordKdf, Sealed, SealedBox};
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use uuid::Uuid;

/// A one-person vault's key file.
pub const FORMAT: u32 = 1;
/// A team's, with an organization (docs/adr/0012-teams-on-one-computer.md). A one-person vault's
/// file is written as format 1, field for field as before, so older versions still open it.
pub const TEAM_FORMAT: u32 = 2;

#[derive(Clone, Serialize, Deserialize)]
pub struct Keyring {
    pub format: u32,
    pub vault_id: Uuid,
    pub users: Vec<KeyringUser>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<Organization>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct KeyringUser {
    pub id: Uuid,
    pub name: String,
    /// The user's private key, under a key from their password.
    pub password_kdf: PasswordKdf,
    pub private_key: Sealed,
    /// The same private key, under a key from their recovery key. None for someone an admin added
    /// who has not signed in yet: they get their recovery key then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key_by_recovery: Option<Sealed>,
    /// The database key, sealed to the user's public key.
    pub database_key: SealedBox,
    /// While the database key changes, the one before, in case the change did not finish.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_database_key: Option<SealedBox>,
    /// The user's public key, for an admin to seal keys to. Empty in a one-person vault's file.
    #[serde(default, with = "crate::crypto::b64", skip_serializing_if = "Vec::is_empty")]
    pub public_key: Vec<u8>,
    /// For an admin, the organization's private key, sealed to this user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_key: Option<SealedBox>,
    /// Added by an admin with a one-time password; they choose their own when they sign in.
    #[serde(default, skip_serializing_if = "is_false")]
    pub must_set_password: bool,
}

/// What makes a vault a team's: the organization's key pair, which admins hold (ADR 3).
#[derive(Clone, Serialize, Deserialize)]
pub struct Organization {
    #[serde(with = "crate::crypto::b64")]
    pub public_key: Vec<u8>,
    /// The organization's private key, under a key from its recovery key.
    pub private_key_by_recovery: Sealed,
    /// The database key, sealed to the organization, so its recovery key alone opens the vault.
    pub database_key: SealedBox,
}

fn is_false(value: &bool) -> bool {
    !value
}

impl Keyring {
    pub fn read(path: &Path) -> Result<Self> {
        let keyring: Keyring = serde_json::from_slice(&fs::read(path)?)?;
        let expected = if keyring.organization.is_some() {
            TEAM_FORMAT
        } else {
            FORMAT
        };
        if keyring.format != expected {
            return Err(Error::Corrupt(format!("unknown key file format {}", keyring.format)));
        }
        Ok(keyring)
    }

    /// Replaces the key file in one step, so a crash leaves the old keys or the new ones.
    pub fn write(&self, path: &Path) -> Result<()> {
        let mut keyring = self.clone();
        keyring.format = if keyring.organization.is_some() {
            TEAM_FORMAT
        } else {
            FORMAT
        };
        crate::files::write_atomically(path, &serde_json::to_vec_pretty(&keyring)?)?;
        Ok(())
    }

    pub fn user(&self, id: &Uuid) -> Result<&KeyringUser> {
        self.users.iter().find(|user| user.id == *id).ok_or(Error::NoSuchPerson)
    }
}

pub fn private_key_aad(vault_id: &Uuid, user_id: &Uuid, by: &str) -> Vec<u8> {
    format!("glaze-vault v1 private-key by {by} vault {vault_id} user {user_id}").into_bytes()
}

pub fn database_key_info(vault_id: &Uuid, user_id: &Uuid) -> Vec<u8> {
    format!("glaze-vault v1 database-key vault {vault_id} user {user_id}").into_bytes()
}

/// The organization's private key, sealed to an admin.
pub fn organization_key_info(vault_id: &Uuid, user_id: &Uuid) -> Vec<u8> {
    format!("glaze-vault v1 organization-key vault {vault_id} user {user_id}").into_bytes()
}

pub fn organization_recovery_aad(vault_id: &Uuid) -> Vec<u8> {
    format!("glaze-vault v1 organization private-key by recovery vault {vault_id}").into_bytes()
}

pub fn organization_database_key_info(vault_id: &Uuid) -> Vec<u8> {
    format!("glaze-vault v1 database-key vault {vault_id} organization").into_bytes()
}
