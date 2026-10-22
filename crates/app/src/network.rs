//! Host mode in the app (docs/adr/0022-host-mode.md): serving the vault from this computer, which
//! keeps working on it as the host's first computer, a replica over loopback; pairing other
//! computers; and stopping. The service itself is `hostd`, installed beside the app, set up by
//! an administrator's prompt from the system.

use crate::{AppState, CommandError, CommandResult, locked};
use glaze_vault_core::sync::DeviceInfo;
use glaze_vault_core::{HostStore, Vault};
use glaze_vault_sync::net::{self, AdminPairing, DEFAULT_PORT, Finished};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;
use uuid::Uuid;

/// What host mode keeps between commands.
#[derive(Default)]
pub struct Network {
    /// A pairing this admin started, and the computer that used its code, once one has.
    pairing: Mutex<Option<(AdminPairing, Option<Finished>)>>,
    /// hostd as a child process, in development with GLAZE_VAULT_HOST_NO_SERVICE.
    child: Mutex<Option<Child>>,
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

fn sync(vault: &mut Vault) -> CommandResult<SyncReport> {
    let address = vault
        .host_address()?
        .ok_or_else(|| network_error("This vault has no host."))?;
    let report = on_network(move || async move { net::sync(vault, &address).await }).map_err(network_error)?;
    Ok(SyncReport {
        pulled: report.pulled,
        accepted: report.accepted,
        refused: report.refused.len(),
    })
}

#[tauri::command(async)]
pub fn sync_now(state: State<AppState>) -> CommandResult<SyncReport> {
    let mut vault = state.vault.lock().unwrap();
    sync(vault.as_mut().ok_or_else(locked)?)
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
