//! The Tauri layer: commands that hand the UI's requests to the core, and nothing more
//! (docs/adr/0001-tauri-rust-react.md). File dialogs open from here, not from the page, so the
//! page never chooses where files are written.

use glaze_vault_core::{BACKUP_EXTENSION, Credential, Error, Kind, LastBackup, Revision, Settings, Vault};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use uuid::Uuid;
use zeroize::Zeroizing;

struct AppState {
    dir: PathBuf,
    vault: Mutex<Option<Vault>>,
    /// False in builds made without an updater public key (crates/app/tauri.conf.json).
    updates_configured: bool,
    /// The update found by the last check, kept until it is installed.
    update: Mutex<Option<Update>>,
}

/// What a failed command rejects with in the UI (ui/api.ts).
#[derive(Debug, Serialize)]
struct CommandError {
    code: &'static str,
    message: String,
}

impl From<Error> for CommandError {
    fn from(error: Error) -> Self {
        CommandError {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

impl CommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        CommandError {
            code,
            message: message.into(),
        }
    }
}

fn locked() -> CommandError {
    CommandError::new("locked", "The vault is locked.")
}

fn file_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("io", format!("A file could not be read or written: {error}"))
}

fn update_error(error: tauri_plugin_updater::Error) -> CommandError {
    CommandError::new("update-failed", format!("Glaze Vault could not update: {error}"))
}

type CommandResult<T> = Result<T, CommandError>;

