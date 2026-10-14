//! The Tauri layer: commands that hand the UI's requests to the core, and nothing more
//! (docs/adr/0001-tauri-rust-react.md).

use glaze_vault_core::{Error, RecipeHead, Vault};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};
use uuid::Uuid;
use zeroize::Zeroizing;

struct AppState {
    dir: PathBuf,
    vault: Mutex<Option<Vault>>,
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

fn locked() -> CommandError {
    CommandError {
        code: "locked",
        message: "The vault is locked.".into(),
    }
}

type CommandResult<T> = Result<T, CommandError>;

#[derive(Serialize)]
struct VaultStatus {
    exists: bool,
    unlocked: bool,
}

// Commands that derive keys from a password take a moment, so every command runs off the main
// thread (`async`), and the window stays responsive.

#[tauri::command(async)]
fn vault_status(state: State<AppState>) -> VaultStatus {
    VaultStatus {
        exists: Vault::exists(&state.dir),
        unlocked: state.vault.lock().unwrap().is_some(),
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
    let mut vault = state.vault.lock().unwrap();
    Ok(vault
        .as_mut()
        .ok_or_else(locked)?
        .change_password(&current, &new_password)?)
}

#[tauri::command(async)]
fn list_recipes(state: State<AppState>) -> CommandResult<Vec<RecipeHead>> {
    let vault = state.vault.lock().unwrap();
    Ok(vault.as_ref().ok_or_else(locked)?.recipes()?)
}

#[tauri::command(async)]
fn save_recipe(state: State<AppState>, parent: Option<Uuid>, content: serde_json::Value) -> CommandResult<RecipeHead> {
    let mut vault = state.vault.lock().unwrap();
    Ok(vault.as_mut().ok_or_else(locked)?.save_recipe(parent, &content)?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
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
            list_recipes,
            save_recipe
        ])
        .run(tauri::generate_context!())
        .expect("error while running Glaze Vault");
}
