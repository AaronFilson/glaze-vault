//! The Tauri layer: commands that hand the UI's requests to the core, and nothing more
//! (docs/adr/0001-tauri-rust-react.md). File dialogs open from here, not from the page, so the
//! page never chooses where files are written.

mod network;
mod phone;
mod syncing;

use glaze_vault_core::{
    Attachment, AuditLog, BACKUP_EXTENSION, Capabilities, Collection, Credential, CustomRole, Error, Grant, Kind,
    LastBackup, MAX_ATTACHMENT_BYTES, Note, OwnBackup, Person, Revision, Role, SetAside, Settings, Vault,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
#[cfg(desktop)]
use tauri_plugin_updater::{Update, UpdaterExt};
use uuid::Uuid;
use zeroize::Zeroizing;

struct AppState {
    dir: PathBuf,
    vault: Mutex<Option<Vault>>,
    /// False in builds made without an updater public key (crates/app/tauri.conf.json).
    updates_configured: bool,
    /// The update found by the last check, kept until it is installed.
    #[cfg(desktop)]
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

pub(crate) fn file_error(error: impl std::fmt::Display) -> CommandError {
    CommandError::new("io", format!("A file could not be read or written: {error}"))
}

#[cfg(desktop)]
fn update_error(error: tauri_plugin_updater::Error) -> CommandError {
    CommandError::new("update-failed", format!("Glaze Vault could not update: {error}"))
}

type CommandResult<T> = Result<T, CommandError>;

/// Runs `action` on the unlocked vault.
pub(crate) fn with_vault<T>(state: &AppState, action: impl FnOnce(&mut Vault) -> Result<T, Error>) -> CommandResult<T> {
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
    /// "desktop", "ios" or "android": what the page offers, and how it locks (ADR 27).
    platform: &'static str,
    /// A team's people, for the lock screen to choose from; empty for a one-person vault.
    people: Vec<Person>,
}

/// The kind of system this build runs on, for the page.
const PLATFORM: &str = if cfg!(target_os = "ios") {
    "ios"
} else if cfg!(target_os = "android") {
    "android"
} else {
    "desktop"
};

// Commands that derive keys from a password take a moment, so every command runs off the main
// thread (`async`), and the window stays responsive.

#[tauri::command(async)]
fn vault_status(app: AppHandle, state: State<AppState>) -> VaultStatus {
    VaultStatus {
        exists: Vault::exists(&state.dir),
        unlocked: state.vault.lock().unwrap().is_some(),
        version: app.package_info().version.to_string(),
        updates_configured: state.updates_configured,
        platform: PLATFORM,
        people: Vault::people_in(&state.dir).unwrap_or_default(),
    }
}

#[tauri::command(async)]
fn create_vault(state: State<AppState>, password: String) -> CommandResult<Vec<String>> {
    let password = Zeroizing::new(password);
    let (vault, recovery) = Vault::create(&state.dir, &password)?;
    *state.vault.lock().unwrap() = Some(vault);
    Ok(recovery.words())
}

/// Unlocks as `person`, who a team's vault needs; a one-person vault's is found without.
#[tauri::command(async)]
fn unlock(state: State<AppState>, person: Option<Uuid>, password: String) -> CommandResult<()> {
    let password = Zeroizing::new(password);
    let vault = Vault::unlock_as(&state.dir, person, &password)?;
    *state.vault.lock().unwrap() = Some(vault);
    Ok(())
}

#[tauri::command(async)]
fn recover(state: State<AppState>, person: Option<Uuid>, words: String, new_password: String) -> CommandResult<()> {
    let (words, new_password) = (Zeroizing::new(words), Zeroizing::new(new_password));
    let vault = Vault::recover_as(&state.dir, person, &words, &new_password)?;
    *state.vault.lock().unwrap() = Some(vault);
    Ok(())
}

/// With the organization's recovery key: gives an admin a new password, and returns their new
/// recovery key to show once (ADR 12).
#[tauri::command(async)]
fn recover_organization(
    state: State<AppState>,
    admin: Uuid,
    words: String,
    new_password: String,
) -> CommandResult<Vec<String>> {
    let (words, new_password) = (Zeroizing::new(words), Zeroizing::new(new_password));
    let (vault, recovery) = Vault::recover_organization(&state.dir, &words, admin, &new_password)?;
    *state.vault.lock().unwrap() = Some(vault);
    Ok(recovery.words())
}

/// Who unlocked the vault, whether it is a team's, and the collections they can open.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Access {
    team: bool,
    me: Person,
    collections: Vec<Collection>,
}

#[tauri::command(async)]
fn my_access(state: State<AppState>) -> CommandResult<Access> {
    with_vault(&state, |vault| {
        Ok(Access {
            team: vault.is_team(),
            me: vault.me(),
            collections: vault.collections(),
        })
    })
}

/// Everyone in a team's vault and their roles, for an admin.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Team {
    people: Vec<Person>,
    grants: Vec<Grant>,
}

