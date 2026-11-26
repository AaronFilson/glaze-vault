//! The Tauri layer: commands that hand the UI's requests to the core, and nothing more
//! (docs/adr/0001-tauri-rust-react.md). File dialogs open from here, not from the page, so the
//! page never chooses where files are written.

mod backups;
#[cfg(debug_assertions)]
mod dev_tools;
mod dialogs;
mod network;
mod phone;
mod smoke;
mod syncing;
mod updates;

use dialogs::{file_name, open_dialog, save_dialog, save_picked};
use glaze_vault_core::{
    Attachment, AttachmentSigned, AuditLog, Capabilities, Collection, CustomRole, Error, Grant, Kind,
    MAX_ATTACHMENT_BYTES, Note, Person, Revision, Role, Settings, Vault,
};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewWindow};
#[cfg(desktop)]
use tauri_plugin_updater::Update;
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

#[tauri::command(async)]
fn vault_status(app: AppHandle, state: State<AppState>) -> VaultStatus {
    smoke::page_asked();
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

#[tauri::command(async)]
fn set_own_password(state: State<AppState>, new_password: String) -> CommandResult<Vec<String>> {
    let new_password = Zeroizing::new(new_password);
    with_vault(&state, |vault| Ok(vault.set_own_password(&new_password)?.words()))
}

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

#[tauri::command(async)]
fn take_admin_away(state: State<AppState>, person: Uuid) -> CommandResult<Vec<String>> {
    network::with_host(&state, |vault| Ok(vault.take_admin_away(person)?.words()))
}

#[tauri::command(async)]
fn new_organization_recovery_key(state: State<AppState>) -> CommandResult<Vec<String>> {
    network::with_host(&state, |vault| Ok(vault.new_organization_recovery_key()?.words()))
}

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
    collection: Option<Uuid>,
    content: serde_json::Value,
) -> CommandResult<Revision> {
    with_vault(&state, |vault| match (parent, collection) {
        (None, Some(collection)) => vault.save_in(kind, collection, &content),
        _ => vault.save(kind, parent, &content),
    })
}

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

#[tauri::command(async)]
fn delete_record(state: State<AppState>, kind: Kind, newest: Uuid) -> CommandResult<Revision> {
    with_vault(&state, |vault| vault.delete(kind, newest))
}

#[tauri::command(async)]
fn deleted_records(state: State<AppState>, kind: Kind) -> CommandResult<Vec<Revision>> {
    with_vault(&state, |vault| vault.deleted(kind))
}

#[tauri::command(async)]
fn resolve_fork(state: State<AppState>, kind: Kind, keep: Uuid, others: Vec<Uuid>) -> CommandResult<Revision> {
    with_vault(&state, |vault| vault.resolve_fork(kind, keep, &others))
}

#[tauri::command(async)]
fn move_records(state: State<AppState>, records: Vec<(Kind, Uuid)>, to: Uuid) -> CommandResult<()> {
    with_vault(&state, |vault| vault.move_records(&records, to))
}

#[tauri::command(async)]
fn note(state: State<AppState>, note: Note) -> CommandResult<()> {
    with_vault(&state, |vault| vault.note(note))
}

#[tauri::command(async)]
fn audit_log(state: State<AppState>, limit: Option<usize>) -> CommandResult<AuditLog> {
    with_vault(&state, |vault| vault.audit_log(limit))
}

#[tauri::command(async)]
fn erase_record(state: State<AppState>, kind: Kind, record_id: Uuid) -> CommandResult<usize> {
    with_vault(&state, |vault| vault.erase(kind, record_id))
}

const MAX_PHOTO_BYTES: u64 = 80 * 1024 * 1024;

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

#[tauri::command(async)]
fn get_attachment(state: State<AppState>, id: Uuid) -> CommandResult<tauri::ipc::Response> {
    with_vault(&state, |vault| vault.attachment(id))
        .map(|(_, mut bytes)| tauri::ipc::Response::new(std::mem::take(&mut *bytes)))
}

#[tauri::command(async)]
fn get_attachment_signed(state: State<AppState>, id: Uuid) -> CommandResult<Option<AttachmentSigned>> {
    with_vault(&state, |vault| vault.attachment_signed(id))
}

#[tauri::command(async)]
fn get_settings(state: State<AppState>) -> CommandResult<Settings> {
    with_vault(&state, |vault| vault.settings())
}

