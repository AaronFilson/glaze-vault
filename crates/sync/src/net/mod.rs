//! The network around the sync (docs/adr/0021-transport-and-pairing.md): TLS 1.3 with pinned
//! Ed25519 keys and no certificate authority, pairing a new computer with a short code by SPAKE2,
//! finding the host by mDNS, and the server that `hostd` runs.

mod client;
mod conn;
mod discover;
mod pairing;
mod server;
mod tls;

pub use client::{
    AdminPairing, DirectoryHeld, Finished, SharedVault, Watching, check_out, devices, extension_code, hold_directory,
    pair, release, revoke_device, sync, sync_holding, sync_shared, watch,
};
pub use conn::Conn;
pub use discover::{Advertised, Found, SERVICE, advertise, browse, vault_tag};
pub use pairing::{CODE_LIFETIME, fingerprint};
pub use server::{Server, serve};
pub use tls::{client_config, server_config};

/// The port a host listens on unless its `host.json` names another.
pub const DEFAULT_PORT: u16 = 47917;
