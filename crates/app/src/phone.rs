//! The vault's folder on a phone (docs/adr/0027-phones.md). On iOS it is kept out of iCloud and
//! device backups, and its files are unreadable while the phone is locked; the `backups` folder
//! beside it, which stage 3 fills with finished backups, is left for the system to back up. On
//! Android the app's own storage is private already, and the backup rules are in the manifest
//! (crates/app/mobile/android). A phone's own vault backs itself up into that folder
//! (docs/adr/0028-a-phones-own-vault.md).

use std::path::{Path, PathBuf};

/// Whether this build's own vault backs itself up where the phone's backup takes it.
pub const OWN_BACKUPS: bool = cfg!(mobile);

/// What the backups folder may hold in all: Android's own backup takes at most 25 MB of an app,
/// and drops all of it when there is more. iCloud has no such limit.
pub const BUDGET: Option<u64> = if cfg!(target_os = "android") {
    Some(24 * 1024 * 1024)
} else {
    None
};

/// The folder beside the vault's that the phone's own backup takes.
pub fn backups_folder(vault_dir: &Path) -> PathBuf {
    vault_dir.with_file_name("backups")
}

/// Android: a backup saved where the person chose in the system's file picker, which hands back
/// a `content://` address rather than a path. The backup is written in the app's cache under the
/// name chosen, then copied there. Returns None if the person cancelled.
#[cfg(target_os = "android")]
pub fn back_up_to_picked(
    window: &tauri::WebviewWindow,
    vault: &mut glaze_vault_core::Vault,
    suggested_name: &str,
) -> Result<Option<glaze_vault_core::LastBackup>, crate::CommandError> {
    use tauri::Manager;
    use tauri_plugin_dialog::{DialogExt, FilePath};
    use tauri_plugin_fs::{FsExt, OpenOptions};

    let Some(picked) = window
        .dialog()
        .file()
        .set_file_name(suggested_name)
        .add_filter("Glaze Vault backup", &[glaze_vault_core::BACKUP_EXTENSION])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    if let FilePath::Path(path) = &picked {
        return Ok(Some(vault.back_up(path)?));
    }
    let cache = window.path().app_cache_dir().map_err(crate::file_error)?;
    std::fs::create_dir_all(&cache).map_err(crate::file_error)?;
    let staged = cache.join(suggested_name);
    let made = vault.back_up(&staged);
    let copied = made.as_ref().ok().map(|_| {
        let mut options = OpenOptions::new();
        options.write(true).truncate(true);
        window
            .fs()
            .open(picked, options)
            .and_then(|mut out| std::io::copy(&mut std::fs::File::open(&staged)?, &mut out))
    });
    let _ = std::fs::remove_file(&staged);
    let last = made?;
    copied.transpose().map_err(crate::file_error)?;
    Ok(Some(last))
}

/// Run once at start, before the vault is opened.
#[cfg(target_os = "ios")]
pub fn prepare(dir: &Path) {
    if let Err(error) = std::fs::create_dir_all(dir) {
        eprintln!("The vault's folder could not be made: {error}");
        return;
    }
    if let Err(error) = ios::keep_out_of_backups(dir) {
        eprintln!("The vault's folder could not be kept out of backups: {error}");
    }
    // New files take their folder's protection, so this is for files from before.
    protect_all(dir);
}

#[cfg(not(target_os = "ios"))]
pub fn prepare(_dir: &Path) {}

#[cfg(target_os = "ios")]
fn protect_all(path: &Path) {
    if let Err(error) = ios::protect(path) {
        eprintln!("{} could not be protected: {error}", path.display());
    }
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            protect_all(&entry.path());
        }
    }
}

#[cfg(target_os = "ios")]
mod ios {
    use objc2_foundation::{
        NSDictionary, NSFileManager, NSFileProtectionComplete, NSFileProtectionKey, NSNumber, NSString, NSURL,
        NSURLIsExcludedFromBackupKey,
    };
    use std::path::Path;

    /// Marks the folder, and so everything in it, as not for iCloud or device backups.
    pub fn keep_out_of_backups(dir: &Path) -> Result<(), String> {
        let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&dir.to_string_lossy()), true);
        let yes = NSNumber::numberWithBool(true);
        // SAFETY: the backup key takes an NSNumber holding a bool.
        unsafe { url.setResourceValue_forKey_error(Some(&yes), NSURLIsExcludedFromBackupKey) }
            .map_err(|error| error.localizedDescription().to_string())
    }

    /// Makes the file or folder unreadable while the phone is locked.
    pub fn protect(path: &Path) -> Result<(), String> {
        // SAFETY: the protection key takes one of the NSFileProtectionType strings.
        let attributes =
            unsafe { NSDictionary::from_slices(&[NSFileProtectionKey], &[NSFileProtectionComplete.as_ref()]) };
        let path = NSString::from_str(&path.to_string_lossy());
        // SAFETY: the attributes are a file attribute key and its value's type.
        unsafe { NSFileManager::defaultManager().setAttributes_ofItemAtPath_error(&attributes, &path) }
            .map_err(|error| error.localizedDescription().to_string())
    }
}