#[tauri::command(async)]
fn team(state: State<AppState>) -> CommandResult<Team> {
    with_vault(&state, |vault| {
        Ok(Team {
            people: vault.people()?,
            grants: vault.grants()?,
        })
    })
}

/// Makes this vault a team's, with this person as admin. Returns the organization's recovery key.
#[tauri::command(async)]
fn grow_into_team(state: State<AppState>, name: String) -> CommandResult<Vec<String>> {
    with_vault(&state, |vault| Ok(vault.grow_into_team(&name)?.words()))
}

#[tauri::command(async)]
fn add_person(
    state: State<AppState>,
    name: String,
    one_time_password: String,
    roles: Vec<(Uuid, Role)>,
) -> CommandResult<Person> {
    let one_time_password = Zeroizing::new(one_time_password);
    network::with_host(&state, |vault| vault.add_person(&name, &one_time_password, &roles))
}

/// At a first sign-in: sets the password the person chose, and returns their recovery key.
#[tauri::command(async)]
fn set_own_password(state: State<AppState>, new_password: String) -> CommandResult<Vec<String>> {
    let new_password = Zeroizing::new(new_password);
    with_vault(&state, |vault| Ok(vault.set_own_password(&new_password)?.words()))
}

/// Gives a person a role on a collection, or takes it away with none.
#[tauri::command(async)]
fn set_role(state: State<AppState>, person: Uuid, collection: Uuid, role: Option<Role>) -> CommandResult<()> {
    network::with_host(&state, |vault| vault.set_role(person, collection, role))
}

#[tauri::command(async)]
fn remove_person(state: State<AppState>, person: Uuid) -> CommandResult<()> {
    network::with_host(&state, |vault| vault.remove_person(person))
}

#[tauri::command(async)]
fn reset_person(state: State<AppState>, person: Uuid, one_time_password: String) -> CommandResult<()> {
    let one_time_password = Zeroizing::new(one_time_password);
    network::with_host(&state, |vault| vault.reset_person(person, &one_time_password))
}

#[tauri::command(async)]
fn make_admin(state: State<AppState>, person: Uuid) -> CommandResult<()> {
    network::with_host(&state, |vault| vault.make_admin(person))
}

/// Takes admin away; returns the organization's new recovery words, to print.
#[tauri::command(async)]
fn take_admin_away(state: State<AppState>, person: Uuid) -> CommandResult<Vec<String>> {
    network::with_host(&state, |vault| Ok(vault.take_admin_away(person)?.words()))
}

/// A new organization recovery key, for a lost sheet; returns its words, to print.
#[tauri::command(async)]
fn new_organization_recovery_key(state: State<AppState>) -> CommandResult<Vec<String>> {
    network::with_host(&state, |vault| Ok(vault.new_organization_recovery_key()?.words()))
}

/// Makes a team's vault this admin's alone again (ADR 6). Returns where the backup made first is.
#[tauri::command(async)]
fn go_back_to_one_person(state: State<AppState>) -> CommandResult<String> {
    with_vault(&state, |vault| {
        Ok(vault.go_back_to_one_person()?.to_string_lossy().into_owned())
    })
}

#[tauri::command(async)]
fn create_collection(state: State<AppState>, name: String) -> CommandResult<Collection> {
    network::with_host(&state, |vault| vault.create_collection(&name))
}

#[tauri::command(async)]
fn rename_collection(state: State<AppState>, collection: Uuid, name: String) -> CommandResult<()> {
    network::with_host(&state, |vault| vault.rename_collection(collection, &name))
}

/// The roles admins have made, which anyone signed in sees named on their collections.
#[tauri::command(async)]
fn custom_roles(state: State<AppState>) -> CommandResult<Vec<CustomRole>> {
    with_vault(&state, |vault| Ok(vault.custom_roles()))
}

