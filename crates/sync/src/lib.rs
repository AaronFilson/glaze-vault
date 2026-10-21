//! Syncing a replica with the LAN host (docs/adr/0020-sync-core.md): the messages they send each
//! other, framed as CBOR, and the two sides of a sync as state machines that take a message in and
//! give one out. Nothing here touches a socket: the transport (stage 5 of the plan) carries the
//! frames, and tests pass them in-process.

pub mod proto;
mod session;

pub use proto::{ClientMsg, Frames, HostMsg, PROTOCOL, frame};
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
}

pub type Result<T> = std::result::Result<T, Error>;
