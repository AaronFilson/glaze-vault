//! Admin pairing commands: generating a pairing code/QR, waiting for a device, and approving it.

use super::{Network, network_error, on_network};
use crate::{AppState, CommandResult, locked};
use glaze_vault_sync::net::{self, AdminPairing};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    code: String,
    expires_at: i64,
    qr_svg: Option<String>,
}

/// Asks the host for a code to pair a computer with, for an admin.
#[tauri::command(async)]
pub fn start_pairing(state: State<AppState>, network: State<Network>) -> CommandResult<PairingCode> {
    let mut vault = state.vault.lock().unwrap();
    let vault = vault.as_mut().ok_or_else(locked)?;
    let address = vault
        .host_address()?
        .ok_or_else(|| network_error("This vault has no host."))?;
    let host_key = vault.host_key()?;
    let addresses = host_addresses(&address);
    let pairing =
        on_network(move || async move { AdminPairing::start(vault, &address).await }).map_err(network_error)?;
    let invite = net::Invite {
        addresses,
        host_key,
        code: pairing.code.clone(),
    };
    let code = PairingCode {
        code: pairing.code.clone(),
        expires_at: pairing.expires_at,
        qr_svg: qr_svg(&invite.to_uri()),
    };
    network.cancel();
    *network.pairing.lock().unwrap() = Some((pairing, None));
    Ok(code)
}

fn host_addresses(address: &str) -> Vec<String> {
    let Some(port) = address.strip_prefix("127.0.0.1:") else {
        return vec![address.to_owned()];
    };
    let lan = std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| socket.connect("192.0.2.1:9").map(|()| socket))
        .and_then(|socket| socket.local_addr())
        .ok()
        .map(|local| local.ip())
        .filter(|ip| !ip.is_loopback() && !ip.is_unspecified());
    lan.map(|ip| vec![format!("{ip}:{port}")]).unwrap_or_default()
}

fn qr_svg(text: &str) -> Option<String> {
    let code = qrcode::QrCode::with_error_correction_level(text, qrcode::EcLevel::M).ok()?;
    Some(
        code.render::<qrcode::render::svg::Color>()
            .min_dimensions(240, 240)
            .quiet_zone(true)
            .build(),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingComputer {
    device: Uuid,
    name: String,
    fingerprint: String,
}

#[tauri::command(async)]
pub fn wait_for_pairing(network: State<Network>) -> CommandResult<PairingComputer> {
    let taken = network.pairing.lock().unwrap().take();
    let Some((mut pairing, _)) = taken else {
        return Err(network_error("No pairing is open."));
    };
    let started = network.pairings.load(std::sync::atomic::Ordering::SeqCst);
    let cancelled = network.cancelled.notified();
    let finished = on_network(|| async {
        tokio::select! {
            finished = pairing.wait() => finished.map_err(network_error),
            () = cancelled => Err(network_error("The pairing was cancelled.")),
        }
    })?;
    if network.pairings.load(std::sync::atomic::Ordering::SeqCst) != started {
        return Err(network_error("The pairing was cancelled."));
    }
    let computer = PairingComputer {
        device: finished.device,
        name: finished.name.clone(),
        fingerprint: finished.fingerprint(),
    };
    *network.pairing.lock().unwrap() = Some((pairing, Some(finished)));
    Ok(computer)
}

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
    network.cancel();
    *network.pairing.lock().unwrap() = None;
}