/// Runs `action` on the unlocked vault.
fn with_vault<T>(state: &AppState, action: impl FnOnce(&mut Vault) -> Result<T, Error>) -> CommandResult<T> {
    let mut vault = state.vault.lock().unwrap();
    Ok(action(vault.as_mut().ok_or_else(locked)?)?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultStatus {
    exists: bool,
    unlocked: bool,
    version: String,
    updates_configured: bool,
}

// Commands that derive keys from a password take a moment, so every command runs off the main
// thread (`async`), and the window stays responsive.

#[tauri::command(async)]
fn vault_status(app: AppHandle, state: State<AppState>) -> VaultStatus {
    VaultStatus {
        exists: Vault::exists(&state.dir),
        unlocked: state.vault.lock().unwrap().is_some(),
        version: app.package_info().version.to_string(),
        updates_configured: state.updates_configured,
    }
}

#[tauri::command(async)]
fn create_vault(state: State<AppState>, password: String) -> CommandResult<Vec<String>> {
    let password = Zeroizing::new(password);
    let (vault, recovery) = Vault::create(&state.dir, &password)?;
    *state.vault.lock().unwrap() = Some(vault);
    Ok(recovery.words())
}

#[tauri::command(async)]
fn unlock(state: State<AppState>, password: String) -> CommandResult<()> {
    let password = Zeroizing::new(password);
    let vault = Vault::unlock(&state.dir, &password)?;
    *state.vault.lock().unwrap() = Some(vault);
    Ok(())
}

#[tauri::command(async)]
fn recover(state: State<AppState>, words: String, new_password: String) -> CommandResult<()> {
    let (words, new_password) = (Zeroizing::new(words), Zeroizing::new(new_password));
    let vault = Vault::recover(&state.dir, &words, &new_password)?;
    *state.vault.lock().unwrap() = Some(vault);
    Ok(())
}

/// Dropping the vault wipes its keys from memory.
#[tauri::command(async)]
fn lock(state: State<AppState>) {
    state.vault.lock().unwrap().take();
}

#[tauri::command(async)]
fn change_password(state: State<AppState>, current: String, new_password: String) -> CommandResult<()> {
    let (current, new_password) = (Zeroizing::new(current), Zeroizing::new(new_password));
    with_vault(&state, |vault| vault.change_password(&current, &new_password))
}

#[tauri::command(async)]
fn new_recovery_key(state: State<AppState>, password: String) -> CommandResult<Vec<String>> {
    let password = Zeroizing::new(password);
    with_vault(&state, |vault| Ok(vault.new_recovery_key(&password)?.words()))
}

#[tauri::command(async)]
fn list_records(state: State<AppState>, kind: Kind) -> CommandResult<Vec<Revision>> {
    with_vault(&state, |vault| vault.heads(kind))
}

#[tauri::command(async)]
fn save_record(
    state: State<AppState>,
    kind: Kind,
    parent: Option<Uuid>,
    content: serde_json::Value,
) -> CommandResult<Revision> {
    with_vault(&state, |vault| vault.save(kind, parent, &content))
}

#[tauri::command(async)]
fn record_history(state: State<AppState>, kind: Kind, record_id: Uuid) -> CommandResult<Vec<Revision>> {
    with_vault(&state, |vault| vault.history(kind, record_id))
}

#[tauri::command(async)]
fn get_settings(state: State<AppState>) -> CommandResult<Settings> {
    with_vault(&state, |vault| vault.settings())
}

#[tauri::command(async)]
fn set_settings(state: State<AppState>, settings: Settings) -> CommandResult<()> {
    with_vault(&state, |vault| vault.set_settings(&settings))
}

/// Keeps unsaved edits, encrypted, then locks the vault.
#[tauri::command(async)]
fn lock_with_draft(state: State<AppState>, draft: serde_json::Value) -> CommandResult<()> {
    let mut vault = state.vault.lock().unwrap();
    let result = vault.as_mut().ok_or_else(locked)?.save_draft(&draft);
    // Lock even if the draft could not be kept: an unattended vault must not stay open.
    vault.take();
    Ok(result?)
}

#[tauri::command(async)]
fn get_draft(state: State<AppState>) -> CommandResult<Option<serde_json::Value>> {
    with_vault(&state, |vault| vault.draft())
}

#[tauri::command(async)]
fn save_draft(state: State<AppState>, draft: serde_json::Value) -> CommandResult<()> {
    with_vault(&state, |vault| vault.save_draft(&draft))
}

#[tauri::command(async)]
fn clear_draft(state: State<AppState>) -> CommandResult<()> {
    with_vault(&state, |vault| vault.clear_draft())
}

#[tauri::command(async)]
fn last_backup(state: State<AppState>) -> CommandResult<Option<LastBackup>> {
    with_vault(&state, |vault| vault.last_backup())
}

/// Asks where to save a backup, then writes it. None if the person cancelled.
#[tauri::command(async)]
fn back_up(window: WebviewWindow, state: State<AppState>, suggested_name: String) -> CommandResult<Option<LastBackup>> {
    if state.vault.lock().unwrap().is_none() {
        return Err(locked());
    }
    let Some(path) = save_dialog(&window, &suggested_name, "Glaze Vault backup", BACKUP_EXTENSION)? else {
        return Ok(None);
    };
    with_vault(&state, |vault| vault.back_up(&path).map(Some))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChosenBackup {
    path: String,
    file_name: String,
    created_at: i64,
    app_version: String,
}

/// Asks for a backup file to restore, and says when it was made.
#[tauri::command(async)]
fn choose_backup(window: WebviewWindow) -> CommandResult<Option<ChosenBackup>> {
    let picked = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose a backup to restore")
        .add_filter("Glaze Vault backup", &[BACKUP_EXTENSION])
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(file_error)?;
    let info = Vault::backup_info(&path)?;
    Ok(Some(ChosenBackup {
        file_name: file_name(&path),
        path: path.to_string_lossy().into_owned(),
        created_at: info.created_at,
        app_version: info.app_version,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Restored {
    /// Where the vault that was replaced was moved to, if there was one.
    set_aside: Option<String>,
}

#[tauri::command(async)]
fn restore_backup(
    state: State<AppState>,
    path: String,
    password: Option<String>,
    words: Option<String>,
    new_password: Option<String>,
) -> CommandResult<Restored> {
    let (password, words, new_password) = (
        password.map(Zeroizing::new),
        words.map(Zeroizing::new),
        new_password.map(Zeroizing::new),
    );
    let credential = match (&password, &words, &new_password) {
        (Some(password), None, None) => Credential::Password(password),
        (None, Some(words), Some(new_password)) => Credential::RecoveryKey { words, new_password },
        _ => {
            return Err(CommandError::new(
                "bad-request",
                "Give a password, or a recovery key and a new password.",
            ));
        }
    };
    // The vault's files are about to be moved, so it must not be open.
    let mut vault = state.vault.lock().unwrap();
    vault.take();
    let (restored, set_aside) = Vault::restore(&state.dir, Path::new(&path), &credential)?;
    *vault = Some(restored);
    Ok(Restored {
        set_aside: set_aside.map(|dir| dir.to_string_lossy().into_owned()),
    })
}

/// Asks where to save an export the page has made (CSV or JSON), then writes it. Returns the file
/// name, or None if the person cancelled.
#[tauri::command(async)]
fn save_export(
    window: WebviewWindow,
    state: State<AppState>,
    suggested_name: String,
    contents: String,
) -> CommandResult<Option<String>> {
    if state.vault.lock().unwrap().is_none() {
        return Err(locked());
    }
    let (kind, extension) = match Path::new(&suggested_name).extension().and_then(|e| e.to_str()) {
        Some("csv") => ("CSV spreadsheet", "csv"),
        Some("json") => ("JSON", "json"),
        _ => return Err(CommandError::new("bad-request", "Exports are CSV or JSON.")),
    };
    let Some(path) = save_dialog(&window, &suggested_name, kind, extension)? else {
        return Ok(None);
    };
    fs::write(&path, contents).map_err(file_error)?;
    Ok(Some(file_name(&path)))
}

fn save_dialog(
    window: &WebviewWindow,
    suggested_name: &str,
    kind: &str,
    extension: &str,
) -> CommandResult<Option<PathBuf>> {
    let picked = window
        .dialog()
        .file()
        .set_parent(window)
        .set_file_name(suggested_name)
        .add_filter(kind, &[extension])
        .blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let mut path = picked.into_path().map_err(file_error)?;
    // Some Linux file dialogs leave the extension off. Add it, but never over another file the
    // dialog did not warn about.
    if path.extension().is_none() {
        path.set_extension(extension);
        if path.exists() {
            return Err(CommandError::new(
                "exists",
                format!("{} already exists. Choose another name.", file_name(&path)),
            ));
        }
    }
    Ok(Some(path))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Choices that apply before the vault is unlocked, so they are kept outside it, in
/// `preferences.json` beside the vault's files. Nothing secret goes here.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Preferences {
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
fn get_preferences(state: State<AppState>) -> Preferences {
    fs::read(preferences_path(&state))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

#[tauri::command(async)]
fn set_preferences(state: State<AppState>, preferences: Preferences) -> CommandResult<()> {
    fs::create_dir_all(&state.dir).map_err(file_error)?;
    let json = serde_json::to_vec_pretty(&preferences).map_err(file_error)?;
    fs::write(preferences_path(&state), json).map_err(file_error)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Asks GitHub Releases whether there is a newer version. Only the version numbers and the
/// computer's platform are sent (docs/user/settings.md).
#[tauri::command]
async fn check_for_update(app: AppHandle, state: State<'_, AppState>) -> CommandResult<Option<UpdateInfo>> {
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
#[tauri::command]
async fn install_update(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
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

/// Development builds only: writes the page's text picture of the screen (ui/devScreen.ts) to the
/// file GLAZE_VAULT_SCREEN names, so the app can be followed without screenshots. Returns false
/// when no file is named, and the page stops sending. The file holds what is on screen in plain
/// text, so it is for throwaway vaults.
#[cfg(debug_assertions)]
#[tauri::command(async)]
fn dev_screen(text: String) -> CommandResult<bool> {
    let Some(path) = std::env::var_os("GLAZE_VAULT_SCREEN").map(PathBuf::from) else {
        return Ok(false);
    };
    // Written beside it and moved into place, so a reader never sees half a screen.
    let partial = path.with_extension("partial");
    fs::write(&partial, text).map_err(file_error)?;
    fs::rename(&partial, &path).map_err(file_error)?;
    Ok(true)
}

/// Whether this build has an updater public key. Builds without one (anyone's own build before
/// docs/releasing.md has been followed) leave the updater out rather than fail to start.
fn updater_configured(config: &tauri::Config) -> bool {
    config
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|pubkey| pubkey.as_str())
        .is_some_and(|pubkey| !pubkey.trim().is_empty())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let updates_configured = updater_configured(context.config());
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    if updates_configured {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .setup(move |app| {
            // The local, not roaming, app data folder: Windows domains can sync roaming profiles,
            // and a database being written must not be synced. GLAZE_VAULT_DIR puts the vault
            // somewhere else, for development and tests.
            let dir = match std::env::var_os("GLAZE_VAULT_DIR") {
                Some(dir) => PathBuf::from(dir),
                None => app.path().app_local_data_dir()?.join("vault"),
            };
            app.manage(AppState {
                dir,
                vault: Mutex::new(None),
                updates_configured,
                update: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            create_vault,
            unlock,
            recover,
            lock,
            change_password,
            new_recovery_key,
            list_records,
            save_record,
            record_history,
            get_settings,
            set_settings,
            lock_with_draft,
            get_draft,
            save_draft,
            clear_draft,
            last_backup,
            back_up,
            choose_backup,
            restore_backup,
            save_export,
            get_preferences,
            set_preferences,
            check_for_update,
            install_update,
            #[cfg(debug_assertions)]
            dev_screen
        ])
        .run(context)
        .expect("error while running Glaze Vault");
}