#[tauri::command(async)]
fn set_settings(state: State<AppState>, settings: Settings) -> CommandResult<()> {
    with_vault(&state, |vault| vault.set_settings(&settings))
}

#[tauri::command(async)]
fn lock_with_draft(state: State<AppState>, draft: serde_json::Value) -> CommandResult<()> {
    let mut vault = state.vault.lock().unwrap();
    let result = vault.as_mut().ok_or_else(locked)?.save_draft(&draft);
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

const MAX_IMPORT_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportFile {
    file_name: String,
    contents: String,
}

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

#[tauri::command(async)]
fn save_export(
    window: WebviewWindow,
    state: State<AppState>,
    suggested_name: String,
    contents: String,
) -> CommandResult<Option<String>> {
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
    save_picked(&window, &suggested_name, kind, extension, contents.as_bytes())
}

#[tauri::command(async)]
fn save_pdf(window: WebviewWindow, request: tauri::ipc::Request<'_>) -> CommandResult<Option<String>> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandError::new("bad-request", "The PDF came without its bytes."));
    };
    if !bytes.starts_with(b"%PDF-") {
        return Err(CommandError::new("bad-request", "That is not a PDF."));
    }
    let name = request
        .headers()
        .get("suggested-name")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| percent_encoding::percent_decode_str(v).decode_utf8().ok())
        .filter(|name| !name.contains(['/', '\\']) && name.ends_with(".pdf"))
        .map(|name| name.into_owned())
        .unwrap_or_else(|| "Glaze Vault.pdf".to_owned());
    save_picked(&window, &name, "PDF", "pdf", bytes)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let updates_configured = cfg!(desktop) && updates::updater_configured(context.config());
    #[cfg_attr(mobile, allow(unused_mut))]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "android")]
    {
        builder = builder.plugin(tauri_plugin_fs::init());
    }
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    }
    #[cfg(desktop)]
    if updates_configured {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .setup(move |app| {
            let dir = match std::env::var_os("GLAZE_VAULT_DIR") {
                Some(dir) => PathBuf::from(dir),
                None => {
                    let dir = app.path().app_local_data_dir()?.join("vault");
                    phone::prepare(&dir);
                    dir
                }
            };
            #[cfg(mobile)]
            app.add_capability(include_str!("../mobile/capabilities/scanner.json"))?;
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
            if let Some(result) = smoke::requested() {
                let dir = app.state::<AppState>().dir.clone();
                smoke::start(app.handle().clone(), dir, result);
            }
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
            get_attachment_signed,
            get_settings,
            set_settings,
            lock_with_draft,
            get_draft,
            save_draft,
            clear_draft,
            backups::last_backup,
            backups::back_up,
            backups::choose_backup,
            backups::restore_backup,
            backups::phone_backup_status,
            backups::phone_back_up,
            backups::phone_backups,
            choose_import,
            backups::set_aside_vaults,
            backups::bring_back_vault,
            save_export,
            save_pdf,
            updates::get_preferences,
            updates::set_preferences,
            updates::check_for_update,
            updates::install_update,
            network::network_status,
            network::sync_now,
            network::hosting::start_hosting,
            network::hosting::stop_hosting,
            network::pairing::start_pairing,
            network::pairing::wait_for_pairing,
            network::pairing::approve_pairing,
            network::pairing::cancel_pairing,
            network::admin::devices,
            network::sync_status,
            network::joining::discover_hosts,
            network::joining::prepare_join,
            network::joining::join_vault,
            network::joining::leave_vault,
            network::admin::checkouts,
            network::admin::check_out,
            network::admin::release_checkout,
            network::admin::offline_status,
            network::admin::extend_offline,
            network::admin::offline_policy,
            network::admin::set_offline_policy,
            network::admin::extension_code,
            network::admin::revoke_device,
            network::admin::host_backups,
            network::photos_on_demand,
            network::set_photos_on_demand,
            network::want_photo,
            network::joining::cancel_join,
            network::admin::restore_host_backup,
            network::admin::save_host_backup,
            network::admin::restore_host_from_file,
            network::hosting::move_host_here,
            #[cfg(debug_assertions)]
            dev_tools::dev_screen,
            #[cfg(debug_assertions)]
            dev_tools::dev_drive,
            #[cfg(debug_assertions)]
            dialogs::dev_pick,
            #[cfg(debug_assertions)]
            dev_tools::dev_wait
        ])
        .run(context)
        .expect("error while running Glaze Vault");
}
