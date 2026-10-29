//! Client mode's background sync (docs/adr/0023-client-mode.md): while a vault that syncs with a
//! host is unlocked, a thread of its own syncs it soon after something is saved, when the host
//! says there is news, and every half minute anyway, and tells the page what came and how the
//! sync stands. The vault is taken only while each message is handled, so the person goes on
//! working meanwhile.

use crate::AppState;
use glaze_vault_core::Vault;
use glaze_vault_sync::net::{self, SharedVault};
use glaze_vault_sync::{Error, Report, Result};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

/// How often the thread looks at whether to sync.
const TICK: Duration = Duration::from_secs(5);
/// How long it goes without syncing at all.
const EVERY: Duration = Duration::from_secs(30);
/// How long it waits after a sync failed before trying again for something saved.
const AFTER_FAILING: Duration = Duration::from_secs(15);
/// How long finding the host by its name on the network may take.
const BROWSE: Duration = Duration::from_secs(3);

/// How syncing stands, for the page's indicator.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// Whether this vault syncs with a host at all.
    pub replica: bool,
    pub syncing: bool,
    /// When the last sync worked, in ms since the epoch.
    pub last_synced: Option<i64>,
    /// Why the last one did not, if it did not.
    pub error: Option<String>,
    /// Whether this computer hears from the host now.
    pub watching: bool,
    /// What was saved here and has not reached the host yet.
    pub waiting: usize,
    /// What the host would not take.
    pub refused: usize,
    /// Photos whose bytes have not come yet.
    pub photos_waiting: usize,
}

/// What the page is told when a sync brought something.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultChanged {
    pub pulled: usize,
    pub fetched: usize,
}

#[derive(Default)]
pub struct Syncing {
    poke: Notify,
    status: Mutex<SyncStatus>,
    /// One sync at a time, whoever asks for it.
    running: tokio::sync::Mutex<()>,
}

/// The vault as the sync takes it, a message at a time.
struct AppVault<'a>(&'a Mutex<Option<Vault>>);

impl SharedVault for AppVault<'_> {
    fn with<T>(&self, work: impl FnOnce(&mut Vault) -> Result<T>) -> Result<T> {
        let mut vault = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match vault.as_mut() {
            Some(vault) => work(vault),
            None => Err(Error::Protocol("the vault was locked during the sync".into())),
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

impl Syncing {
    pub fn status(&self) -> SyncStatus {
        self.status.lock().unwrap().clone()
    }

    /// Syncs soon, as after a save or when the host has news.
    pub fn poke(&self) {
        self.poke.notify_one();
    }

    /// Changes the status, and tells the page if that changed anything.
    fn update(&self, app: &AppHandle, change: impl FnOnce(&mut SyncStatus)) {
        let changed = {
            let mut status = self.status.lock().unwrap();
            let before = status.clone();
            change(&mut status);
            (*status != before).then(|| status.clone())
        };
        if let Some(status) = changed {
            let _ = app.emit("sync-status", status);
        }
    }

    /// Reads what the vault has waiting into the status.
    fn count(&self, app: &AppHandle) -> Option<String> {
        let state = app.state::<AppState>();
        let vault = state.vault.lock().unwrap();
        let (replica, address, waiting, refused, photos) = match vault.as_ref() {
            Some(v) if v.is_replica() => (
                true,
                v.host_address().ok().flatten(),
                v.waiting().unwrap_or(0),
                v.refused().map_or(0, |r| r.len()),
                v.missing_bytes().map_or(0, |m| m.len()),
            ),
            _ => (false, None, 0, 0, 0),
        };
        drop(vault);
        self.update(app, |s| {
            s.replica = replica;
            s.waiting = waiting;
            s.refused = refused;
            s.photos_waiting = photos;
        });
        address
    }

    /// Syncs once, now, unless a sync is running already, in which case it waits for that one and
    /// syncs again. Tells the page what came.
    pub async fn sync(&self, app: &AppHandle) -> Result<Report> {
        let _running = self.running.lock().await;
        let Some(address) = self.count(app) else {
            return Err(Error::Protocol("this vault has no host".into()));
        };
        self.update(app, |s| s.syncing = true);
        let state = app.state::<AppState>();
        let mut synced = net::sync_shared(&AppVault(&state.vault), &address).await;
        // The host's address may have changed: look for it on the network by its vault's tag.
        if matches!(synced, Err(Error::Io(_)))
            && let Some(found) = self.find_host(app, &address)
        {
            synced = net::sync_shared(&AppVault(&state.vault), &found).await;
        }
        self.update(app, |s| {
            s.syncing = false;
            match &synced {
                Ok(_) => {
                    s.last_synced = Some(now_ms());
                    s.error = None;
                }
                Err(e) => s.error = Some(e.to_string()),
            }
        });
        self.count(app);
        if let Ok(report) = &synced
            && (report.pulled > 0 || report.fetched > 0)
        {
            let _ = app.emit(
                "vault-changed",
                VaultChanged {
                    pulled: report.pulled,
                    fetched: report.fetched,
                },
            );
        }
        synced
    }

    /// The host advertising this vault's tag, at an address other than `tried`, kept as the
    /// replica's host address if the sync that follows can use it.
    fn find_host(&self, app: &AppHandle, tried: &str) -> Option<String> {
        let state = app.state::<AppState>();
        let tag = {
            let vault = state.vault.lock().unwrap();
            net::vault_tag(&vault.as_ref()?.organization_signing_key()?)
        };
        // A host on this computer is found by its loopback address, never moved.
        if tried.starts_with("127.0.0.1:") {
            return None;
        }
        let found = net::browse(BROWSE).ok()?;
        let host = found.iter().find(|f| f.vault.as_deref() == Some(tag.as_str()))?;
        let ip = host.addresses.iter().find(|a| a.is_ipv4()).or(host.addresses.first())?;
        let address = match ip {
            std::net::IpAddr::V6(ip) => format!("[{ip}]:{}", host.port),
            ip => format!("{ip}:{}", host.port),
        };
        if address == tried {
            return None;
        }
        let mut vault = state.vault.lock().unwrap();
        vault.as_mut()?.set_host_address(&address).ok()?;
        Some(address)
    }
}

/// Starts the thread that syncs in the background, for as long as the app runs.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("the sync thread's runtime");
        runtime.block_on(async {
            tokio::join!(syncing(&app), watching(&app));
        });
    });
}

