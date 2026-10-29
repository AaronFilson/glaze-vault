//! A computer's side of the network: syncing with the host it pinned, watching it for news,
//! checking records out, holding the directory while changing it, pairing to join a host, and an
//! admin's computer letting a new one in.

use super::conn::Conn;
use super::pairing::{self, EXPORTER};
use super::tls;
use crate::proto::{ClientMsg, HostMsg};
use crate::session::{ClientSession, Report};
use crate::{Error, Result};
use glaze_vault_core::Vault;
use glaze_vault_core::sync::{Checkout, DeviceInfo, DeviceKey};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use uuid::Uuid;

type Stream = TlsStream<TcpStream>;

const CONNECT: Duration = Duration::from_secs(10);
/// How long a computer waits for the host's answer; a host watched for longer than this without
/// a word has gone.
const ANSWER: Duration = Duration::from_secs(120);

/// Connects to `address` as `device`, and the key the host showed.
async fn connect(address: &str, device: &DeviceKey, pin: Option<Vec<u8>>) -> Result<(Conn<Stream>, Vec<u8>)> {
    let config = Arc::new(tls::client_config(device.seed(), pin)?);
    let tcp = timeout(CONNECT, TcpStream::connect(address))
        .await
        .map_err(|_| Error::Io(std::io::ErrorKind::TimedOut.into()))??;
    let stream = timeout(CONNECT, TlsConnector::from(config).connect(tls::server_name(), tcp))
        .await
        .map_err(|_| Error::Io(std::io::ErrorKind::TimedOut.into()))??;
    let host_key = stream
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certs| certs.first())
        .and_then(|cert| tls::key_of(cert))
        .ok_or_else(|| Error::Protocol("the host showed no key".into()))?;
    Ok((Conn::new(stream), host_key))
}

/// Connects a replica to its host, by the key it pinned when it joined.
async fn connect_replica(vault: &Vault, address: &str) -> Result<Conn<Stream>> {
    connect_pinned(&vault.device_key()?, vault.host_key()?, address).await
}

async fn connect_pinned(device: &DeviceKey, pin: Vec<u8>, address: &str) -> Result<Conn<Stream>> {
    if pin.len() != 32 {
        return Err(Error::Protocol(
            "this computer has no host key: join the vault again".into(),
        ));
    }
    Ok(connect(address, device, Some(pin)).await?.0)
}

/// The host's next message, unless it says nothing for too long.
async fn answer(conn: &mut Conn<Stream>) -> Result<HostMsg> {
    timeout(ANSWER, conn.recv())
        .await
        .map_err(|_| Error::Io(std::io::ErrorKind::TimedOut.into()))?
}

fn unexpected(message: HostMsg) -> Error {
    match message {
        HostMsg::Refused { reason } => Error::Protocol(reason),
        _ => Error::Protocol("a message out of turn".into()),
    }
}

/// Syncs a replica with its host at `address`, as sync_in_process does in one process.
pub async fn sync(vault: &mut Vault, address: &str) -> Result<Report> {
    let mut conn = connect_replica(vault, address).await?;
    let (mut session, mut message) = ClientSession::start(vault)?;
    loop {
        conn.send(&message).await?;
        if matches!(message, ClientMsg::Bye) {
            let report = session.report().clone();
            conn.close().await;
            return Ok(report);
        }
        message = session.handle(vault, conn.recv().await?)?;
    }
}

/// A vault the app uses while it syncs: the sync takes it only to handle each message, not
/// while it waits on the network, so the person can go on working.
pub trait SharedVault {
    fn with<T>(&self, work: impl FnOnce(&mut Vault) -> Result<T>) -> Result<T>;
}

