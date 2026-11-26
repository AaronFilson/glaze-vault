//! Starting, moving, and stopping a LAN host (`hostd`) from this computer.

use super::{Network, SyncReport, hostd, no_service, sync};
use crate::{AppState, CommandError, CommandResult, locked};
use glaze_vault_core::{Error, HOST_BACKUP_EXTENSION, HostStore, Vault};
use glaze_vault_sync::net::DEFAULT_PORT;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use tauri::{State, WebviewWindow};

/// Serves this vault on the network from this computer, on `port`, advertised as `name`.
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
    drop(host);
    if let Err(e) = serve_staging(&network, &hostd, &staging, port, &name, vault) {
        vault.stop_syncing()?;
        return Err(CommandError::new("host-failed", e));
    }
    first_sync(vault)
}

fn serve_staging(
    network: &Network,
    hostd: &Path,
    staging: &Path,
    port: u16,
    name: &str,
    vault: &mut Vault,
) -> Result<(), String> {
    let served = if no_service() {
        serve_as_child(network, hostd, staging, port, vault)
    } else {
        let port_text = port.to_string();
        let from = staging.to_string_lossy().into_owned();
        let installed = elevated(
            hostd,
            &["install", "--from", &from, "--port", &port_text, "--name", name],
        );
        let _ = fs::remove_dir_all(staging);
        installed
    };
    if served.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    served
}

fn first_sync(vault: &mut Vault) -> CommandResult<SyncReport> {
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

/// Moves the vault's host to this computer (docs/adr/0037-moving-the-host.md).
#[tauri::command(async)]
pub fn move_host_here(
    window: WebviewWindow,
    state: State<AppState>,
    network: State<Network>,
    port: Option<u16>,
    name: String,
    anyway: bool,
) -> CommandResult<Option<SyncReport>> {
    let hostd = hostd()
        .ok_or_else(|| CommandError::new("no-hostd", "This copy of Glaze Vault cannot serve: hostd is missing."))?;
    let port = port.unwrap_or(DEFAULT_PORT);
    let name = match name.trim() {
        "" => "Glaze Vault host".to_owned(),
        name => name.to_owned(),
    };
    let Some(path) = crate::open_dialog(
        &window,
        "Choose the host's file",
        "Glaze Vault host backup",
        &[HOST_BACKUP_EXTENSION],
    )?
    else {
        return Ok(None);
    };
    let staging = state.dir.with_file_name("host-staging");
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(crate::file_error)?;
    }
    let mut vault = state.vault.lock().unwrap();
    let vault = vault.as_mut().ok_or_else(locked)?;
    let old_address = vault.host_address()?.ok_or(Error::NeedsHost)?;
    if old_address.starts_with("127.0.0.1:") {
        return Err(CommandError::new("host-here", "This computer is the host already."));
    }
    if sync(vault).is_ok() {
        return Err(CommandError::new(
            "old-host-serving",
            "The old host still serves. Stop it there first (Stop serving, or hostd uninstall), then move it here.",
        ));
    }
    if let Err(e) = vault.unpack_host_backup(&path, &staging, anyway) {
        let _ = fs::remove_dir_all(&staging);
        return Err(e.into());
    }
    vault.set_host_address(&format!("127.0.0.1:{port}"))?;
    if let Err(e) = serve_staging(&network, &hostd, &staging, port, &name, vault) {
        vault.set_host_address(&old_address)?;
        return Err(CommandError::new("host-failed", e));
    }
    match first_sync(vault) {
        Ok(report) => {
            vault.mark_host_moved_here()?;
            Ok(Some(report))
        }
        Err(e) => {
            let removed = remove_service(&network, &hostd, &state.dir, false);
            vault.set_host_address(&old_address)?;
            let mut message = format!(
                "This computer could not sync with the host it started, so it was stopped again: {}",
                e.message
            );
            if let Err(removing) = removed {
                message.push_str(&format!(
                    " Removing the service failed too ({removing}): run hostd uninstall here as an administrator."
                ));
            }
            Err(CommandError::new("host-failed", message))
        }
    }
}

fn remove_service(network: &Network, hostd: &Path, dir: &Path, keep_data: bool) -> Result<(), String> {
    let child = network.child.lock().unwrap().take();
    match child {
        Some(mut child) => {
            let _ = child.kill();
            let _ = child.wait();
            if !keep_data {
                let _ = fs::remove_dir_all(dir.with_file_name("host-staging"));
            }
            Ok(())
        }
        None if keep_data => elevated(hostd, &["uninstall", "--keep-data"]),
        None => elevated(hostd, &["uninstall"]),
    }
}

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stopped {
    kept: bool,
}

#[tauri::command(async)]
pub fn stop_hosting(
    state: State<AppState>,
    network: State<Network>,
    anyway: bool,
    moving: bool,
) -> CommandResult<Stopped> {
    let hostd = hostd().ok_or_else(|| CommandError::new("no-hostd", "hostd is missing."))?;
    let mut vault = state.vault.lock().unwrap();
    let vault = vault.as_mut().ok_or_else(locked)?;
    if let Err(e) = sync(vault)
        && !anyway
    {
        return Err(e);
    }
    let keep = moving || vault.host_moved_here();
    remove_service(&network, &hostd, &state.dir, keep).map_err(|e| CommandError::new("host-failed", e))?;
    *network.pairing.lock().unwrap() = None;
    if keep {
        vault.set_host_retired(true)?;
    } else {
        vault.stop_syncing()?;
    }
    Ok(Stopped { kept: keep })
}

#[cfg(desktop)]
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

#[cfg(mobile)]
fn elevated(_program: &Path, _args: &[&str]) -> Result<(), String> {
    Err("Phones and tablets do not serve.".into())
}

#[cfg(target_os = "macos")]
fn elevated_command(program: &str, args: &[&str]) -> Command {
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
