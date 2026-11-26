//! Native file dialogs and scripted file picks for development tests.

#[cfg(target_os = "android")]
use crate::phone;
use crate::{CommandError, CommandResult, file_error};
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(debug_assertions)]
use std::sync::Mutex;
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;

/// Development builds only: the file a script chose for the next dialog, in place of asking
/// (`pick` in ui/devDriver.ts), so imports, backups and restores can be driven.
#[cfg(debug_assertions)]
static DEV_PICK: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Whether no file was chosen by a script for the next dialog, so a real one is shown.
#[cfg(target_os = "android")]
pub(crate) fn dev_picked_none() -> bool {
    #[cfg(debug_assertions)]
    return DEV_PICK.lock().unwrap().is_none();
    #[cfg(not(debug_assertions))]
    true
}

fn dev_picked() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    return DEV_PICK.lock().unwrap().take();
    #[cfg(not(debug_assertions))]
    None
}

#[cfg(debug_assertions)]
#[tauri::command(async)]
pub(crate) fn dev_pick(path: String) {
    *DEV_PICK.lock().unwrap() = Some(PathBuf::from(path));
}

/// Asks where to save, then writes `bytes` there. Returns the file name, or None if the person
/// cancelled. On Android the picker hands back an address to write through, not a path.
pub(crate) fn save_picked(
    window: &WebviewWindow,
    suggested_name: &str,
    kind: &str,
    extension: &str,
    bytes: &[u8],
) -> CommandResult<Option<String>> {
    #[cfg(target_os = "android")]
    if dev_picked_none() {
        return phone::write_to_picked(window, suggested_name, kind, extension, bytes);
    }
    let Some(path) = save_dialog(window, suggested_name, kind, extension)? else {
        return Ok(None);
    };
    fs::write(&path, bytes).map_err(file_error)?;
    Ok(Some(file_name(&path)))
}

/// Asks for a file to open.
pub(crate) fn open_dialog(
    window: &WebviewWindow,
    title: &str,
    kind: &str,
    extensions: &[&str],
) -> CommandResult<Option<PathBuf>> {
    if let Some(path) = dev_picked() {
        return Ok(Some(path));
    }
    let dialog = window.dialog().file();
    // Phones and tablets have no windows to put the dialog over.
    #[cfg(desktop)]
    let dialog = dialog.set_parent(window);
    let picked = dialog
        .set_title(title)
        .add_filter(kind, extensions)
        .blocking_pick_file();
    picked.map(|p| p.into_path().map_err(file_error)).transpose()
}

pub(crate) fn save_dialog(
    window: &WebviewWindow,
    suggested_name: &str,
    kind: &str,
    extension: &str,
) -> CommandResult<Option<PathBuf>> {
    if let Some(path) = dev_picked() {
        return Ok(Some(path));
    }
    let dialog = window.dialog().file();
    #[cfg(desktop)]
    let dialog = dialog.set_parent(window);
    let picked = dialog
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

pub(crate) fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}