/// Syncs a vault shared with the rest of the app, as `sync` does. If another vault is opened
/// meanwhile, the sync stops.
pub async fn sync_shared(vault: &impl SharedVault, address: &str) -> Result<Report> {
    let (device, pin, id) = vault.with(|v| Ok((v.device_key()?, v.host_key()?, v.device()?)))?;
    let mut conn = connect_pinned(&device, pin, address).await?;
    let (mut session, mut message) = vault.with(|v| ClientSession::start(v))?;
    loop {
        conn.send(&message).await?;
        if matches!(message, ClientMsg::Bye) {
            conn.close().await;
            return Ok(session.report().clone());
        }
        let received = answer(&mut conn).await?;
        message = vault.with(|v| {
            if v.device()? != id {
                return Err(Error::Protocol("another vault was opened during the sync".into()));
            }
            session.handle(v, received)
        })?;
    }
}

/// A connection that hears from the host when there is something new.
pub struct Watching {
    conn: Conn<Stream>,
}

/// Watches the host at `address` for news, as this computer.
pub async fn watch(device: &DeviceKey, host_key: Vec<u8>, address: &str) -> Result<Watching> {
    let mut conn = connect_pinned(device, host_key, address).await?;
    conn.send(&ClientMsg::Watch).await?;
    Ok(Watching { conn })
}

impl Watching {
    /// Waits for the host's next word: news, or that it is still there.
    pub async fn next(&mut self) -> Result<()> {
        match answer(&mut self.conn).await? {
            HostMsg::News => Ok(()),
            other => Err(unexpected(other)),
        }
    }
}

/// The directory, held by this computer until this is let go: while it is, no other computer
/// changes people, roles or collections (the plan's question 5).
pub struct DirectoryHeld {
    conn: Conn<Stream>,
}

/// Waits until no other computer is changing the directory, and holds it.
pub async fn hold_directory(vault: &Vault, address: &str) -> Result<DirectoryHeld> {
    let mut conn = connect_replica(vault, address).await?;
    conn.send(&ClientMsg::LockDirectory).await?;
    match answer(&mut conn).await? {
        HostMsg::DirectoryLocked => Ok(DirectoryHeld { conn }),
        other => Err(unexpected(other)),
    }
}

impl DirectoryHeld {
    pub async fn release(mut self) {
        let _ = self.conn.send(&ClientMsg::Bye).await;
        self.conn.close().await;
    }
}

/// Asks the host one thing about checkouts, on a connection of its own.
async fn ask_checkouts(vault: &Vault, address: &str, message: ClientMsg) -> Result<Vec<Checkout>> {
    let mut conn = greeted(vault, address).await?;
    conn.send(&message).await?;
    let answered = answer(&mut conn).await;
    let _ = conn.send(&ClientMsg::Bye).await;
    conn.close().await;
    match answered? {
        HostMsg::Checkouts(checkouts) => Ok(checkouts),
        other => Err(unexpected(other)),
    }
}

/// Checks a record out for the person signed in, or takes it over; who has what after.
pub async fn check_out(vault: &Vault, address: &str, record: Uuid, take_over: bool) -> Result<Vec<Checkout>> {
    let person = vault.me().id;
    ask_checkouts(
        vault,
        address,
        ClientMsg::CheckOut {
            record,
            person,
            take_over,
        },
    )
    .await
}

pub async fn release(vault: &Vault, address: &str, record: Uuid) -> Result<Vec<Checkout>> {
    let person = vault.me().id;
    ask_checkouts(vault, address, ClientMsg::Release { record, person }).await
}

/// The computers that sync with the host, for an admin's computer.
pub async fn devices(vault: &Vault, address: &str) -> Result<Vec<DeviceInfo>> {
    let mut conn = greeted(vault, address).await?;
    conn.send(&ClientMsg::ListDevices).await?;
    let answer = conn.recv().await?;
    let _ = conn.send(&ClientMsg::Bye).await;
    conn.close().await;
    match answer {
        HostMsg::Devices(devices) => Ok(devices),
        other => Err(unexpected(other)),
    }
}

/// A replica's connection, past hello.
async fn greeted(vault: &Vault, address: &str) -> Result<Conn<Stream>> {
    let mut conn = connect_replica(vault, address).await?;
    let (_, hello) = ClientSession::start(vault)?;
    conn.send(&hello).await?;
    match conn.recv().await? {
        HostMsg::Welcome(_) => Ok(conn),
        other => Err(unexpected(other)),
    }
}

