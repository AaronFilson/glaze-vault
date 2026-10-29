//! The host's server: TLS connections from computers, each a sync session, a step of pairing, a
//! computer watching for news, or an admin's computer holding the directory while it changes it.
//! The store is shared between connections behind a lock, held only while a message is handled.

use super::conn::Conn;
use super::pairing::{self, CODE_LIFETIME, EXPORTER};
use super::tls;
use crate::proto::{ClientMsg, HostMsg};
use crate::session::HostSession;
use crate::{Error, Result};
use glaze_vault_core::HostStore;
use glaze_vault_core::sync::{DeviceCertificate, JoinPackage};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::time::timeout;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;
use uuid::Uuid;
use zeroize::Zeroizing;

/// How long a computer may take over its TLS handshake.
const HANDSHAKE: Duration = Duration::from_secs(15);
/// How long a connection may be quiet between messages, except while it waits on pairing.
const IDLE: Duration = Duration::from_secs(120);
/// How often a watching computer hears from the host when nothing changes.
const KEEPALIVE: Duration = Duration::from_secs(50);
/// How long a computer waits for another to finish changing the directory.
const DIRECTORY_WAIT: Duration = Duration::from_secs(30);

pub struct Server {
    host: Mutex<HostStore>,
    identity: Zeroizing<[u8; 32]>,
    /// The one pairing open at a time, if any.
    pairing: Mutex<Option<Pairing>>,
    /// Ticks whenever the pairing changes, for those waiting on it.
    changed: watch::Sender<()>,
    /// Ticks whenever a computer pushes or checks something out, for those watching.
    news: watch::Sender<()>,
    /// Held by the one computer changing people, roles or collections (the plan's question 5).
    directory: Arc<tokio::sync::Mutex<()>>,
}

struct Pairing {
    code: String,
    expires: Instant,
    /// The admin's computer that asked for it.
    admin: Uuid,
    stage: Stage,
}

enum Stage {
    Open,
    /// A computer is trying the code: the one attempt.
    Trying,
    Finished {
        device: Uuid,
        name: String,
        key: Vec<u8>,
        /// For extension codes, kept once the computer is approved.
        secret: Vec<u8>,
    },
    Approved(Box<JoinPackage>),
    Failed(String),
}

/// The directory, held by one connection: let go when it ends.
struct Holding {
    server: Arc<Server>,
    _lock: tokio::sync::OwnedMutexGuard<()>,
}

impl Drop for Holding {
    fn drop(&mut self) {
        self.server.host().set_directory_holder(None);
    }
}

