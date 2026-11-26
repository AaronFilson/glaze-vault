//! Preferences stored outside the vault (`preferences.json`) and desktop app updates.

use crate::{AppState, CommandError, CommandResult, file_error};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, State};
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;

#[cfg(desktop)]
fn update_error(error: tauri_plugin_updater::Error) -> CommandError {
    CommandError::new("update-failed", format!("Glaze Vault could not update: {error}"))
}

/// Choices that apply before the vault is unlocked, so they are kept outside it, in
/// `preferences.json` beside the vault's files. Nothing secret goes here.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Preferences {
    check_for_updates: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Preferences {
            check_for_updates: true,
        }
    }
}

fn preferences_path(state: &AppState) -> PathBuf {
    state.dir.join("preferences.json")
}

#[tauri::command(async)]
pub(crate) fn get_preferences(state: State<AppState>) -> Preferences {
    fs::read(preferences_path(&state))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

#[tauri::command(async)]
pub(crate) fn set_preferences(state: State<AppState>, preferences: Preferences) -> CommandResult<()> {
    fs::create_dir_all(&state.dir).map_err(file_error)?;
    let json = serde_json::to_vec_pretty(&preferences).map_err(file_error)?;
    fs::write(preferences_path(&state), json).map_err(file_error)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Asks GitHub Releases whether there is a newer version. Only the version numbers and the
/// computer's platform are sent (docs/user/settings.md).
#[cfg(desktop)]
#[tauri::command]
pub(crate) async fn check_for_update(app: AppHandle, state: State<'_, AppState>) -> CommandResult<Option<UpdateInfo>> {
    if !state.updates_configured {
        return Err(CommandError::new(
            "updates-not-configured",
            "This copy of Glaze Vault was built without updates. Download new versions from the website.",
        ));
    }
    let update = app
        .updater()
        .map_err(update_error)?
        .check()
        .await
        .map_err(update_error)?;
    let info = update.as_ref().map(|update| UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
    });
    *state.update.lock().unwrap() = update;
    Ok(info)
}

/// Downloads and checks the update found by `check_for_update`, locks the vault, installs the
/// update and restarts. On Windows the installer closes the app itself.
#[cfg(desktop)]
#[tauri::command]
pub(crate) async fn install_update(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let update = state
        .update
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| CommandError::new("no-update", "Check for updates first."))?;
    let bytes = update.download(|_, _| {}, || {}).await.map_err(update_error)?;
    state.vault.lock().unwrap().take();
    update.install(bytes).map_err(update_error)?;
    app.restart();
}

/// Phones and tablets: their app store updates them.
#[cfg(mobile)]
#[tauri::command]
pub(crate) async fn check_for_update(_app: AppHandle) -> CommandResult<Option<UpdateInfo>> {
    Err(updates_from_the_store())
}

#[cfg(mobile)]
#[tauri::command]
pub(crate) async fn install_update(_app: AppHandle) -> CommandResult<()> {
    Err(updates_from_the_store())
}

#[cfg(mobile)]
fn updates_from_the_store() -> CommandError {
    CommandError::new(
        "updates-not-configured",
        "Glaze Vault is updated by the app store on phones and tablets.",
    )
}

/// Whether this build has an updater public key. Builds without one (anyone's own build before
/// docs/releasing.md has been followed) leave the updater out rather than fail to start.
pub(crate) fn updater_configured(config: &tauri::Config) -> bool {
    config
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|pubkey| pubkey.as_str())
        .is_some_and(|pubkey| !pubkey.trim().is_empty())
}