/// Joins the vault served at `address` with a pairing code an admin read out, as a replica in
/// `dir`, named `name` for the admin to see, with the key this computer made to join. Waits
/// until the admin approves it.
pub async fn pair(address: &str, code: &str, name: &str, dir: &Path, device: &DeviceKey) -> Result<()> {
    if Vault::exists(dir) {
        return Err(glaze_vault_core::Error::VaultExists.into());
    }
    let (mut conn, host_key) = connect(address, device, None).await?;
    let exporter = pairing::exported(
        conn.stream()
            .get_ref()
            .1
            .export_keying_material([0u8; 32], EXPORTER, None),
    )?;
    let (spake, message) = pairing::start_device(code);
    conn.send(&ClientMsg::Pair { spake: message }).await?;
    let theirs = match conn.recv().await? {
        HostMsg::PairChallenge { spake } => spake,
        other => return Err(pairing_error(other)),
    };
    let shared = pairing::finish(spake, &theirs)?;
    conn.send(&ClientMsg::PairConfirm {
        mac: pairing::confirmation(&shared, &exporter, false),
        device: device.id,
        name: name.to_owned(),
    })
    .await?;
    match conn.recv().await? {
        HostMsg::PairConfirmed { mac } if pairing::confirms(&shared, &exporter, true, &mac) => {}
        HostMsg::PairConfirmed { .. } => {
            return Err(Error::Pairing("the host did not prove it had the code".into()));
        }
        other => return Err(pairing_error(other)),
    }
    let package = match conn.recv().await? {
        HostMsg::Joined(package) => package,
        other => return Err(pairing_error(other)),
    };
    conn.close().await;
    if package.host_key != host_key {
        return Err(Error::Pairing("the host sent another host's key".into()));
    }
    Vault::join(dir, &package, device)?;
    Ok(())
}

fn pairing_error(message: HostMsg) -> Error {
    match message {
        HostMsg::Refused { reason } => Error::Pairing(reason),
        _ => Error::Protocol("a message out of turn".into()),
    }
}

/// A computer that used the code, for the admin to check before approving.
#[derive(Debug, Clone)]
pub struct Finished {
    pub device: Uuid,
    pub name: String,
    pub signing_key: Vec<u8>,
}

impl Finished {
    /// To compare with what the new computer shows.
    pub fn fingerprint(&self) -> String {
        pairing::fingerprint(&self.signing_key)
    }
}

/// A pairing an admin's computer started: the code to read out, then the computer that used it.
pub struct AdminPairing {
    conn: Conn<Stream>,
    pub code: String,
    pub expires_at: i64,
}

impl AdminPairing {
    pub async fn start(vault: &Vault, address: &str) -> Result<AdminPairing> {
        let mut conn = greeted(vault, address).await?;
        conn.send(&ClientMsg::StartPairing).await?;
        match conn.recv().await? {
            HostMsg::PairingCode { code, expires_at } => Ok(AdminPairing { conn, code, expires_at }),
            other => Err(unexpected(other)),
        }
    }

    /// Waits until a computer uses the code, or it runs out.
    pub async fn wait(&mut self) -> Result<Finished> {
        self.conn.send(&ClientMsg::AwaitPairing).await?;
        match self.conn.recv().await? {
            HostMsg::PairingFinished {
                device,
                name,
                signing_key,
            } => Ok(Finished {
                device,
                name,
                signing_key,
            }),
            other => Err(pairing_error(other)),
        }
    }

    /// Lets the computer in, for `people`, with the organization's signature.
    pub async fn approve(mut self, vault: &Vault, finished: &Finished, people: &[Uuid]) -> Result<()> {
        let certificate = vault.certify_device(finished.device, &finished.name, &finished.signing_key, people)?;
        self.conn.send(&ClientMsg::ApproveDevice { certificate }).await?;
        let answer = self.conn.recv().await?;
        let _ = self.conn.send(&ClientMsg::Bye).await;
        self.conn.close().await;
        match answer {
            HostMsg::Approved => Ok(()),
            other => Err(pairing_error(other)),
        }
    }
}
