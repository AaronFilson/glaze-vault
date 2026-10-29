//! The network in the app. Host mode (docs/adr/0022-host-mode.md): serving the vault from this
//! computer, which keeps working on it as the host's first computer, a replica over loopback;
//! pairing other computers; and stopping. The service itself is `hostd`, installed beside the
//! app, set up by an administrator's prompt from the system. Client mode
//! (docs/adr/0023-client-mode.md): joining a vault a host serves, checking records out, changing
//! the directory through the host, and leaving; syncing itself is syncing.rs.

use crate::syncing::{SyncStatus, Syncing};
use crate::{AppState, CommandError, CommandResult, locked};
use glaze_vault_core::sync::{Checkout, DeviceInfo, DeviceKey};
use glaze_vault_core::{Error, HostStore, Kind, Note, Vault};
use glaze_vault_sync::net::{self, AdminPairing, DEFAULT_PORT, Finished};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, State};
use uuid::Uuid;

/// What the network keeps between commands.
#[derive(Default)]
pub struct Network {
    /// A pairing this admin started, and the computer that used its code, once one has.
    pairing: Mutex<Option<(AdminPairing, Option<Finished>)>>,
    /// hostd as a child process, in development with GLAZE_VAULT_HOST_NO_SERVICE.
    child: Mutex<Option<Child>>,
    /// The key this computer made to join a vault, shown to the admin as a fingerprint.
    joining: Mutex<Option<DeviceKey>>,
}

impl Drop for Network {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.get_mut().ok().and_then(Option::take) {
            let _ = child.kill();
        }
    }
}

fn network_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("network", error.to_string())
}

/// Runs network work to its end on a thread of its own, outside the command's runtime, on the
/// app's runtime for connections that outlive one command (a pairing).
/// The work is made on that thread, so what it borrows need only be Send.
fn on_network<T: Send, F: Future<Output = T>>(work: impl FnOnce() -> F + Send) -> T {
    std::thread::scope(|scope| {
        scope
            .spawn(|| tauri::async_runtime::block_on(work()))
            .join()
            .expect("the network thread")
    })
}

/// Where hostd is: beside the app, as the installer puts its sidecar, or GLAZE_VAULT_HOSTD.
fn hostd() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("GLAZE_VAULT_HOSTD") {
        return Some(PathBuf::from(path));
    }
    let path = std::env::current_exe()
        .ok()?
        .with_file_name(format!("hostd{}", std::env::consts::EXE_SUFFIX));
    path.is_file().then_some(path)
}

/// Development and tests: hostd as a child process, with no service and no administrator.
fn no_service() -> bool {
    std::env::var_os("GLAZE_VAULT_HOST_NO_SERVICE").is_some()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    /// Whether this vault syncs with a host.
    replica: bool,
    /// Whether that host is on this computer.
    host_here: bool,
    host_address: Option<String>,
    /// Whether this app can serve: hostd is installed beside it.
    can_host: bool,
    default_port: u16,
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

/// A sync while this command holds the vault, as in starting and stopping serving.
fn sync(vault: &mut Vault) -> CommandResult<SyncReport> {
    let address = vault
        .host_address()?
        .ok_or_else(|| network_error("This vault has no host."))?;
    let report = on_network(move || async move { net::sync(vault, &address).await }).map_err(network_error)?;
    Ok(report.into())
}

/// Syncs now, as the background sync would, and waits for it.
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

/// Runs a change to people, roles or collections (the plan's question 5). On a computer that
/// syncs with a host, it needs the host: this computer holds the directory there, so no other
/// changes it meanwhile, catches up, makes the change, and sends it before letting go.
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
        if net::sync(vault, &address).await.is_err() {
            held.release().await;
            return Err(Error::NeedsHost.into());
        }
        let done = action(vault).map_err(CommandError::from);
        if done.is_ok() {
            // If this fails the change waits here, and goes with the next sync.
            let _ = net::sync(vault, &address).await;
        }
        held.release().await;
        done
    })
}