#[tauri::command(async)]
fn create_role(
    state: State<AppState>,
    name: String,
    changes: Vec<Kind>,
    may: Capabilities,
) -> CommandResult<CustomRole> {
    network::with_host(&state, |vault| vault.create_role(&name, &changes, may))
}

#[tauri::command(async)]
fn change_role(
    state: State<AppState>,
    id: Uuid,
    name: String,
    changes: Vec<Kind>,
    may: Capabilities,
) -> CommandResult<()> {
    network::with_host(&state, |vault| vault.change_role(id, &name, &changes, may))
}

#[tauri::command(async)]
fn delete_role(state: State<AppState>, id: Uuid) -> CommandResult<()> {
    network::with_host(&state, |vault| vault.delete_role(id))
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
/// Saves a revision after `parent`, or a new record, into `collection` when one is named.
fn save_record(
    state: State<AppState>,
    kind: Kind,
    parent: Option<Uuid>,
    collection: Option<Uuid>,
    content: serde_json::Value,
) -> CommandResult<Revision> {
    with_vault(&state, |vault| match (parent, collection) {
        (None, Some(collection)) => vault.save_in(kind, collection, &content),
        _ => vault.save(kind, parent, &content),
    })
}

/// Saves several revisions at once, all or none: for imports. New records go into `collection`.
#[tauri::command(async)]
fn save_records(
    state: State<AppState>,
    kind: Kind,
    collection: Option<Uuid>,
    revisions: Vec<(Option<Uuid>, serde_json::Value)>,
) -> CommandResult<Vec<Revision>> {
    with_vault(&state, |vault| vault.save_all(kind, collection, &revisions))
}

#[tauri::command(async)]
fn record_history(state: State<AppState>, kind: Kind, record_id: Uuid) -> CommandResult<Vec<Revision>> {
    with_vault(&state, |vault| vault.history(kind, record_id))
}

/// Deletes a record: it moves to the deleted ones, to restore or erase (ADR 9).
#[tauri::command(async)]
fn delete_record(state: State<AppState>, kind: Kind, newest: Uuid) -> CommandResult<Revision> {
    with_vault(&state, |vault| vault.delete(kind, newest))
}

#[tauri::command(async)]
fn deleted_records(state: State<AppState>, kind: Kind) -> CommandResult<Vec<Revision>> {
    with_vault(&state, |vault| vault.deleted(kind))
}

/// Ends a fork: keeps one of a record's newest revisions and sets the others aside (ADR 17).
#[tauri::command(async)]
fn resolve_fork(state: State<AppState>, kind: Kind, keep: Uuid, others: Vec<Uuid>) -> CommandResult<Revision> {
    with_vault(&state, |vault| vault.resolve_fork(kind, keep, &others))
}

/// Moves records, every revision and attachment of each, to another collection: a recipe with its
/// firings and batch sheets. All move, or none.
#[tauri::command(async)]
fn move_records(state: State<AppState>, records: Vec<(Kind, Uuid)>, to: Uuid) -> CommandResult<()> {
    with_vault(&state, |vault| vault.move_records(&records, to))
}

/// Tells the audit log what the page did: opened, printed or exported (ADR 19).
#[tauri::command(async)]
fn note(state: State<AppState>, note: Note) -> CommandResult<()> {
    with_vault(&state, |vault| vault.note(note))
}

/// The audit log, newest first: `limit` entries, or all of them. For an admin.
#[tauri::command(async)]
fn audit_log(state: State<AppState>, limit: Option<usize>) -> CommandResult<AuditLog> {
    with_vault(&state, |vault| vault.audit_log(limit))
}

/// Removes every revision of a deleted record. Returns how many there were.
#[tauri::command(async)]
fn erase_record(state: State<AppState>, kind: Kind, record_id: Uuid) -> CommandResult<usize> {
    with_vault(&state, |vault| vault.erase(kind, record_id))
}

/// Asks for a photo, and hands its bytes to the page, which makes it smaller before adding it
/// (ui/photos.ts). The bytes go as they are, not as JSON; none means the person cancelled.
#[tauri::command(async)]
fn choose_photo(window: WebviewWindow, state: State<AppState>) -> CommandResult<tauri::ipc::Response> {
    if state.vault.lock().unwrap().is_none() {
        return Err(locked());
    }
    let Some(path) = open_dialog(
        &window,
        "Choose a photo",
        "Photos",
        &["jpg", "jpeg", "png", "heic", "heif", "webp", "gif"],
    )?
    else {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    };
    if fs::metadata(&path).map_err(file_error)?.len() > MAX_PHOTO_BYTES {
        return Err(CommandError::new(
            "too-large",
            "That photo is too large. Choose one under 80 MB.",
        ));
    }
    Ok(tauri::ipc::Response::new(fs::read(&path).map_err(file_error)?))
}

/// The largest photo file the page is given to make smaller.
const MAX_PHOTO_BYTES: u64 = 80 * 1024 * 1024;

/// Adds a file to a record. The body is the file's bytes; the headers say which record (kind
/// and record-id) and what it is (media-type).
#[tauri::command(async)]
fn add_attachment(state: State<AppState>, request: tauri::ipc::Request<'_>) -> CommandResult<Attachment> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::new(
            "bad-request",
            "The attachment came without its bytes.",
        ));
    };
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(Error::TooLarge.into());
    }
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| CommandError::new("bad-request", format!("The attachment came without {name}.")))
    };
    let kind: Kind = serde_json::from_value(serde_json::Value::String(header("kind")?))
        .map_err(|_| CommandError::new("bad-request", "Unknown kind of record."))?;
    let record_id =
        Uuid::parse_str(&header("record-id")?).map_err(|_| CommandError::new("bad-request", "Unknown record."))?;
    let media_type = header("media-type")?;
    with_vault(&state, |vault| {
        vault.add_attachment(kind, record_id, &media_type, bytes)
    })
}

