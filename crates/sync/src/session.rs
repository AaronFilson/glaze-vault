//! The two sides of one sync (plan section 3.8): the computer says hello, pulls until it has
//! everything after its cursors, then pushes what was saved on it. Each side takes the other's
//! message and gives its next one; neither does any IO.

use crate::proto::{ClientMsg, Frames, HostMsg, PROTOCOL, frame};
use crate::{Error, Result};
use glaze_vault_core::sync::{Item, Refusal};
use glaze_vault_core::{HostStore, Vault};
use uuid::Uuid;

/// About how much one batch of a pull holds.
const PULL_BYTES: u32 = 4 * 1024 * 1024;
/// About how much one push holds.
const PUSH_BYTES: usize = 4 * 1024 * 1024;
/// How many pushes one sync makes at most: more waits for the next sync.
const MAX_PUSHES: usize = 8;

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
}

enum State {
    Greeting,
    Pulling,
    Pushing,
    Done,
}

/// The computer's side.
pub struct ClientSession {
    state: State,
    pushed: Vec<Item>,
    pushes: usize,
    report: Report,
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
                if batch.more { self.pull(vault) } else { self.push(vault) }
            }
            (State::Pushing, HostMsg::PushResult(result)) => {
                vault.apply_push_result(&result, &self.pushed)?;
                self.report.accepted += result.accepted.len();
                self.report.refused.extend(result.refused.iter().cloned());
                if result.accepted.is_empty() || self.pushes >= MAX_PUSHES {
                    self.state = State::Done;
                    return Ok(ClientMsg::Bye);
                }
                self.push(vault)
            }
            _ => Err(Error::Protocol("a message out of turn".into())),
        }
    }

    fn pull(&mut self, vault: &Vault) -> Result<ClientMsg> {
        let (cursors, _) = vault.sync_state()?;
        Ok(ClientMsg::Pull {
            cursors,
            max_bytes: PULL_BYTES,
        })
    }

    fn push(&mut self, vault: &mut Vault) -> Result<ClientMsg> {
        let items = vault.pending(PUSH_BYTES)?;
        if items.is_empty() {
            self.state = State::Done;
            return Ok(ClientMsg::Bye);
        }
        self.state = State::Pushing;
        self.pushes += 1;
        self.pushed = items.clone();
        Ok(ClientMsg::Push { items })
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
