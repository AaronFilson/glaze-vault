//! Discovering hosts, joining a vault as a replica, and leaving a vault.

use super::{Network, network_error, on_network, sync};
use crate::{AppState, CommandError, CommandResult, locked};
use glaze_vault_core::sync::DeviceKey;
use glaze_vault_core::{Error, Vault};
use glaze_vault_sync::net::{self, DEFAULT_PORT};
use serde::Serialize;
use std::process::Command;
use std::time::Duration;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundHost {
    name: String,
    address: String,
}

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
    fingerprint: String,
    suggested_name: String,
}

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

#[cfg(target_os = "android")]
fn computer_name() -> String {
    Command::new("getprop")
        .arg("ro.product.model")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "An Android phone".to_owned())
}

#[cfg(target_os = "ios")]
fn computer_name() -> String {
    // SAFETY: uname fills the struct it is given; its fields are NUL-terminated.
    let machine = unsafe {
        let mut names: libc::utsname = std::mem::zeroed();
        if libc::uname(&mut names) != 0 {
            return "An iPhone".to_owned();
        }
        std::ffi::CStr::from_ptr(names.machine.as_ptr())
            .to_string_lossy()
            .into_owned()
    };
    match machine.starts_with("iPad") {
        true => "An iPad".to_owned(),
        false => "An iPhone".to_owned(),
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn computer_name() -> String {
    Command::new("hostname")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|name| name.trim().trim_end_matches(".local").to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "A computer".to_owned())
}

#[tauri::command(async)]
pub fn join_vault(
    state: State<AppState>,
    network: State<Network>,
    address: String,
    code: String,
    name: String,
    invite: Option<String>,
) -> CommandResult<()> {
    let (addresses, code, expect) = match invite {
        Some(scanned) => {
            let invite = net::Invite::parse(&scanned).map_err(network_error)?;
            (invite.addresses, invite.code, Some(invite.host_key))
        }
        None => {
            let address = match address.trim() {
                a if a.contains(':') => a.to_owned(),
                a => format!("{a}:{DEFAULT_PORT}"),
            };
            (vec![address], code, None)
        }
    };
    let Some(device) = network.joining.lock().unwrap().take() else {
        return Err(network_error("Start joining again."));
    };
    let name = match name.trim() {
        "" => computer_name(),
        name => name.to_owned(),
    };
    let dir = state.dir.clone();
    let cancelled = network.cancelled.notified();
    let joined = on_network(|| async {
        let pair = async {
            let mut tried = Err(glaze_vault_sync::Error::Pairing("the code has no address".into()));
            for address in &addresses {
                tried = net::pair(address, code.trim(), &name, &dir, &device, expect.clone()).await;
                if !matches!(tried, Err(glaze_vault_sync::Error::Io(_))) {
                    break;
                }
            }
            tried
        };
        tokio::select! {
            joined = pair => joined,
            () = cancelled => Err(glaze_vault_sync::Error::Pairing("joining was cancelled".into())),
        }
    });
    if let Err(e) = joined {
        *network.joining.lock().unwrap() = Some(device);
        return Err(match e {
            glaze_vault_sync::Error::Core(e) => e.into(),
            glaze_vault_sync::Error::Io(e) if cfg!(target_os = "ios") => unreachable_on_ios(e),
            e => network_error(e),
        });
    }
    Ok(())
}

fn unreachable_on_ios(error: std::io::Error) -> CommandError {
    CommandError::new(
        "local-network",
        format!(
            "The host could not be reached ({error}). If this iPhone or iPad was asked about finding devices on the local network and the answer was no, turn on Local Network for Glaze Vault in Settings, Privacy & Security, Local Network, then try again. Otherwise check that both are on the same network."
        ),
    )
}

#[tauri::command(async)]
pub fn cancel_join(network: State<Network>) {
    network.cancel();
}

#[tauri::command(async)]
pub fn leave_vault(state: State<AppState>) -> CommandResult<()> {
    let mut vault = state.vault.lock().unwrap();
    let open = vault.as_ref().ok_or_else(locked)?;
    if !open.is_replica() {
        return Err(Error::NotAllowed.into());
    }
    if open.host_address()?.is_some_and(|a| a.starts_with("127.0.0.1:"))
        && !open.host_retired()
        && sync(vault.as_mut().expect("open")).is_ok()
    {
        return Err(CommandError::new(
            "host-here",
            "This computer serves the vault: stop serving instead.",
        ));
    }
    Ok(vault.take().expect("open").leave()?)
}
