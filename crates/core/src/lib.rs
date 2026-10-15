//! The trusted core of Glaze Vault: encrypted storage, keys and (later) access checks and sync.
//! The Tauri app is a thin layer over this crate, and nothing here knows about Tauri
//! (docs/adr/0001-tauri-rust-react.md).

mod backup;
mod crypto;
mod error;
mod files;
mod keyring;
mod recovery;
mod store;
mod vault;

pub use backup::EXTENSION as BACKUP_EXTENSION;
pub use error::Error;
pub use recovery::RecoveryKey;
pub use vault::{BackupInfo, Credential, Kind, LastBackup, MIN_PASSWORD_CHARS, Revision, Settings, Vault};
