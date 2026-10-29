//! The two sides of one sync (plan section 3.8): the computer says hello, pulls until it has
//! everything after its cursors, fetches the bytes of attachments it pulled, sends the bytes of
//! its own and pushes what was saved on it, then asks who is changing what. Each side takes the
//! other's message and gives its next one; neither does any IO.

use crate::proto::{ClientMsg, Frames, HostMsg, PROTOCOL, frame};
use crate::{Error, Result};
use glaze_vault_core::sync::{Chunk, Item, Refusal};
use glaze_vault_core::{HostStore, Vault};
use std::collections::VecDeque;
use uuid::Uuid;

/// About how much one batch of a pull holds.
const PULL_BYTES: u32 = 4 * 1024 * 1024;
/// About how much one push holds.
const PUSH_BYTES: usize = 4 * 1024 * 1024;
/// How many pushes one sync makes at most: more waits for the next sync.
const MAX_PUSHES: usize = 8;
/// About how many bytes of photos one sync fetches: more waits for the next.
const FETCH_BYTES: u64 = 64 * 1024 * 1024;
/// The most of an attachment's bytes one piece carries.
const CHUNK_BYTES: usize = 1024 * 1024;

/// The host's side, for a computer the transport has already told it is `device`. The store is
/// passed with each message, so a server can share it between connections.
pub struct HostSession {
    device: Uuid,
    greeted: bool,
}

impl HostSession {
    pub fn new(device: Uuid) -> HostSession {
        HostSession { device, greeted: false }
    }

    pub fn device(&self) -> Uuid {
        self.device
    }

    /// The answer to a computer's message; none when it says goodbye.
    pub fn handle(&mut self, host: &mut HostStore, message: ClientMsg) -> Result<Option<HostMsg>> {
        let refused = |reason: &str| {
            Ok(Some(HostMsg::Refused {
                reason: reason.to_owned(),
            }))
        };
        match message {
            ClientMsg::Hello {
                protocol,
                device,
                levels,
            } => {
                if protocol != PROTOCOL {
                    return refused("this host speaks another version of the protocol: update the app");
                }
                if device != self.device {
                    return refused("the computer is not the one it said it was");
                }
                self.greeted = true;
                Ok(Some(HostMsg::Welcome(host.hello(self.device, &levels)?)))
            }
            _ if !self.greeted => refused("say hello first"),
            ClientMsg::Pull { cursors, max_bytes } => Ok(Some(HostMsg::Batch(host.pull(
                self.device,
                &cursors,
                max_bytes as usize,
            )?))),
            ClientMsg::Push { items } => Ok(Some(HostMsg::PushResult(host.accept(self.device, items)?))),
            ClientMsg::GetChunk { id, offset } => Ok(Some(HostMsg::Chunk(host.chunk(self.device, id, offset)?))),
            ClientMsg::PutChunk(chunk) => Ok(Some(HostMsg::ChunkTaken {
                next: host.take_chunk(self.device, &chunk)?,
            })),
            ClientMsg::ListCheckouts => Ok(Some(HostMsg::Checkouts(host.checkouts(self.device)?))),
            ClientMsg::CheckOut {
                record,
                person,
                take_over,
            } => Ok(Some(HostMsg::Checkouts(host.check_out(
                self.device,
                person,
                record,
                take_over,
            )?))),
            ClientMsg::Release { record, person } => {
                Ok(Some(HostMsg::Checkouts(host.release(self.device, person, record)?)))
            }
            ClientMsg::Bye => Ok(None),
            _ => refused("pairing is for the network server"),
        }
    }
}

/// What a sync did.
#[derive(Debug, Clone, Default)]
pub struct Report {
    pub pulled: usize,
    pub accepted: usize,
    /// What the host would not take, and why.
    pub refused: Vec<(Uuid, Refusal)>,
    /// Photos whose bytes all came.
    pub fetched: usize,
    /// Whether photos are still to come, for the next sync.
    pub more_photos: bool,
}

enum State {
    Greeting,
    Pulling,
    Fetching,
    Uploading,
    Pushing,
    Listing,
    Done,
}

/// The computer's side.
pub struct ClientSession {
    state: State,
    pushed: Vec<Item>,
    pushes: usize,
    report: Report,
    /// Attachments whose bytes to fetch, and from where.
    fetching: VecDeque<(Uuid, u64)>,
    fetched_bytes: u64,
    /// The bytes of attachments in the push being made, to send in pieces before it.
    uploading: VecDeque<(Uuid, Vec<u8>)>,
}

impl ClientSession {
    /// Starts a sync: the session, and the hello to send.
    pub fn start(vault: &Vault) -> Result<(ClientSession, ClientMsg)> {
        let (_, levels) = vault.sync_state()?;
        let hello = ClientMsg::Hello {
            protocol: PROTOCOL,
            device: vault.device()?,
            levels,
        };
        let session = ClientSession {
            state: State::Greeting,
            pushed: Vec::new(),
            pushes: 0,
            report: Report::default(),
            fetching: VecDeque::new(),
            fetched_bytes: 0,
            uploading: VecDeque::new(),
        };
        Ok((session, hello))
    }

    pub fn report(&self) -> &Report {
        &self.report
    }

    pub fn done(&self) -> bool {
        matches!(self.state, State::Done)
    }

