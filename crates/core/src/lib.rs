//! The trusted core of Glaze Vault: encrypted storage, keys and (later) access checks and sync.
//! The Tauri app is a thin layer over this crate, and nothing here knows about Tauri
//! (docs/adr/0001-tauri-rust-react.md).

mod access;
mod backup;
mod crypto;
mod error;
mod files;
mod keyring;
mod recovery;
mod signing;
mod store;
pub mod sync;
mod vault;

pub use access::Role;
pub use backup::EXTENSION as BACKUP_EXTENSION;
pub use error::Error;
pub use keyring::PersonEntry;
pub use recovery::RecoveryKey;
pub use vault::{
    Attachment, AuditEntry, AuditLog, BackupInfo, Capabilities, Collection, Credential, CustomRole, Fork, Grant, Kind,
    LastBackup, MAX_ATTACHMENT_BYTES, MIN_PASSWORD_CHARS, Note, OfflinePolicy, OfflineStatus, Person, Revision,
    RoleLimit, SetAside, Settings, SignatureCheck, Signed, SignedAs, Vault,
};
pub use vault::{BACKUPS as HOST_BACKUPS, ExportCopy, HOST_BACKUP_EXTENSION, HostBackup, HostStore, RESTORE_FILE};