fn refused(reason: impl Into<String>) -> HostMsg {
    HostMsg::Refused { reason: reason.into() }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

impl Server {
    pub fn new(mut host: HostStore) -> Arc<Server> {
        // Over the network, directory changes come only from the computer holding it.
        host.guard_directory();
        let identity = Zeroizing::new(**host.identity_seed());
        Arc::new(Server {
            host: Mutex::new(host),
            identity,
            pairing: Mutex::new(None),
            changed: watch::Sender::new(()),
            news: watch::Sender::new(()),
            directory: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    /// The store, for what runs beside the server.
    pub fn host(&self) -> MutexGuard<'_, HostStore> {
        self.host.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn pairing(&self) -> MutexGuard<'_, Option<Pairing>> {
        self.pairing.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_stage(&self, stage: Stage) {
        if let Some(pairing) = self.pairing().as_mut() {
            pairing.stage = stage;
        }
        self.changed.send_replace(());
    }

    /// Waits until `ready` gives an answer from the pairing, or it runs out.
    async fn wait<T>(&self, ready: impl Fn(&mut Option<Pairing>) -> Option<T>, ran_out: T) -> T {
        loop {
            let mut changed = self.changed.subscribe();
            {
                let mut pairing = self.pairing();
                if let Some(answer) = ready(&mut pairing) {
                    return answer;
                }
                if pairing.as_ref().is_none_or(|p| Instant::now() >= p.expires) {
                    *pairing = None;
                    return ran_out;
                }
            }
            let _ = timeout(Duration::from_secs(1), changed.changed()).await;
        }
    }

    async fn connection(self: Arc<Server>, stream: TlsStream<TcpStream>) -> Result<()> {
        let tls = stream.get_ref().1;
        let key = tls
            .peer_certificates()
            .and_then(|certs| certs.first())
            .and_then(|cert| tls::key_of(cert))
            .ok_or_else(|| Error::Protocol("no key was shown".into()))?;
        let exporter = pairing::exported(tls.export_keying_material([0u8; 32], EXPORTER, None))?;
        let device = self.host().device_with_key(&key)?;
        let mut session = device.map(HostSession::new);
        let mut conn = Conn::new(stream);
        let mut spake = None;
        // The directory, while this computer holds it; let go when the connection ends.
        let mut _directory = None;
        let outcome = loop {
            let message = match timeout(IDLE, conn.recv::<ClientMsg>()).await {
                Err(_) => break Ok(()),
                Ok(Err(Error::Closed)) => break Ok(()),
                Ok(message) => message?,
            };
            let answer = match message {
                ClientMsg::Pair { spake: theirs } => match self.claim() {
                    Ok(code) => {
                        let (ours, message) = pairing::start_host(&code);
                        spake = Some((ours, theirs));
                        HostMsg::PairChallenge { spake: message }
                    }
                    Err(reason) => refused(reason),
                },
                ClientMsg::PairConfirm { mac, device, name } => {
                    let Some((ours, theirs)) = spake.take() else {
                        break Err(Error::Protocol("a confirmation before pairing".into()));
                    };
                    let answer = self.confirm(ours, &theirs, &exporter, &mac, device, name, &key);
                    let joining = matches!(answer, HostMsg::PairConfirmed { .. });
                    conn.send(&answer).await?;
                    if joining {
                        let joined = self.wait_approved(device).await;
                        conn.send(&joined).await?;
                    }
                    break Ok(());
                }
                ClientMsg::Watch => {
                    if session.is_none() {
                        conn.send(&refused("this computer is not paired with the host")).await?;
                        break Ok(());
                    }
                    break self.watch(&mut conn).await;
                }
                ClientMsg::LockDirectory => {
                    if session.is_none() {
                        refused("this computer is not paired with the host")
                    } else {
                        match timeout(DIRECTORY_WAIT, self.directory.clone().lock_owned()).await {
                            Ok(held) => {
                                let device = session.as_ref().map(HostSession::device);
                                self.host().set_directory_holder(device);
                                _directory = Some(Holding {
                                    server: self.clone(),
                                    _lock: held,
                                });
                                HostMsg::DirectoryLocked
                            }
                            Err(_) => refused("someone else is changing the team: try again in a moment"),
                        }
                    }
                }
                ClientMsg::StartPairing => self.start_pairing(session.as_ref()),
                ClientMsg::AwaitPairing => self.await_pairing(session.as_ref()).await,
                ClientMsg::ApproveDevice { certificate } => self.approve(session.as_ref(), &certificate),
                ClientMsg::ExtensionCode { device, days } => match self.admin(session.as_ref()) {
                    None => refused("only an admin's computer gives extension codes"),
                    Some(_) => {
                        let code = self.host().extension_code(device, days);
                        match code {
                            Ok(code) => HostMsg::ExtensionCode { code },
                            Err(e) => refused(e.to_string()),
                        }
                    }
                },
                ClientMsg::RevokeDevice { device, lost } => match self.admin(session.as_ref()) {
                    None => refused("only an admin's computer revokes computers"),
                    Some(admin) if admin == device => refused("a computer cannot revoke itself"),
                    Some(_) => {
                        let revoked = {
                            let mut host = self.host();
                            host.revoke_device(device, lost).and_then(|_| host.devices())
                        };
                        match revoked {
                            Ok(devices) => {
                                self.news.send_replace(());
                                HostMsg::Devices(devices)
                            }
                            Err(e) => refused(e.to_string()),
                        }
                    }
                },
                ClientMsg::ListDevices => match self.admin(session.as_ref()) {
                    None => refused("only an admin's computer lists computers"),
                    Some(_) => {
                        let devices = self.host().devices();
                        match devices {
                            Ok(devices) => HostMsg::Devices(devices),
                            Err(e) => refused(e.to_string()),
                        }
                    }
                },
                message => {
                    let Some(session) = session.as_mut() else {
                        conn.send(&refused("this computer is not paired with the host")).await?;
                        break Ok(());
                    };
                    let news = matches!(
                        message,
                        ClientMsg::Push { .. } | ClientMsg::CheckOut { .. } | ClientMsg::Release { .. }
                    );
                    let handled = session.handle(&mut self.host(), message);
                    if news && handled.is_ok() {
                        self.news.send_replace(());
                    }
                    match handled {
                        Ok(Some(answer)) => answer,
                        Ok(None) => break Ok(()),
                        Err(e) => {
                            conn.send(&refused(e.to_string())).await?;
                            break Err(e);
                        }
                    }
                }
            };
            let end = matches!(answer, HostMsg::Refused { .. });
            conn.send(&answer).await?;
            if end {
                break Ok(());
            }
        };
        if spake.is_some() {
            self.set_stage(Stage::Failed(
                "the computer went away before it confirmed the code".into(),
            ));
        }
        conn.close().await;
        outcome
    }

    /// Tells a watching computer whenever something changes, and every so often anyway, until it
    /// says goodbye or goes.
    async fn watch(&self, conn: &mut Conn<TlsStream<TcpStream>>) -> Result<()> {
        let mut news = self.news.subscribe();
        news.mark_unchanged();
        loop {
            tokio::select! {
                changed = news.changed() => {
                    if changed.is_err() {
                        return Ok(());
                    }
                }
                _ = tokio::time::sleep(KEEPALIVE) => {}
                said = conn.recv::<ClientMsg>() => {
                    return match said {
                        Ok(ClientMsg::Bye) | Err(Error::Closed) => Ok(()),
                        Ok(_) => Err(Error::Protocol("a message while watching".into())),
                        Err(e) => Err(e),
                    };
                }
            }
            conn.send(&HostMsg::News).await?;
        }
    }

    /// Takes the code's one attempt.
    fn claim(&self) -> std::result::Result<String, &'static str> {
        let mut pairing = self.pairing();
        let Some(open) = pairing.as_mut() else {
            return Err("no pairing is open: an admin starts one");
        };
        if Instant::now() >= open.expires {
            *pairing = None;
            return Err("the pairing code ran out");
        }
        if !matches!(open.stage, Stage::Open) {
            return Err("the pairing code was used already");
        }
        open.stage = Stage::Trying;
        Ok(open.code.clone())
    }

    #[allow(clippy::too_many_arguments)]
    fn confirm(
        &self,
        ours: spake2::Spake2<spake2::Ed25519Group>,
        theirs: &[u8],
        exporter: &[u8; 32],
        mac: &[u8],
        device: Uuid,
        name: String,
        key: &[u8],
    ) -> HostMsg {
        let shared = match pairing::finish(ours, theirs) {
            Ok(shared) => shared,
            Err(e) => {
                self.set_stage(Stage::Failed(e.to_string()));
                return refused(e.to_string());
            }
        };
        if !pairing::confirms(&shared, exporter, false, mac) {
            // One attempt: a wrong code ends the pairing, so a code cannot be guessed online.
            self.set_stage(Stage::Failed("the code was wrong".into()));
            return refused("the code was wrong: the admin must start again");
        }
        match self.host().device_with_key(key) {
            Ok(None) => {}
            _ => {
                self.set_stage(Stage::Failed("the computer is paired already".into()));
                return refused("this computer is paired already");
            }
        }
        self.set_stage(Stage::Finished {
            device,
            name,
            key: key.to_vec(),
            secret: pairing::offline_secret(&shared),
        });
        HostMsg::PairConfirmed {
            mac: pairing::confirmation(&shared, exporter, true),
        }
    }

    async fn wait_approved(&self, device: Uuid) -> HostMsg {
        self.wait(
            |pairing| match pairing.as_ref().map(|p| &p.stage) {
                Some(Stage::Approved(package)) if package.device.device == device => {
                    let package = package.clone();
                    *pairing = None;
                    Some(HostMsg::Joined(package))
                }
                Some(Stage::Failed(reason)) => {
                    let reason = reason.clone();
                    *pairing = None;
                    Some(refused(reason))
                }
                _ => None,
            },
            refused("the admin did not approve the computer in time"),
        )
        .await
    }

    /// The admin's computer, if this connection is one.
    fn admin(&self, session: Option<&HostSession>) -> Option<Uuid> {
        let device = session?.device();
        self.host().is_admin_device(device).ok()?.then_some(device)
    }

    fn start_pairing(&self, session: Option<&HostSession>) -> HostMsg {
        let Some(admin) = self.admin(session) else {
            return refused("only an admin's computer can pair another");
        };
        let code = pairing::new_code();
        *self.pairing() = Some(Pairing {
            code: code.clone(),
            expires: Instant::now() + CODE_LIFETIME,
            admin,
            stage: Stage::Open,
        });
        self.changed.send_replace(());
        HostMsg::PairingCode {
            code,
            expires_at: now_ms() + CODE_LIFETIME.as_millis() as i64,
        }
    }

    async fn await_pairing(&self, session: Option<&HostSession>) -> HostMsg {
        let Some(admin) = self.admin(session) else {
            return refused("only an admin's computer can pair another");
        };
        self.wait(
            |pairing| match pairing.as_ref() {
                Some(p) if p.admin != admin => Some(refused("another admin started a pairing since")),
                Some(Pairing {
                    stage: Stage::Finished { device, name, key, .. },
                    ..
                }) => Some(HostMsg::PairingFinished {
                    device: *device,
                    name: name.clone(),
                    signing_key: key.clone(),
                }),
                Some(Pairing {
                    stage: Stage::Failed(reason),
                    ..
                }) => {
                    let reason = reason.clone();
                    *pairing = None;
                    Some(refused(reason))
                }
                _ => None,
            },
            refused("no computer used the code in time"),
        )
        .await
    }

    fn approve(&self, session: Option<&HostSession>, certificate: &DeviceCertificate) -> HostMsg {
        let Some(admin) = self.admin(session) else {
            return refused("only an admin's computer can pair another");
        };
        let secret = match self.pairing().as_ref() {
            Some(Pairing {
                admin: started,
                stage: Stage::Finished {
                    device, key, secret, ..
                },
                ..
            }) if *started == admin && *device == certificate.device && *key == certificate.signing_key => {
                secret.clone()
            }
            _ => return refused("the certificate is not for the computer waiting to pair"),
        };
        let package = {
            let mut host = self.host();
            host.add_device(certificate)
                .and_then(|()| host.set_offline_secret(certificate.device, &secret))
                .and_then(|()| host.join_package(certificate.device))
        };
        match package {
            Ok(package) => {
                self.set_stage(Stage::Approved(Box::new(package)));
                self.news.send_replace(());
                HostMsg::Approved
            }
            Err(e) => refused(e.to_string()),
        }
    }
}

/// Serves computers on `listener` until it fails.
pub async fn serve(listener: TcpListener, server: Arc<Server>) -> Result<()> {
    let acceptor = TlsAcceptor::from(Arc::new(tls::server_config(&server.identity)?));
    loop {
        let (tcp, peer) = listener.accept().await?;
        let (acceptor, server) = (acceptor.clone(), server.clone());
        tokio::spawn(async move {
            match timeout(HANDSHAKE, acceptor.accept(tcp)).await {
                Ok(Ok(stream)) => {
                    if let Err(e) = server.connection(stream).await {
                        log::info!("{peer}: {e}");
                    }
                }
                Ok(Err(e)) => log::info!("{peer}: the TLS handshake failed: {e}"),
                Err(_) => log::info!("{peer}: the TLS handshake took too long"),
            }
        });
    }
}