/// An attachment's bytes, as they are, not as JSON.
#[tauri::command(async)]
fn get_attachment(state: State<AppState>, id: Uuid) -> CommandResult<tauri::ipc::Response> {
    // Moved out of the wiped buffer rather than copied, so there is one plaintext copy, not two.
    // Tauri frees it once the page has it, without wiping it.
    with_vault(&state, |vault| vault.attachment(id))
        .map(|(_, mut bytes)| tauri::ipc::Response::new(std::mem::take(&mut *bytes)))
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
struct PhoneBackups {
    /// Whether this vault backs itself up at all: its own, not a replica, with the setting on,
    /// and in a team, the person an admin.
    on: bool,
    last: Option<OwnBackup>,
    /// What the phone's own backup takes of the app, if it limits it (Android).
    budget: Option<u64>,
}

/// A phone's own vault and its backups (docs/adr/0028-a-phones-own-vault.md). None on desktops and
/// on replicas, which never make these.
#[tauri::command(async)]
fn phone_backup_status(state: State<AppState>) -> CommandResult<Option<PhoneBackups>> {
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

/// Backs a phone's own vault up into the folder its system backup takes, if one is due. The
/// page asks at unlock, on going into the background, and hourly; the core decides.
#[tauri::command(async)]
fn phone_back_up(state: State<AppState>) -> CommandResult<Option<OwnBackup>> {
    if !phone::OWN_BACKUPS {
        return Ok(None);
    }
    let folder = phone::backups_folder(&state.dir);
    with_vault(&state, |vault| vault.back_up_own(&folder, phone::BUDGET))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhoneBackup {
    #[serde(flatten)]
    backup: ChosenBackup,
    photos: bool,
}

/// The backups a phone's own vault left on it, newest first, to restore from at setup: after
/// the phone itself was restored from iCloud or Google, the vault is gone but these came back.
#[tauri::command(async)]
fn phone_backups(state: State<AppState>) -> CommandResult<Vec<PhoneBackup>> {
    if !phone::OWN_BACKUPS {
        return Ok(Vec::new());
    }
    let mut found = Vec::new();
    for (path, own) in Vault::own_backups(&phone::backups_folder(&state.dir))? {
        // One that does not open is left out rather than offered.
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
struct ChosenBackup {
    path: String,
    file_name: String,
    created_at: i64,
    app_version: String,
    /// For a team's backup, the admins who can restore it.
    admins: Vec<Person>,
}

/// Asks for a backup file to restore, and says when it was made.
#[tauri::command(async)]
fn choose_backup(window: WebviewWindow) -> CommandResult<Option<ChosenBackup>> {
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
struct Restored {
    /// Where the vault that was replaced was moved to, if there was one.
    set_aside: Option<String>,
    /// After restoring with the organization's recovery key, the admin's new recovery key.
    recovery_words: Option<Vec<String>>,
}

/// Restores a backup as `person` (an admin, for a team's), with their password or recovery key, or
/// with the organization's recovery key when `organization` is set.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn restore_backup(
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
    // The vault's files are about to be moved, so it must not be open.
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

/// The largest file import reads: far more than any recipe list, and a stop for the wrong file.
const MAX_IMPORT_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportFile {
    file_name: String,
    contents: String,
}

/// Asks for a file of recipes or materials to import, and reads it for the page to parse
/// (ui/importFormats.ts). None if the person cancelled. Text that is not UTF-8, as older programs
/// write, is read as Latin-1, which keeps their accented letters.
#[tauri::command(async)]
fn choose_import(window: WebviewWindow, state: State<AppState>) -> CommandResult<Option<ImportFile>> {
    if state.vault.lock().unwrap().is_none() {
        return Err(locked());
    }
    let Some(path) = open_dialog(
        &window,
        "Choose recipes or materials to import",
        "Recipes and materials",
        &["json", "xml", "csv", "txt", "glz", "mat", "rcx"],
    )?
    else {
        return Ok(None);
    };
    if fs::metadata(&path).map_err(file_error)?.len() > MAX_IMPORT_BYTES {
        return Err(CommandError::new(
            "too-large",
            "That file is too large to import: recipes and materials take far less.",
        ));
    }
    let bytes = fs::read(&path).map_err(file_error)?;
    let contents =
        String::from_utf8(bytes).unwrap_or_else(|error| error.into_bytes().iter().map(|&byte| byte as char).collect());
    Ok(Some(ImportFile {
        file_name: file_name(&path),
        contents,
    }))
}

/// The vaults a restore set aside, to switch back to.
#[tauri::command(async)]
fn set_aside_vaults(state: State<AppState>) -> CommandResult<Vec<SetAside>> {
    Ok(Vault::set_aside(&state.dir)?)
}

/// Locks the vault, and swaps it with one a restore set aside. The page then asks for that
/// vault's password.
#[tauri::command(async)]
fn bring_back_vault(state: State<AppState>, name: String) -> CommandResult<Restored> {
    let mut vault = state.vault.lock().unwrap();
    // Switching replaces everyone's vault, so in a team only an admin may, signed in. The vault on
    // disk is what counts, since a locked one is not open to ask.
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

/// Asks where to save an export the page has made (CSV or JSON), then writes it. Returns the file
/// name, or None if the person cancelled.
#[tauri::command(async)]
fn save_export(
    window: WebviewWindow,
    state: State<AppState>,
    suggested_name: String,
    contents: String,
) -> CommandResult<Option<String>> {
    // The page leaves out what this person may not export; nobody who may export nothing writes one.
    match &*state.vault.lock().unwrap() {
        None => return Err(locked()),
        Some(vault) if !vault.may_export() => return Err(Error::NotAllowed.into()),
        Some(_) => {}
    }
    let (kind, extension) = match Path::new(&suggested_name).extension().and_then(|e| e.to_str()) {
        Some("csv") => ("CSV spreadsheet", "csv"),
        Some("json") => ("JSON", "json"),
        Some("xml") => ("Insight XML", "xml"),
        _ => return Err(CommandError::new("bad-request", "Exports are CSV, JSON or XML.")),
    };
    let Some(path) = save_dialog(&window, &suggested_name, kind, extension)? else {
        return Ok(None);
    };
    fs::write(&path, contents).map_err(file_error)?;
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

/// Development builds only: the file a script chose for the next dialog, in place of asking
/// (`pick` in ui/devDriver.ts), so imports, backups and restores can be driven.
#[cfg(debug_assertions)]
static DEV_PICK: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Whether no file was chosen by a script for the next dialog, so a real one is shown.
#[cfg(target_os = "android")]
fn dev_picked_none() -> bool {
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
fn dev_pick(path: String) {
    *DEV_PICK.lock().unwrap() = Some(PathBuf::from(path));
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
#[cfg(desktop)]
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
#[cfg(desktop)]
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

/// Phones and tablets: their app store updates them.
#[cfg(mobile)]
#[tauri::command]
async fn check_for_update() -> CommandResult<Option<UpdateInfo>> {
    Err(updates_from_the_store())
}

#[cfg(mobile)]
#[tauri::command]
async fn install_update() -> CommandResult<()> {
    Err(updates_from_the_store())
}

#[cfg(mobile)]
fn updates_from_the_store() -> CommandError {
    CommandError::new(
        "updates-not-configured",
        "Glaze Vault is updated by the app store on phones and tablets.",
    )
}

/// Development builds only: writes the page's text picture of the screen (ui/devTools.ts) to the
/// file GLAZE_VAULT_SCREEN names, so the app can be followed without screenshots. Says when no
/// file is named, and the page stops sending. The file holds what is on screen in plain text, so
/// it is for throwaway vaults.
#[cfg(debug_assertions)]
#[tauri::command(async)]
fn dev_screen(text: String) -> CommandResult<ScreenFile> {
    let show_secrets = std::env::var("GLAZE_VAULT_SHOW_SECRETS").is_ok_and(|value| value == "1");
    let Some(path) = std::env::var_os("GLAZE_VAULT_SCREEN").map(PathBuf::from) else {
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

#[cfg(debug_assertions)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenFile {
    written: bool,
    /// GLAZE_VAULT_SHOW_SECRETS=1: show passwords and recovery words too, for scripts that set up
    /// a throwaway vault.
    show_secrets: bool,
}

/// Development builds only: takes the script in the file GLAZE_VAULT_DRIVE names, if there is
/// one, for the page to run (ui/devDriver.ts). Fails when no file is named, and the page stops
/// asking.
#[cfg(debug_assertions)]
#[tauri::command(async)]
fn dev_drive() -> CommandResult<Option<String>> {
    let Some(path) = std::env::var_os("GLAZE_VAULT_DRIVE").map(PathBuf::from) else {
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
/// window is hidden or the display sleeps (WebKit throttles them, and macOS before 14 cannot turn
/// that off), but answers from the core still come, so the dev tools wait with this.
#[cfg(debug_assertions)]
#[tauri::command]
async fn dev_wait(ms: u64) {
    let _ =
        tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await;
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
    let updates_configured = cfg!(desktop) && updater_configured(context.config());
    #[cfg_attr(mobile, allow(unused_mut))]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    // Android: writing a backup where the file picker points (docs/adr/0028-a-phones-own-vault.md).
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_fs::init());
    }
    #[cfg(desktop)]
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
                None => {
                    let dir = app.path().app_local_data_dir()?.join("vault");
                    phone::prepare(&dir);
                    dir
                }
            };
            app.manage(network::Network::default());
            app.manage(std::sync::Arc::new(syncing::Syncing::default()));
            app.manage(AppState {
                dir,
                vault: Mutex::new(None),
                updates_configured,
                #[cfg(desktop)]
                update: Mutex::new(None),
            });
            syncing::start(app.handle().clone());
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
            recover_organization,
            my_access,
            team,
            grow_into_team,
            add_person,
            set_own_password,
            set_role,
            remove_person,
            reset_person,
            make_admin,
            take_admin_away,
            new_organization_recovery_key,
            go_back_to_one_person,
            create_collection,
            rename_collection,
            custom_roles,
            create_role,
            change_role,
            delete_role,
            list_records,
            save_record,
            save_records,
            record_history,
            delete_record,
            deleted_records,
            resolve_fork,
            erase_record,
            move_records,
            note,
            audit_log,
            choose_photo,
            add_attachment,
            get_attachment,
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
            phone_backup_status,
            phone_back_up,
            phone_backups,
            choose_import,
            set_aside_vaults,
            bring_back_vault,
            save_export,
            get_preferences,
            set_preferences,
            check_for_update,
            install_update,
            network::network_status,
            network::sync_now,
            network::start_hosting,
            network::stop_hosting,
            network::start_pairing,
            network::wait_for_pairing,
            network::approve_pairing,
            network::cancel_pairing,
            network::devices,
            network::sync_status,
            network::discover_hosts,
            network::prepare_join,
            network::join_vault,
            network::leave_vault,
            network::checkouts,
            network::check_out,
            network::release_checkout,
            network::offline_status,
            network::extend_offline,
            network::offline_policy,
            network::set_offline_policy,
            network::extension_code,
            network::revoke_device,
            network::host_backups,
            network::photos_on_demand,
            network::set_photos_on_demand,
            network::want_photo,
            network::cancel_join,
            network::restore_host_backup,
            network::save_host_backup,
            network::restore_host_from_file,
            #[cfg(debug_assertions)]
            dev_screen,
            #[cfg(debug_assertions)]
            dev_drive,
            #[cfg(debug_assertions)]
            dev_pick,
            #[cfg(debug_assertions)]
            dev_wait
        ])
        .run(context)
        .expect("error while running Glaze Vault");
}
