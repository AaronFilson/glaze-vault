//! The vault's folder on a phone (docs/adr/0027-phones.md). On iOS it is kept out of iCloud and
//! device backups, and its files are unreadable while the phone is locked; the `backups` folder
//! beside it, which stage 3 fills with finished backups, is left for the system to back up. On
//! Android the app's own storage is private already, and the backup rules are in the manifest
//! (crates/app/mobile/android).

use std::path::Path;

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