/// Serves this vault on the network from this computer, on `port`, advertised as `name`: makes
/// the host's store, has the system install hostd as a service with it (an administrator's
/// prompt), and syncs with it once. If installing fails, the vault stays as it was.
#[tauri::command(async)]
pub fn start_hosting(
    state: State<AppState>,
    network: State<Network>,
    port: Option<u16>,
    name: String,
) -> CommandResult<SyncReport> {
    let hostd = hostd()
        .ok_or_else(|| CommandError::new("no-hostd", "This copy of Glaze Vault cannot serve: hostd is missing."))?;
    let port = port.unwrap_or(DEFAULT_PORT);
    let name = match name.trim() {
        "" => "Glaze Vault host".to_owned(),
        name => name.to_owned(),
    };
    let staging = state.dir.with_file_name("host-staging");
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(crate::file_error)?;
    }
    let mut vault = state.vault.lock().unwrap();
    let vault = vault.as_mut().ok_or_else(locked)?;
    let host: HostStore = vault.convert_to_host(&staging, &format!("127.0.0.1:{port}"))?;
    // Closed, so its database is whole in one file before it is copied.
    drop(host);
    let served = if no_service() {
        serve_as_child(&network, &hostd, &staging, port, vault)
    } else {
        let port_text = port.to_string();
        let from = staging.to_string_lossy().into_owned();
        let installed = elevated(
            &hostd,
            &["install", "--from", &from, "--port", &port_text, "--name", &name],
        );
        let _ = fs::remove_dir_all(&staging);
        installed
    };
    if let Err(e) = served {
        let _ = fs::remove_dir_all(&staging);
        vault.stop_syncing()?;
        return Err(CommandError::new("host-failed", e));
    }
    // The service takes a moment to start listening.
    let mut last = None;
    for _ in 0..20 {
        match sync(vault) {
            Ok(report) => return Ok(report),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(last.expect("tried"))
}

/// In development: hostd run in the foreground as a child, serving the staging folder itself.
fn serve_as_child(network: &Network, hostd: &Path, dir: &Path, port: u16, vault: &mut Vault) -> Result<(), String> {
    let port_file = dir.join("port");
    let child = Command::new(hostd)
        .arg("run")
        .arg(dir)
        .args(["--port", &port.to_string(), "--no-mdns", "--port-file"])
        .arg(&port_file)
        .spawn()
        .map_err(|e| e.to_string())?;
    *network.child.lock().unwrap() = Some(child);
    for _ in 0..50 {
        if let Ok(port) = fs::read_to_string(&port_file) {
            return vault
                .set_host_address(&format!("127.0.0.1:{}", port.trim()))
                .map_err(|e| e.to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("hostd did not start".into())
}

/// Stops serving: syncs a last time, has the system remove the service and the host's store, and
/// makes this vault one on this computer alone again. Computers paired with the host keep what
/// they had, and can no longer sync. Unless `anyway`, a failed last sync stops it.
#[tauri::command(async)]
pub fn stop_hosting(state: State<AppState>, network: State<Network>, anyway: bool) -> CommandResult<()> {
    let hostd = hostd().ok_or_else(|| CommandError::new("no-hostd", "hostd is missing."))?;
    let mut vault = state.vault.lock().unwrap();
    let vault = vault.as_mut().ok_or_else(locked)?;
    if let Err(e) = sync(vault)
        && !anyway
    {
        return Err(e);
    }
    let child = network.child.lock().unwrap().take();
    match child {
        Some(mut child) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_dir_all(state.dir.with_file_name("host-staging"));
        }
        None => elevated(&hostd, &["uninstall"]).map_err(|e| CommandError::new("host-failed", e))?,
    }
    *network.pairing.lock().unwrap() = None;
    Ok(vault.stop_syncing()?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    code: String,
    expires_at: i64,
}

/// Asks the host for a code to pair a computer with, for an admin.
#[tauri::command(async)]
pub fn start_pairing(state: State<AppState>, network: State<Network>) -> CommandResult<PairingCode> {
    let mut vault = state.vault.lock().unwrap();
    let vault = vault.as_mut().ok_or_else(locked)?;
    let address = vault
        .host_address()?
        .ok_or_else(|| network_error("This vault has no host."))?;
    let pairing =
        on_network(move || async move { AdminPairing::start(vault, &address).await }).map_err(network_error)?;
    let code = PairingCode {
        code: pairing.code.clone(),
        expires_at: pairing.expires_at,
    };
    *network.pairing.lock().unwrap() = Some((pairing, None));
    Ok(code)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingComputer {
    device: Uuid,
    name: String,
    fingerprint: String,
}

/// Waits until a computer uses the code, or it runs out. The vault is not held meanwhile.
#[tauri::command(async)]
pub fn wait_for_pairing(network: State<Network>) -> CommandResult<PairingComputer> {
    let taken = network.pairing.lock().unwrap().take();
    let Some((mut pairing, _)) = taken else {
        return Err(network_error("No pairing is open."));
    };
    let finished = on_network(|| async { pairing.wait().await }).map_err(network_error)?;
    let computer = PairingComputer {
        device: finished.device,
        name: finished.name.clone(),
        fingerprint: finished.fingerprint(),
    };
    *network.pairing.lock().unwrap() = Some((pairing, Some(finished)));
    Ok(computer)
}

/// Lets the computer that used the code in, for these people.
#[tauri::command(async)]
pub fn approve_pairing(state: State<AppState>, network: State<Network>, people: Vec<Uuid>) -> CommandResult<()> {
    let taken = network.pairing.lock().unwrap().take();
    let Some((pairing, Some(finished))) = taken else {
        return Err(network_error("No computer is waiting to pair."));
    };
    let mut vault = state.vault.lock().unwrap();
    let vault = vault.as_mut().ok_or_else(locked)?;
    on_network(move || async move { pairing.approve(vault, &finished, &people).await }).map_err(network_error)
}

#[tauri::command(async)]
pub fn cancel_pairing(network: State<Network>) {
    *network.pairing.lock().unwrap() = None;
}

/// The computers that sync with the host, for an admin.
#[tauri::command(async)]
pub fn devices(state: State<AppState>) -> CommandResult<Vec<DeviceInfo>> {
    let mut vault = state.vault.lock().unwrap();
    let vault = vault.as_mut().ok_or_else(locked)?;
    let address = vault
        .host_address()?
        .ok_or_else(|| network_error("This vault has no host."))?;
    on_network(move || async move { net::devices(vault, &address).await }).map_err(network_error)
}

/// Runs hostd with an administrator's rights, which the system asks the person for.
fn elevated(program: &Path, args: &[&str]) -> Result<(), String> {
    let program = program.to_string_lossy();
    let output = elevated_command(&program, args).output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let said = String::from_utf8_lossy(&output.stderr);
        Err(match said.trim() {
            "" => "The service could not be set up.".to_owned(),
            said => said.to_owned(),
        })
    }
}

#[cfg(target_os = "macos")]
fn elevated_command(program: &str, args: &[&str]) -> Command {
    // osascript's prompt; SMAppService would need macOS 13.
    let quote = |text: &str| format!("'{}'", text.replace('\'', r"'\''"));
    let shell = std::iter::once(program)
        .chain(args.iter().copied())
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        shell.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let mut command = Command::new("osascript");
    command.args(["-e", &script]);
    command
}

#[cfg(target_os = "linux")]
fn elevated_command(program: &str, args: &[&str]) -> Command {
    let mut command = Command::new("pkexec");
    command.arg(program).args(args);
    command
}

#[cfg(windows)]
fn elevated_command(program: &str, args: &[&str]) -> Command {
    // A UAC prompt, by PowerShell's Start-Process, which gives back the exit code.
    let quote = |text: &str| text.replace('\'', "''");
    let arguments = args
        .iter()
        .map(|a| format!("\"{}\"", a.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "$p = Start-Process -FilePath '{}' -ArgumentList '{}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode",
        quote(program),
        quote(&arguments)
    );
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    command
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundHost {
    name: String,
    address: String,
}

/// The hosts serving a vault on this network, as they advertise themselves.
#[tauri::command(async)]
pub fn discover_hosts() -> CommandResult<Vec<FoundHost>> {
    let found = net::browse(Duration::from_secs(3)).map_err(network_error)?;
    Ok(found
        .into_iter()
        .filter_map(|host| {
            let ip = host.addresses.iter().find(|a| a.is_ipv4()).or(host.addresses.first())?;
            let address = match ip {
                std::net::IpAddr::V6(ip) => format!("[{ip}]:{}", host.port),
                ip => format!("{ip}:{}", host.port),
            };
            Some(FoundHost {
                name: host.name,
                address,
            })
        })
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Joining {
    /// For the admin to check against what their screen shows.
    fingerprint: String,
    /// This computer's name, for the admin to see.
    suggested_name: String,
}

/// Makes the key this computer joins with, and shows its fingerprint, before the code is typed.
#[tauri::command(async)]
pub fn prepare_join(state: State<AppState>, network: State<Network>) -> CommandResult<Joining> {
    if Vault::exists(&state.dir) {
        return Err(Error::VaultExists.into());
    }
    let mut joining = network.joining.lock().unwrap();
    let device = joining.get_or_insert_with(DeviceKey::generate);
    Ok(Joining {
        fingerprint: net::fingerprint(&device.public()),
        suggested_name: computer_name(),
    })
}

/// What the system calls this computer, if it says.
fn computer_name() -> String {
    Command::new("hostname")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|name| name.trim().trim_end_matches(".local").to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "A computer".to_owned())
}

/// Joins the vault served at `address` with the code an admin read out: waits until the admin
/// approves this computer, then it is a replica, locked, for its people to sign in to.
#[tauri::command(async)]
pub fn join_vault(
    state: State<AppState>,
    network: State<Network>,
    address: String,
    code: String,
    name: String,
) -> CommandResult<()> {
    let Some(device) = network.joining.lock().unwrap().take() else {
        return Err(network_error("Start joining again."));
    };
    let address = match address.trim() {
        a if a.contains(':') => a.to_owned(),
        a => format!("{a}:{DEFAULT_PORT}"),
    };
    let name = match name.trim() {
        "" => computer_name(),
        name => name.to_owned(),
    };
    let dir = state.dir.clone();
    let joined = on_network(|| async { net::pair(&address, code.trim(), &name, &dir, &device).await });
    if let Err(e) = joined {
        // The same key again, so the fingerprint the admin may have noted still holds.
        *network.joining.lock().unwrap() = Some(device);
        return Err(match e {
            glaze_vault_sync::Error::Core(e) => e.into(),
            e => network_error(e),
        });
    }
    Ok(())
}

/// Takes this computer out of the vault: its copy is written over and removed. What it has not
/// synced is lost; the page says how much first.
#[tauri::command(async)]
pub fn leave_vault(state: State<AppState>) -> CommandResult<()> {
    let mut vault = state.vault.lock().unwrap();
    let open = vault.as_ref().ok_or_else(locked)?;
    if !open.is_replica() {
        return Err(Error::NotAllowed.into());
    }
    if open.host_address()?.is_some_and(|a| a.starts_with("127.0.0.1:")) {
        return Err(CommandError::new(
            "host-here",
            "This computer serves the vault: stop serving instead.",
        ));
    }
    Ok(vault.take().expect("open").leave()?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutView {
    record: Uuid,
    person: Uuid,
    name: String,
    mine: bool,
    since: i64,
    expires: i64,
}

fn views(vault: &Vault, checkouts: Vec<Checkout>) -> Vec<CheckoutView> {
    let me = vault.me().id;
    checkouts
        .into_iter()
        .map(|c| CheckoutView {
            record: c.record,
            person: c.person,
            name: vault.name_of(c.person).unwrap_or_else(|| "Someone".to_owned()),
            mine: c.person == me,
            since: c.since,
            expires: c.expires,
        })
        .collect()
}

/// Who is changing what, as the host said at the last sync; nothing if this computer has not
/// heard from it lately, or does not sync.
#[tauri::command(async)]
pub fn checkouts(state: State<AppState>) -> CommandResult<Vec<CheckoutView>> {
    let vault = state.vault.lock().unwrap();
    let vault = vault.as_ref().ok_or_else(locked)?;
    Ok(views(vault, vault.checkouts()))
}

/// Checks a record out for the person signed in, so others see they are changing it, or takes
/// it over from whoever has it, which the audit log notes.
#[tauri::command(async)]
pub fn check_out(
    state: State<AppState>,
    syncing: State<Arc<Syncing>>,
    kind: Kind,
    record: Uuid,
    take_over: bool,
) -> CommandResult<Vec<CheckoutView>> {
    let mut vault = state.vault.lock().unwrap();
    let vault = vault.as_mut().ok_or_else(locked)?;
    let address = vault.host_address()?.ok_or(Error::NeedsHost)?;
    let before = vault.checkouts().into_iter().find(|c| c.record == record);
    let asking = &mut *vault;
    let after = on_network(move || async move { net::check_out(asking, &address, record, take_over).await })
        .map_err(|_| Error::NeedsHost)?;
    let me = vault.me().id;
    if let Some(before) = before
        && before.person != me
        && after.iter().any(|c| c.record == record && c.person == me)
    {
        vault.note(Note::TookOver {
            kind,
            record,
            from: before.person,
        })?;
    }
    vault.set_checkouts(after.clone());
    syncing.poke();
    Ok(views(vault, after))
}

#[tauri::command(async)]
pub fn release_checkout(state: State<AppState>, record: Uuid) -> CommandResult<Vec<CheckoutView>> {
    let mut vault = state.vault.lock().unwrap();
    let vault = vault.as_mut().ok_or_else(locked)?;
    let address = vault.host_address()?.ok_or(Error::NeedsHost)?;
    let asking = &mut *vault;
    let after = on_network(move || async move { net::release(asking, &address, record).await })
        .map_err(|_| Error::NeedsHost)?;
    vault.set_checkouts(after.clone());
    Ok(views(vault, after))
}
