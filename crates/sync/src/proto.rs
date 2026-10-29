//! The messages of a sync, and how they are framed: a 4-byte big-endian length, then the message
//! as CBOR, which is compact for bytes and lets fields be added later (plan section 3.8).

use crate::{Error, Result};
use glaze_vault_core::sync::{
    Batch, Checkout, Chunk, DeviceCertificate, DeviceInfo, Item, JoinPackage, Level, PushResult, Scope, Welcome,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The version of the protocol. A host refuses a computer that speaks another.
pub const PROTOCOL: u32 = 1;

/// The largest frame either side takes: a 25 MiB photo and room to spare.
pub const MAX_FRAME: usize = 32 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClientMsg {
    /// Who the computer is, and what it last knew its people hold in each collection.
    Hello {
        protocol: u32,
        device: Uuid,
        levels: Vec<(Scope, Vec<Level>)>,
    },
    /// What comes after these cursors, up to about this many bytes.
    Pull {
        cursors: Vec<(Scope, i64)>,
        max_bytes: u32,
    },
    /// What was saved on the computer, in the order it was.
    Push {
        items: Vec<Item>,
    },
    Bye,
    /// A piece of an attachment's bytes from `offset` (plan section 3.7).
    GetChunk {
        id: Uuid,
        offset: u64,
    },
    /// A piece of the bytes of an attachment the computer will push.
    PutChunk(Chunk),
    /// Who is changing what (plan section 3.5).
    ListCheckouts,
    /// Checks a record out for one of the computer's people, or takes it over from whoever has it.
    CheckOut {
        record: Uuid,
        person: Uuid,
        take_over: bool,
    },
    Release {
        record: Uuid,
        person: Uuid,
    },
    /// Keeps the connection open to hear when there is something new to sync.
    Watch,
    /// An admin's computer waits until no other is changing people, roles or collections, and
    /// holds that until it closes the connection, so their changes cannot clash.
    LockDirectory,
    /// An admin's computer asks for a pairing code (plan section 4.3).
    StartPairing,
    /// The admin's computer waits for a new computer to use the code.
    AwaitPairing,
    /// The admin lets the new computer join, for the people its certificate names.
    ApproveDevice {
        certificate: DeviceCertificate,
    },
    /// An admin's computer asks which computers sync.
    ListDevices,
    /// A new computer's first SPAKE2 message, from the code.
    Pair {
        #[serde(with = "serde_bytes")]
        spake: Vec<u8>,
    },
    /// The new computer's proof that it has the code, bound to this TLS session, and who it is.
    /// Its signing key is the one it shows over TLS.
    PairConfirm {
        #[serde(with = "serde_bytes")]
        mac: Vec<u8>,
        device: Uuid,
        name: String,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostMsg {
    Welcome(Welcome),
    Batch(Batch),
    PushResult(PushResult),
    /// The piece asked for; none if the host has no such attachment for the computer.
    Chunk(Option<Chunk>),
    /// How much of the attachment's bytes the host has now.
    ChunkTaken {
        next: u64,
    },
    Checkouts(Vec<Checkout>),
    /// Something changed since the computer last heard: time to sync. Also sent now and then, so
    /// a quiet connection is seen to be alive.
    News,
    DirectoryLocked,
    /// The pairing code to read out, and until when it works (ms since the epoch).
    PairingCode {
        code: String,
        expires_at: i64,
    },
    /// A computer used the code: its name and key, for the admin to check and approve.
    PairingFinished {
        device: Uuid,
        name: String,
        #[serde(with = "serde_bytes")]
        signing_key: Vec<u8>,
    },
    Approved,
    Devices(Vec<DeviceInfo>),
    /// The host's SPAKE2 message.
    PairChallenge {
        #[serde(with = "serde_bytes")]
        spake: Vec<u8>,
    },
    /// The host's proof that it has the code too.
    PairConfirmed {
        #[serde(with = "serde_bytes")]
        mac: Vec<u8>,
    },
    /// What the new computer needs to join, once the admin approved it.
    Joined(Box<JoinPackage>),
    /// The host will not go on, and why.
    Refused {
        reason: String,
    },
}

/// A message as a frame.
pub fn frame<T: Serialize>(message: &T) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    ciborium::into_writer(message, &mut body).map_err(|e| Error::Encoding(e.to_string()))?;
    if body.len() > MAX_FRAME {
        return Err(Error::TooLarge(body.len()));
    }
    let mut framed = (body.len() as u32).to_be_bytes().to_vec();
    framed.extend(body);
    Ok(framed)
}

/// Bytes as they arrive, in pieces of any size, read back into messages.
#[derive(Default)]
pub struct Frames {
    buffer: Vec<u8>,
}

impl Frames {
    pub fn push(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    /// The next whole message, if it has all arrived.
    pub fn read<T: DeserializeOwned>(&mut self) -> Result<Option<T>> {
        let Some(length) = self.buffer.get(..4) else {
            return Ok(None);
        };
        let length = u32::from_be_bytes(length.try_into().expect("four bytes")) as usize;
        if length > MAX_FRAME {
            return Err(Error::TooLarge(length));
        }
        if self.buffer.len() < 4 + length {
            return Ok(None);
        }
        let message = ciborium::from_reader(&self.buffer[4..4 + length]).map_err(|e| Error::Encoding(e.to_string()))?;
        self.buffer.drain(..4 + length);
        Ok(Some(message))
    }
}
