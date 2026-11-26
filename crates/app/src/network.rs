//! The network in the app. Host mode (`hosting`), pairing (`pairing`), client joining/leaving
//! (`joining`), and checkouts, offline rules, revocation & remote host backups (`admin`).

pub(crate) mod admin;
pub(crate) mod hosting;
pub(crate) mod joining;
pub(crate) mod pairing;

use crate::syncing::{SyncStatus, Syncing};
use crate::{AppState, CommandError, CommandResult, locked};
use glaze_vault_core::sync::{DeviceInfo, DeviceKey};
use glaze_vault_core::{Error, Vault};
use glaze_vault_sync::net::{self, AdminPairing, DEFAULT_PORT, Finished};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Child;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};
use uuid::Uuid;

/// What the network keeps between commands.
#[derive(Default)]
pub struct Network {
    /// A pairing this admin started, and the computer that used its code, once one has.
    pub(super) pairing: Mutex<Option<(AdminPairing, Option<Finished>)>>,
    /// Counts pairings started and cancelled, so a wait for one that was cancelled, or replaced,
    /// stops and does not put it back.
    pub(super) pairings: std::sync::atomic::AtomicU64,
    pub(super) cancelled: tokio::sync::Notify,
    /// hostd as a child process, in development with GLAZE_VAULT_HOST_NO_SERVICE.
    pub(super) child: Mutex<Option<Child>>,
    /// The key this computer made to join a vault, shown to the admin as a fingerprint.
    pub(super) joining: Mutex<Option<DeviceKey>>,
}

impl Drop for Network {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.get_mut().ok().and_then(Option::take) {
            let _ = child.kill();
        }
    }
}

impl Network {
    /// Ends a wait for a pairing, if one is running.
    pub(super) fn cancel(&self) {
        self.pairings.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.cancelled.notify_waiters();
    }
}

pub(super) fn network_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("network", error.to_string())
}

/// Runs network work to its end on a thread of its own, outside the command's runtime, on a
/// runtime kept for the network, for connections that outlive one command (a pairing).
pub(super) fn on_network<T: Send, F: Future<Output = T>>(work: impl FnOnce() -> F + Send) -> T {
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    let runtime = RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("network")
            .enable_all()
            .build()
            .expect("a runtime for the network")
    });
    std::thread::scope(|scope| {
        scope
            .spawn(|| runtime.block_on(work()))
            .join()
            .expect("the network thread")
    })
}

/// Where hostd is: beside the app, as the installer puts its sidecar, or GLAZE_VAULT_HOSTD.
#[cfg(desktop)]
pub(crate) fn hostd() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("GLAZE_VAULT_HOSTD") {
        return Some(PathBuf::from(path));
    }
    let path = std::env::current_exe()
        .ok()?
        .with_file_name(format!("hostd{}", std::env::consts::EXE_SUFFIX));
    path.is_file().then_some(path)
}

#[cfg(mobile)]
pub(crate) fn hostd() -> Option<PathBuf> {
    None
}

pub(super) fn no_service() -> bool {
    std::env::var_os("GLAZE_VAULT_HOST_NO_SERVICE").is_some()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    replica: bool,
    host_here: bool,
    host_address: Option<String>,
    can_host: bool,
    default_port: u16,
    device: Option<Uuid>,
    host_moved_here: bool,
    host_retired: bool,
}

#[tauri::command(async)]
pub fn network_status(state: State<AppState>) -> CommandResult<NetworkStatus> {
    let vault = state.vault.lock().unwrap();
    let vault = vault.as_ref().ok_or_else(locked)?;
    let host_address = vault.host_address()?;
    Ok(NetworkStatus {
        replica: vault.is_replica(),
        host_here: host_address.as_deref().is_some_and(|a| a.starts_with("127.0.0.1:")),
        host_address,
        can_host: hostd().is_some(),
        default_port: DEFAULT_PORT,
        device: vault.device().ok(),
        host_moved_here: vault.host_moved_here(),
        host_retired: vault.host_retired(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pulled: usize,
    accepted: usize,
    refused: usize,
}

impl From<glaze_vault_sync::Report> for SyncReport {
    fn from(report: glaze_vault_sync::Report) -> Self {
        SyncReport {
            pulled: report.pulled + report.fetched,
            accepted: report.accepted,
            refused: report.refused.len(),
        }
    }
}

pub(super) fn sync(vault: &mut Vault) -> CommandResult<SyncReport> {
    let address = vault
        .host_address()?
        .ok_or_else(|| network_error("This vault has no host."))?;
    let report = on_network(move || async move { net::sync(vault, &address).await }).map_err(network_error)?;
    Ok(report.into())
}

#[tauri::command(async)]
pub fn sync_now(app: AppHandle, syncing: State<Arc<Syncing>>) -> CommandResult<SyncReport> {
    let syncing = syncing.inner().clone();
    let report = on_network(|| async move { syncing.sync(&app).await }).map_err(network_error)?;
    Ok(report.into())
}

#[tauri::command(async)]
pub fn sync_status(syncing: State<Arc<Syncing>>) -> SyncStatus {
    syncing.status()
}

#[tauri::command(async)]
pub fn photos_on_demand(state: State<AppState>) -> CommandResult<bool> {
    crate::with_vault(&state, |vault| Ok(vault.is_replica() && vault.photos_on_demand()?))
}

#[tauri::command(async)]
pub fn set_photos_on_demand(state: State<AppState>, syncing: State<Arc<Syncing>>, on: bool) -> CommandResult<()> {
    crate::with_vault(&state, |vault| vault.set_photos_on_demand(on))?;
    syncing.poke();
    Ok(())
}

#[tauri::command(async)]
pub fn want_photo(state: State<AppState>, syncing: State<Arc<Syncing>>, id: Uuid) -> CommandResult<()> {
    crate::with_vault(&state, |vault| vault.want_photo(id))?;
    syncing.poke();
    Ok(())
}

pub(crate) fn with_host<T: Send>(
    state: &AppState,
    action: impl FnOnce(&mut Vault) -> Result<T, Error> + Send,
) -> CommandResult<T> {
    let mut vault = state.vault.lock().unwrap();
    let vault = vault.as_mut().ok_or_else(locked)?;
    if !vault.is_replica() {
        return Ok(action(vault)?);
    }
    let address = vault.host_address()?.ok_or(Error::NeedsHost)?;
    on_network(move || async move {
        let held = net::hold_directory(vault, &address).await;
        let held = match held {
            Ok(held) => held,
            Err(glaze_vault_sync::Error::Protocol(reason)) => return Err(network_error(reason)),
            Err(_) => return Err(Error::NeedsHost.into()),
        };
        if net::sync_holding(vault, &address, &held).await.is_err() {
            held.release().await;
            return Err(Error::NeedsHost.into());
        }
        let done = action(vault).map_err(CommandError::from);
        if done.is_ok() {
            let _ = net::sync_holding(vault, &address, &held).await;
        }
        held.release().await;
        done
    })
}

pub(super) fn asking(state: &State<AppState>) -> CommandResult<(net::Asking, String)> {
    let vault = state.vault.lock().unwrap();
    let vault = vault.as_ref().ok_or_else(locked)?;
    let address = vault.host_address()?.ok_or(Error::NeedsHost)?;
    Ok((net::Asking::of(vault).map_err(network_error)?, address))
}

pub(super) fn note_revocations(state: &AppState, devices: &[DeviceInfo]) {
    if let Some(vault) = state.vault.lock().unwrap().as_mut() {
        let _ = vault.note_revocations(devices);
    }
}
