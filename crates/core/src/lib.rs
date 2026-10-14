//! The trusted core of Glaze Vault: encrypted storage, keys and (later) access checks and sync.
//! The Tauri app is a thin layer over this crate, and nothing here knows about Tauri
//! (docs/adr/0001-tauri-rust-react.md).

mod crypto;
mod error;
mod keyring;
mod recovery;
mod store;
mod vault;

pub use error::Error;
pub use recovery::RecoveryKey;
pub use vault::{MIN_PASSWORD_CHARS, RecipeHead, Vault};