/// Syncs when poked, when something saved here waits, and every half minute.
async fn syncing(app: &AppHandle) {
    let syncing = app.state::<Arc<Syncing>>().inner().clone();
    let mut last: Option<(Instant, bool)> = None;
    // What was still waiting after the last sync: the host would not take it yet, so only time
    // brings it back.
    let mut stuck = 0;
    loop {
        let poked = tokio::select! {
            _ = syncing.poke.notified() => true,
            _ = tokio::time::sleep(TICK) => false,
        };
        if syncing.count(app).is_none() {
            last = None;
            continue;
        }
        let status = syncing.status();
        let since = last.map_or(Duration::MAX, |(at, _)| at.elapsed());
        let failed = last.is_some_and(|(_, ok)| !ok);
        let saved = status.waiting > 0 && status.waiting != stuck;
        let due = since >= EVERY
            || (poked || saved || status.photos_waiting > 0 && !failed) && (!failed || since >= AFTER_FAILING);
        if !due {
            continue;
        }
        let synced = syncing.sync(app).await;
        last = Some((Instant::now(), synced.is_ok()));
        stuck = syncing.status().waiting;
        if synced.is_ok_and(|report| report.more_photos) {
            syncing.poke();
        }
    }
}

/// Keeps a connection to the host that says when there is news, and syncs when it does.
async fn watching(app: &AppHandle) {
    let syncing = app.state::<Arc<Syncing>>().inner().clone();
    loop {
        let state = app.state::<AppState>();
        let watched = {
            let vault = state.vault.lock().unwrap();
            match vault.as_ref() {
                Some(v) if v.is_replica() => {
                    (|| Some((v.device_key().ok()?, v.host_key().ok()?, v.host_address().ok()??)))()
                }
                _ => None,
            }
        };
        let Some((device, pin, address)) = watched else {
            tokio::time::sleep(TICK).await;
            continue;
        };
        let id = device.id;
        let Ok(mut watch) = net::watch(&device, pin, &address).await else {
            tokio::time::sleep(AFTER_FAILING).await;
            continue;
        };
        syncing.update(app, |s| s.watching = true);
        // The connection ends when the host goes, or this vault is locked or replaced.
        while watch.next().await.is_ok() {
            let same = {
                let vault = state.vault.lock().unwrap();
                vault.as_ref().and_then(|v| v.device().ok()) == Some(id)
            };
            if !same {
                break;
            }
            syncing.poke();
        }
        syncing.update(app, |s| s.watching = false);
        tokio::time::sleep(TICK).await;
    }
}