    /// The next message to send, after the host's; Bye when the sync is over.
    pub fn handle(&mut self, vault: &mut Vault, message: HostMsg) -> Result<ClientMsg> {
        match (&self.state, message) {
            (_, HostMsg::Refused { reason }) => Err(Error::Protocol(reason)),
            (State::Greeting, HostMsg::Welcome(welcome)) => {
                vault.apply_welcome(&welcome)?;
                self.state = State::Pulling;
                self.pull(vault)
            }
            (State::Pulling, HostMsg::Batch(batch)) => {
                vault.apply_batch(&batch)?;
                self.report.pulled += batch.items.len();
                if batch.more {
                    return self.pull(vault);
                }
                self.fetching = vault.missing_bytes()?.into();
                self.fetch(vault)
            }
            (State::Fetching, HostMsg::Chunk(chunk)) => {
                let Some(chunk) = chunk else {
                    // The host does not have it for this computer now: perhaps next time.
                    self.fetching.pop_front();
                    return self.fetch(vault);
                };
                self.fetched_bytes += chunk.bytes.len() as u64;
                if vault.take_chunk(&chunk)? {
                    self.report.fetched += 1;
                    self.fetching.pop_front();
                } else if let Some(next) = self.fetching.front_mut() {
                    next.1 = chunk.offset + chunk.bytes.len() as u64;
                }
                self.fetch(vault)
            }
            (State::Uploading, HostMsg::ChunkTaken { next }) => {
                let done = self
                    .uploading
                    .front()
                    .is_none_or(|(_, bytes)| next >= bytes.len() as u64);
                if done {
                    self.uploading.pop_front();
                    return self.upload(0);
                }
                self.upload(next)
            }
            (State::Pushing, HostMsg::PushResult(result)) => {
                vault.apply_push_result(&result, &self.pushed)?;
                self.report.accepted += result.accepted.len();
                self.report.refused.extend(
                    result
                        .refused
                        .iter()
                        .filter(|(_, why)| !matches!(why, Refusal::BytesMissing | Refusal::DirectoryNotHeld))
                        .cloned(),
                );
                if result.accepted.is_empty() || self.pushes >= MAX_PUSHES {
                    return Ok(self.list());
                }
                self.push(vault)
            }
            (State::Listing, HostMsg::Checkouts(checkouts)) => {
                vault.set_checkouts(checkouts);
                // All pulled, and nothing left to send: the offline days start again (ADR 24).
                if vault.waiting()? == 0 {
                    vault.mark_synced()?;
                }
                self.state = State::Done;
                Ok(ClientMsg::Bye)
            }
            _ => Err(Error::Protocol("a message out of turn".into())),
        }
    }

    /// The next piece of a photo to fetch, or on to pushing once there are none, or enough came.
    fn fetch(&mut self, vault: &mut Vault) -> Result<ClientMsg> {
        match self.fetching.front() {
            Some(_) if self.fetched_bytes >= FETCH_BYTES => {
                self.report.more_photos = true;
                self.push(vault)
            }
            Some((id, offset)) => {
                self.state = State::Fetching;
                Ok(ClientMsg::GetChunk {
                    id: *id,
                    offset: *offset,
                })
            }
            None => self.push(vault),
        }
    }

    /// The next piece of the bytes to send from `offset`, or the push they go before.
    fn upload(&mut self, offset: u64) -> Result<ClientMsg> {
        let Some((id, bytes)) = self.uploading.front() else {
            self.state = State::Pushing;
            return Ok(ClientMsg::Push {
                items: self.pushed.clone(),
            });
        };
        let start = (offset as usize).min(bytes.len());
        let end = (start + CHUNK_BYTES).min(bytes.len());
        self.state = State::Uploading;
        Ok(ClientMsg::PutChunk(Chunk {
            id: *id,
            offset: start as u64,
            total: bytes.len() as u64,
            bytes: bytes[start..end].to_vec(),
        }))
    }

    fn list(&mut self) -> ClientMsg {
        self.state = State::Listing;
        ClientMsg::ListCheckouts
    }

    fn pull(&mut self, vault: &Vault) -> Result<ClientMsg> {
        let (cursors, _) = vault.sync_state()?;
        Ok(ClientMsg::Pull {
            cursors,
            max_bytes: PULL_BYTES,
        })
    }

    /// The next push, its attachments' bytes taken out of it to go first in pieces.
    fn push(&mut self, vault: &mut Vault) -> Result<ClientMsg> {
        let mut items = vault.pending(PUSH_BYTES)?;
        if items.is_empty() {
            return Ok(self.list());
        }
        self.pushes += 1;
        for item in &mut items {
            if let Item::Attachment(attachment) = item
                && !attachment.ciphertext.is_empty()
            {
                self.uploading
                    .push_back((attachment.id, std::mem::take(&mut attachment.ciphertext)));
            }
        }
        self.pushed = items;
        self.upload(0)
    }
}

/// Runs one sync between a replica and a host in this process, every message through a frame
/// and back, as the transport will carry it: for tests, and for the host computer's own app.
pub fn sync_in_process(vault: &mut Vault, host: &mut HostStore) -> Result<Report> {
    let device = vault.device()?;
    let mut host_side = HostSession::new(device);
    let (mut client, mut message) = ClientSession::start(vault)?;
    let (mut to_host, mut to_client) = (Frames::default(), Frames::default());
    loop {
        to_host.push(&frame(&message)?);
        let received: ClientMsg = to_host
            .read()?
            .ok_or_else(|| Error::Protocol("a frame cut short".into()))?;
        let Some(answer) = host_side.handle(host, received)? else {
            return Ok(client.report().clone());
        };
        to_client.push(&frame(&answer)?);
        let answer: HostMsg = to_client
            .read()?
            .ok_or_else(|| Error::Protocol("a frame cut short".into()))?;
        message = client.handle(vault, answer)?;
    }
}
