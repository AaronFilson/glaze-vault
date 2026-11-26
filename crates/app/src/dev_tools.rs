//! Development-only screen and driver file commands (docs/adr/0011-end-to-end-tests.md).

use crate::{AppState, CommandError, CommandResult, file_error};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::State;

/// Development builds only: the screen or driver file. On a computer GLAZE_VAULT_SCREEN and
/// GLAZE_VAULT_DRIVE name them. A phone's app is started with no environment of its own, so there
/// they are always in `dev/` beside the vault folder, where the phone suite (e2e/phone.ts) reads
/// and writes them with `adb` or `simctl` (ADR 11).
fn dev_file(state: &AppState, variable: &str, name: &str) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(variable) {
        return Some(PathBuf::from(path));
    }
    #[cfg(mobile)]
    {
        let dir = state.dir.parent()?.join("dev");
        fs::create_dir_all(&dir).ok()?;
        Some(dir.join(name))
    }
    #[cfg(desktop)]
    {
        let _ = (state, name);
        None
    }
}

/// Development builds only: writes the page's text picture of the screen (ui/devTools.ts) to the
/// screen file ([`dev_file`]), so the app can be followed without screenshots.
#[tauri::command(async)]
pub(crate) fn dev_screen(state: State<'_, AppState>, text: String) -> CommandResult<ScreenFile> {
    let show_secrets = cfg!(mobile) || std::env::var("GLAZE_VAULT_SHOW_SECRETS").is_ok_and(|value| value == "1");
    let Some(path) = dev_file(&state, "GLAZE_VAULT_SCREEN", "screen.txt") else {
        return Ok(ScreenFile {
            written: false,
            show_secrets,
        });
    };
    // Written beside it and moved into place, so a reader never sees half a screen.
    let partial = path.with_extension("partial");
    fs::write(&partial, text).map_err(file_error)?;
    fs::rename(&partial, &path).map_err(file_error)?;
    Ok(ScreenFile {
        written: true,
        show_secrets,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenFile {
    written: bool,
    /// GLAZE_VAULT_SHOW_SECRETS=1: show passwords and recovery words too, for scripts that set up
    /// a throwaway vault.
    show_secrets: bool,
}

/// Development builds only: takes the script in the driver file ([`dev_file`]), if there is one,
/// for the page to run (ui/devDriver.ts).
#[tauri::command(async)]
pub(crate) fn dev_drive(state: State<'_, AppState>) -> CommandResult<Option<String>> {
    let Some(path) = dev_file(&state, "GLAZE_VAULT_DRIVE", "drive.txt") else {
        return Err(CommandError::new("off", "GLAZE_VAULT_DRIVE is not set."));
    };
    // Moved aside first, so a script written while this one is read is not lost or run twice.
    let taken = path.with_extension("taken");
    if fs::rename(&path, &taken).is_err() {
        return Ok(None);
    }
    let script = fs::read_to_string(&taken).map_err(file_error)?;
    fs::remove_file(&taken).map_err(file_error)?;
    Ok(Some(script))
}

/// Development builds only: answers after `ms`. The page's own timers nearly stop while its
/// window is hidden or the display sleeps, so the dev tools wait with this.
#[tauri::command]
pub(crate) async fn dev_wait(ms: u64) {
    let _ =
        tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await;
}
