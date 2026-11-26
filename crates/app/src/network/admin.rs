//! Checkouts, offline rules & extension codes, device revocation, and remote host backups.

use super::{asking, network_error, note_revocations, on_network, with_host};
use crate::syncing::Syncing;
use crate::{AppState, CommandResult, locked};
use glaze_vault_core::sync::{Checkout, DeviceInfo};
use glaze_vault_core::{Error, HOST_BACKUP_EXTENSION, HostBackup, Kind, Note, OfflinePolicy, OfflineStatus, Vault};
use glaze_vault_sync::net;
use serde::Serialize;
use std::sync::Arc;
use tauri::{State, WebviewWindow};
use uuid::Uuid;

#[tauri::command(async)]
pub fn devices(state: State<AppState>) -> CommandResult<Vec<DeviceInfo>> {
    let (asking, address) = asking(&state)?;
    let devices = on_network(move || async move { net::devices(&asking, &address).await }).map_err(network_error)?;
    note_revocations(&state, &devices);
    Ok(devices)
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

#[tauri::command(async)]
pub fn checkouts(state: State<AppState>) -> CommandResult<Vec<CheckoutView>> {
    let vault = state.vault.lock().unwrap();
    let vault = vault.as_ref().ok_or_else(locked)?;
    Ok(views(vault, vault.checkouts()))
}

#[tauri::command(async)]
pub fn check_out(
    state: State<AppState>,
    syncing: State<Arc<Syncing>>,
    kind: Kind,
    record: Uuid,
    take_over: bool,
) -> CommandResult<Vec<CheckoutView>> {
    let before = {
        let vault = state.vault.lock().unwrap();
        vault
            .as_ref()
            .ok_or_else(locked)?
            .checkouts()
            .into_iter()
            .find(|c| c.record == record)
    };
    let (asking, address) = asking(&state)?;
    let after = on_network(move || async move { net::check_out(&asking, &address, record, take_over).await })
        .map_err(|_| Error::NeedsHost)?;
    let mut vault = state.vault.lock().unwrap();
    let vault = vault.as_mut().ok_or_else(locked)?;
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
    let (asking, address) = asking(&state)?;
    let after = on_network(move || async move { net::release(&asking, &address, record).await })
        .map_err(|_| Error::NeedsHost)?;
    let mut vault = state.vault.lock().unwrap();
    let vault = vault.as_mut().ok_or_else(locked)?;
    vault.set_checkouts(after.clone());
    Ok(views(vault, after))
}

#[tauri::command(async)]
pub fn offline_status(state: State<AppState>) -> CommandResult<OfflineStatus> {
    let vault = state.vault.lock().unwrap();
    Ok(vault.as_ref().ok_or_else(locked)?.offline_status()?)
}

#[tauri::command(async)]
pub fn extend_offline(state: State<AppState>, code: String) -> CommandResult<OfflineStatus> {
    let mut vault = state.vault.lock().unwrap();
    Ok(vault.as_mut().ok_or_else(locked)?.extend(&code)?)
}

#[tauri::command(async)]
pub fn offline_policy(state: State<AppState>) -> CommandResult<OfflinePolicy> {
    let vault = state.vault.lock().unwrap();
    Ok(vault.as_ref().ok_or_else(locked)?.offline_policy())
}

#[tauri::command(async)]
pub fn set_offline_policy(state: State<AppState>, policy: OfflinePolicy) -> CommandResult<()> {
    with_host(&state, move |vault| vault.set_offline_policy(&policy))
}

#[tauri::command(async)]
pub fn extension_code(state: State<AppState>, device: Uuid, days: u32) -> CommandResult<String> {
    let (asking, address) = asking(&state)?;
    on_network(move || async move { net::extension_code(&asking, &address, device, days).await }).map_err(network_error)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revoked {
    devices: Vec<DeviceInfo>,
    passwords: Vec<(Uuid, String)>,
}

#[tauri::command(async)]
pub fn revoke_device(state: State<AppState>, device: Uuid, lost: bool) -> CommandResult<Revoked> {
    let (asking, address) = asking(&state)?;
    let devices = on_network(move || async move { net::revoke_device(&asking, &address, device, lost).await })
        .map_err(network_error)?;
    note_revocations(&state, &devices);
    let people = devices
        .iter()
        .find(|d| d.id == device)
        .map(|d| d.people.clone())
        .unwrap_or_default();
    let passwords = if lost {
        with_host(&state, move |vault| vault.secure_after_lost(&people))?
    } else {
        Default::default()
    };
    Ok(Revoked { devices, passwords })
}

#[tauri::command(async)]
pub fn host_backups(state: State<AppState>) -> CommandResult<Vec<HostBackup>> {
    let (asking, address) = asking(&state)?;
    on_network(move || async move { net::host_backups(&asking, &address).await }).map_err(network_error)
}

#[tauri::command(async)]
pub fn restore_host_backup(state: State<AppState>, name: String) -> CommandResult<()> {
    let (asking, address) = asking(&state)?;
    on_network(move || async move { net::restore_host_backup(&asking, &address, &name).await }).map_err(network_error)
}

#[tauri::command(async)]
pub fn save_host_backup(
    window: WebviewWindow,
    state: State<AppState>,
    suggested_name: String,
) -> CommandResult<Option<i64>> {
    let Some(path) = crate::save_dialog(
        &window,
        &suggested_name,
        "Glaze Vault host backup",
        HOST_BACKUP_EXTENSION,
    )?
    else {
        return Ok(None);
    };
    let (asking, address) = asking(&state)?;
    let made = on_network(move || async move { net::download_host_backup(&asking, &address, &path).await })
        .map_err(network_error)?;
    Ok(Some(made))
}

#[tauri::command(async)]
pub fn restore_host_from_file(window: WebviewWindow, state: State<AppState>) -> CommandResult<Option<i64>> {
    let Some(path) = crate::open_dialog(
        &window,
        "Choose a backup of the host",
        "Glaze Vault host backup",
        &[HOST_BACKUP_EXTENSION],
    )?
    else {
        return Ok(None);
    };
    let made = {
        let vault = state.vault.lock().unwrap();
        vault.as_ref().ok_or_else(locked)?.check_host_backup(&path)?
    };
    let (asking, address) = asking(&state)?;
    on_network(move || async move { net::restore_host_from_file(&asking, &address, &path).await })
        .map_err(network_error)?;
    Ok(Some(made))
}
