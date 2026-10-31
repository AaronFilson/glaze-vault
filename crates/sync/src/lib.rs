//! Syncing a replica with the LAN host (docs/adr/0020-sync-core.md): the messages they send each
//! other, framed as CBOR, and the two sides of a sync as state machines that take a message in and
//! give one out. The sessions touch no socket: `net` carries their frames over TLS
//! (docs/adr/0021-transport-and-pairing.md), and tests can pass them in-process.

pub mod net;
pub mod proto;
mod session;

pub use proto::{ClientMsg, Frames, HostMsg, OLDEST, PROTOCOL, agree, frame};
pub use session::{ClientSession, HostSession, Report, sync_in_process};

/// What can go wrong in a sync.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Core(#[from] glaze_vault_core::Error),
    #[error("A message could not be read or written: {0}")]
    Encoding(String),
    #[error("A message of {0} bytes is larger than the most allowed.")]
    TooLarge(usize),
    #[error("The other side did not follow the protocol: {0}")]
    Protocol(String),
    #[error("The connection failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("The secure connection failed: {0}")]
    Tls(#[from] rustls::Error),
    #[error("The other side closed the connection.")]
    Closed,
    #[error("Pairing failed: {0}")]
    Pairing(String),
    #[error("Finding hosts on the network failed: {0}")]
    Discovery(String),
}

pub type Result<T> = std::result::Result<T, Error>;
