//! Tauri commands for personal backups, phone system backups, restoring, and vaults set aside.

#[cfg(target_os = "android")]
use crate::dialogs::dev_picked_none;
use crate::dialogs::{file_name, open_dialog, save_dialog};
use crate::{AppState, CommandError, CommandResult, locked, phone, with_vault};
use glaze_vault_core::{BACKUP_EXTENSION, Credential, Error, LastBackup, OwnBackup, Person, SetAside, Vault};
use serde::Serialize;
use std::path::Path;
use tauri::{State, WebviewWindow};
use uuid::Uuid;
use zeroize::Zeroizing;

#[tauri::command(async)]
pub(crate) fn last_backup(state: State<AppState>) -> CommandResult<Option<LastBackup>> {
    with_vault(&state, |vault| vault.last_backup())
}

/// Asks where to save a backup, then writes it. None if the person cancelled.
#[tauri::command(async)]
pub(crate) fn back_up(
    window: WebviewWindow,
    state: State<AppState>,
    suggested_name: String,
) -> CommandResult<Option<LastBackup>> {
    if state.vault.lock().unwrap().is_none() {
        return Err(locked());
    }
    // Android's file picker hands back an address to write through, not a path.
    #[cfg(target_os = "android")]
    if dev_picked_none() {
        let mut vault = state.vault.lock().unwrap();
        return phone::back_up_to_picked(&window, vault.as_mut().ok_or_else(locked)?, &suggested_name);
    }
    let Some(path) = save_dialog(&window, &suggested_name, "Glaze Vault backup", BACKUP_EXTENSION)? else {
        return Ok(None);
    };
    with_vault(&state, |vault| vault.back_up(&path).map(Some))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhoneBackups {
    on: bool,
    last: Option<OwnBackup>,
    budget: Option<u64>,
}

/// A phone's own vault and its backups (docs/adr/0028-a-phones-own-vault.md).
#[tauri::command(async)]
pub(crate) fn phone_backup_status(state: State<AppState>) -> CommandResult<Option<PhoneBackups>> {
    if !phone::OWN_BACKUPS {
        return Ok(None);
    }
    with_vault(&state, |vault| {
        if vault.is_replica() {
            return Ok(None);
        }
        Ok(Some(PhoneBackups {
            on: vault.may_back_up_own()?,
            last: vault.last_own_backup()?,
            budget: phone::BUDGET,
        }))
    })
}

/// Backs a phone's own vault up into the folder its system backup takes, if one is due.
#[tauri::command(async)]
pub(crate) fn phone_back_up(state: State<AppState>) -> CommandResult<Option<OwnBackup>> {
    if !phone::OWN_BACKUPS {
        return Ok(None);
    }
    let folder = phone::backups_folder(&state.dir);
    with_vault(&state, |vault| vault.back_up_own(&folder, phone::BUDGET))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhoneBackup {
    #[serde(flatten)]
    backup: ChosenBackup,
    photos: bool,
}

/// The backups a phone's own vault left on it, newest first, to restore from at setup.
#[tauri::command(async)]
pub(crate) fn phone_backups(state: State<AppState>) -> CommandResult<Vec<PhoneBackup>> {
    if !phone::OWN_BACKUPS {
        return Ok(Vec::new());
    }
    let mut found = Vec::new();
    for (path, own) in Vault::own_backups(&phone::backups_folder(&state.dir))? {
        let Ok(info) = Vault::backup_info(&path) else { continue };
        found.push(PhoneBackup {
            backup: ChosenBackup {
                path: path.to_string_lossy().into_owned(),
                file_name: own.file_name,
                created_at: info.created_at,
                app_version: info.app_version,
                admins: info.admins,
            },
            photos: own.photos,
        });
    }
    Ok(found)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChosenBackup {
    path: String,
    file_name: String,
    created_at: i64,
    app_version: String,
    /// For a team's backup, the admins who can restore it.
    admins: Vec<Person>,
}

/// Asks for a backup file to restore, and says when it was made.
#[tauri::command(async)]
pub(crate) fn choose_backup(window: WebviewWindow) -> CommandResult<Option<ChosenBackup>> {
    let Some(path) = open_dialog(
        &window,
        "Choose a backup to restore",
        "Glaze Vault backup",
        &[BACKUP_EXTENSION],
    )?
    else {
        return Ok(None);
    };
    let info = Vault::backup_info(&path)?;
    Ok(Some(ChosenBackup {
        file_name: file_name(&path),
        path: path.to_string_lossy().into_owned(),
        created_at: info.created_at,
        app_version: info.app_version,
        admins: info.admins,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Restored {
    /// Where the vault that was replaced was moved to, if there was one.
    set_aside: Option<String>,
    /// After restoring with the organization's recovery key, the admin's new recovery key.
    recovery_words: Option<Vec<String>>,
}

/// Restores a backup as `person` (an admin, for a team's), with their password or recovery key, or
/// with the organization's recovery key when `organization` is set.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn restore_backup(
    state: State<AppState>,
    path: String,
    person: Option<Uuid>,
    password: Option<String>,
    words: Option<String>,
    new_password: Option<String>,
    organization: Option<bool>,
) -> CommandResult<Restored> {
    let (password, words, new_password) = (
        password.map(Zeroizing::new),
        words.map(Zeroizing::new),
        new_password.map(Zeroizing::new),
    );
    let bad_request = || CommandError::new("bad-request", "Give a password, or a recovery key and a new password.");
    let mut vault = state.vault.lock().unwrap();
    if organization.unwrap_or(false) {
        let (Some(words), Some(new_password), Some(admin)) = (&words, &new_password, person) else {
            return Err(bad_request());
        };
        vault.take();
        let (restored, set_aside, recovery) =
            Vault::restore_by_organization(&state.dir, Path::new(&path), words, admin, new_password)?;
        *vault = Some(restored);
        return Ok(Restored {
            set_aside: set_aside.map(|dir| dir.to_string_lossy().into_owned()),
            recovery_words: Some(recovery.words()),
        });
    }
    let credential = match (&password, &words, &new_password) {
        (Some(password), None, None) => Credential::Password(password),
        (None, Some(words), Some(new_password)) => Credential::RecoveryKey { words, new_password },
        _ => return Err(bad_request()),
    };
    vault.take();
    let (restored, set_aside) = Vault::restore(&state.dir, Path::new(&path), person, &credential)?;
    *vault = Some(restored);
    Ok(Restored {
        set_aside: set_aside.map(|dir| dir.to_string_lossy().into_owned()),
        recovery_words: None,
    })
}

/// The vaults a restore set aside, to switch back to.
#[tauri::command(async)]
pub(crate) fn set_aside_vaults(state: State<AppState>) -> CommandResult<Vec<SetAside>> {
    Ok(Vault::set_aside(&state.dir)?)
}

/// Locks the vault, and swaps it with one a restore set aside.
#[tauri::command(async)]
pub(crate) fn bring_back_vault(state: State<AppState>, name: String) -> CommandResult<Restored> {
    let mut vault = state.vault.lock().unwrap();
    let admin = vault.as_ref().is_some_and(|open| open.me().admin);
    if !admin && !Vault::people_in(&state.dir).unwrap_or_default().is_empty() {
        return Err(Error::NotAnAdminHere.into());
    }
    vault.take();
    let set_aside = Vault::bring_back(&state.dir, &name)?;
    Ok(Restored {
        set_aside: set_aside.map(|dir| dir.to_string_lossy().into_owned()),
        recovery_words: None,
    })
}
