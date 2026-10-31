//! A phone's own vault backs itself up (docs/adr/0028-a-phones-own-vault.md): on a day it was
//! changed, a backup goes into a folder that the phone's own backup (iCloud, Google) takes, and
//! the newest [`OWN_BACKUPS_KEPT`] stay. Each is written under a temporary name and renamed when
//! whole, so the system never copies half of one. Where the system takes only so much (Android's
//! 25 MB), a backup too big for it goes in without its photos, and the person saves a whole one
//! elsewhere.

use super::{DATABASE_FILE, LastBackup, Vault, audit, now_ms};
use crate::backup::EXTENSION;
use crate::crypto::Key;
use crate::error::Result;
use crate::store;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// How many of its own backups a phone keeps.
pub const OWN_BACKUPS_KEPT: usize = 3;
const PREFIX: &str = "backup-";
/// The end of the name of a backup made without its photos.
const NO_PHOTOS: &str = "-no-photos";
const PARTIAL: &str = "backup.partial";
const LAST: &str = "last_own_backup";
/// A backup is due once the vault has changed and the last is this old: a day, less some hours
/// so that opening the app at about the same time each day makes one.
const DUE_AFTER_MS: i64 = 20 * 60 * 60 * 1000;

/// One of the backups in the folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnBackup {
    pub at: i64,
    pub file_name: String,
    /// False for one made without its photos, to fit the system's backup.
    pub photos: bool,
    pub size: u64,
}

/// The last backup made, and the change log as it stood then.
#[derive(Serialize, Deserialize)]
struct Last {
    backup: OwnBackup,
    seq: i64,
}

impl Vault {
    /// Backs up into `folder` if one is due: the vault is its own (not a replica), its person has
    /// the setting on and may back up (an admin, in a team), and it has changed since the last,
    /// which is old enough. `budget` is what the folder may hold in all; a backup over it is made
    /// again without photos, and older ones go first. Returns the backup made, if one was.
    pub fn back_up_own(&mut self, folder: &Path, budget: Option<u64>) -> Result<Option<OwnBackup>> {
        if !self.may_back_up_own()? {
            return Ok(None);
        }
        if let Some(last) = self.last_own()?
            && (last.seq >= self.change_seq()? || now_ms() - last.backup.at < DUE_AFTER_MS)
        {
            return Ok(None);
        }
        fs::create_dir_all(folder)?;
        let partial = folder.join(PARTIAL);
        let made = self.write_own(&partial, budget);
        let (at, photos) = match made {
            Ok(made) => made,
            Err(error) => {
                let _ = fs::remove_file(&partial);
                return Err(error);
            }
        };
        let file_name = format!("{PREFIX}{at}{}.{EXTENSION}", if photos { "" } else { NO_PHOTOS });
        fs::rename(&partial, folder.join(&file_name))?;
        let size = fs::metadata(folder.join(&file_name))?.len();
        prune(folder, budget)?;

        let backup = OwnBackup {
            at,
            file_name,
            photos,
            size,
        };
        // Only a whole backup answers the reminder: one without photos still leaves them to save.
        if photos {
            let last = LastBackup {
                at,
                file_name: backup.file_name.clone(),
            };
            self.set_meta("last_backup", &serde_json::to_string(&last)?)?;
        }
        audit::note(&self.conn, &self.signer, audit::Entry::new("backed-up"))?;
        // Read after the audit note, in case noting it counts as a change.
        let last = Last {
            backup: backup.clone(),
            seq: self.change_seq()?,
        };
        self.set_meta(LAST, &serde_json::to_string(&last)?)?;
        Ok(Some(backup))
    }

    /// The last backup the vault made of itself into its folder.
    pub fn last_own_backup(&self) -> Result<Option<OwnBackup>> {
        Ok(self.last_own()?.map(|last| last.backup))
    }

    /// Whether this vault backs itself up at all, setting aside whether one is due.
    pub fn may_back_up_own(&self) -> Result<bool> {
        Ok(!self.is_replica() && self.settings()?.phone_backups && (!self.is_team() || self.organization.is_some()))
    }

    /// The backups in `folder`, newest first.
    pub fn own_backups(folder: &Path) -> Result<Vec<(PathBuf, OwnBackup)>> {
        let entries = match fs::read_dir(folder) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut found = Vec::new();
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some(stem) = file_name
                .strip_prefix(PREFIX)
                .and_then(|rest| rest.strip_suffix(&format!(".{EXTENSION}")))
            else {
                continue;
            };
            let (at, photos) = match stem.strip_suffix(NO_PHOTOS) {
                Some(at) => (at, false),
                None => (stem, true),
            };
            let (Ok(at), Ok(meta)) = (at.parse::<i64>(), entry.metadata()) else {
                continue;
            };
            found.push((
                entry.path(),
                OwnBackup {
                    at,
                    file_name,
                    photos,
                    size: meta.len(),
                },
            ));
        }
        found.sort_by_key(|(_, backup)| std::cmp::Reverse(backup.at));
        Ok(found)
    }

    /// Writes a whole backup to `partial`, or one without photos if the whole one is over
    /// `budget`. Says when it was made and whether it has its photos.
    fn write_own(&mut self, partial: &Path, budget: Option<u64>) -> Result<(i64, bool)> {
        let at = self.write_backup(partial, true)?;
        match budget {
            Some(budget) if fs::metadata(partial)?.len() > budget && self.has_photos()? => {
                Ok((self.write_backup(partial, false)?, false))
            }
            _ => Ok((at, true)),
        }
    }

    fn has_photos(&self) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM attachments WHERE length(ciphertext) > 0)",
            [],
            |row| row.get(0),
        )?)
    }

    fn last_own(&self) -> Result<Option<Last>> {
        Ok(match self.meta(LAST)? {
            Some(json) => Some(serde_json::from_str(&json)?),
            None => None,
        })
    }

    /// Where the change log stands: it grows with every change to the vault.
    fn change_seq(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT coalesce(max(seq), 0) FROM changes", [], |row| row.get(0))?)
    }
}

/// Keeps the newest [`OWN_BACKUPS_KEPT`] backups that fit in `budget` together (always the
/// newest), and removes the rest.
fn prune(folder: &Path, budget: Option<u64>) -> Result<()> {
    let mut total = 0;
    for (index, (path, backup)) in Vault::own_backups(folder)?.into_iter().enumerate() {
        total += backup.size;
        let fits = budget.is_none_or(|budget| total <= budget);
        if index > 0 && (index >= OWN_BACKUPS_KEPT || !fits) {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

/// A copy of the database beside it with every attachment's bytes taken out, as a replica holds
/// one it has not fetched, and the space they took given back. The caller removes it after.
pub(super) fn without_photos(database: &Path, key: &Key) -> Result<PathBuf> {
    let lean = database.with_file_name(format!("no-photos-{DATABASE_FILE}"));
    remove_database(&lean);
    let made = (|| -> Result<()> {
        fs::copy(database, &lean)?;
        let conn = store::open(&lean, key)?;
        conn.execute("UPDATE attachments SET ciphertext = x''", [])?;
        conn.execute_batch("VACUUM")?;
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    })();
    if let Err(error) = made {
        remove_database(&lean);
        return Err(error);
    }
    Ok(lean)
}

/// Removes a database file and its write-ahead log, if there are any.
pub(super) fn remove_database(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        let _ = fs::remove_file(PathBuf::from(name));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;
    use crate::vault::{Credential, Kind};

    const PASSWORD: &str = "correct horse battery staple";

    fn vault_with_a_photo(dir: &Path, bytes: usize) -> (Vault, uuid::Uuid) {
        let (mut vault, _) = Vault::create(dir, PASSWORD).unwrap();
        let firing = vault
            .save(Kind::Firing, None, &serde_json::json!({ "name": "Cone 6 test" }))
            .unwrap();
        let photo = vault
            .add_attachment(Kind::Firing, firing.record_id, "image/jpeg", &vec![7u8; bytes])
            .unwrap();
        (vault, photo.id)
    }

    /// Makes the last backup look a day old, so another is due.
    fn age_last(vault: &mut Vault) {
        let mut last = vault.last_own().unwrap().unwrap();
        last.backup.at -= 24 * 60 * 60 * 1000;
        vault.set_meta(LAST, &serde_json::to_string(&last).unwrap()).unwrap();
    }

    #[test]
    fn backs_up_once_a_day_and_only_after_changes() {
        let (dir, folder) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (mut vault, _) = vault_with_a_photo(dir.path(), 10);
        let made = vault.back_up_own(folder.path(), None).unwrap().unwrap();
        assert!(made.photos);
        assert_eq!(vault.last_backup().unwrap().unwrap().at, made.at);
        // Nothing changed, and too soon.
        assert_eq!(vault.back_up_own(folder.path(), None).unwrap(), None);
        age_last(&mut vault);
        // Old enough, but nothing changed.
        assert_eq!(vault.back_up_own(folder.path(), None).unwrap(), None);
        vault
            .save(Kind::Recipe, None, &serde_json::json!({ "name": "Celadon" }))
            .unwrap();
        // Changed, but too soon after the last.
        let mut last = vault.last_own().unwrap().unwrap();
        last.backup.at = now_ms();
        vault.set_meta(LAST, &serde_json::to_string(&last).unwrap()).unwrap();
        assert_eq!(vault.back_up_own(folder.path(), None).unwrap(), None);
        age_last(&mut vault);
        assert!(vault.back_up_own(folder.path(), None).unwrap().is_some());
        assert_eq!(Vault::own_backups(folder.path()).unwrap().len(), 2);
        assert!(!folder.path().join(PARTIAL).exists());
    }

    #[test]
    fn keeps_the_newest_three() {
        let (dir, folder) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (mut vault, _) = vault_with_a_photo(dir.path(), 10);
        let mut made = Vec::new();
        for n in 0..5 {
            if n > 0 {
                age_last(&mut vault);
                vault
                    .save(Kind::Recipe, None, &serde_json::json!({ "name": format!("Test {n}") }))
                    .unwrap();
                // Names are by the millisecond.
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            made.push(vault.back_up_own(folder.path(), None).unwrap().unwrap());
        }
        let kept: Vec<_> = Vault::own_backups(folder.path())
            .unwrap()
            .into_iter()
            .map(|(_, b)| b.at)
            .collect();
        assert_eq!(kept, made.iter().rev().take(3).map(|b| b.at).collect::<Vec<_>>());
    }

    #[test]
    fn none_with_the_setting_off() {
        let (dir, folder) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (mut vault, _) = vault_with_a_photo(dir.path(), 10);
        let off = crate::vault::Settings {
            phone_backups: false,
            ..vault.settings().unwrap()
        };
        vault.set_settings(&off).unwrap();
        assert!(!vault.may_back_up_own().unwrap());
        assert_eq!(vault.back_up_own(folder.path(), None).unwrap(), None);
        assert!(Vault::own_backups(folder.path()).unwrap().is_empty());
    }

    #[test]
    fn one_over_the_budget_leaves_its_photos_out_and_restores_without_them() {
        let (dir, folder) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (mut vault, photo) = vault_with_a_photo(dir.path(), 1_000_000);
        let made = vault.back_up_own(folder.path(), Some(500_000)).unwrap().unwrap();
        assert!(!made.photos);
        assert!(made.size < 500_000, "{} bytes", made.size);
        assert!(made.file_name.ends_with("-no-photos.gvbackup"));
        // A backup without photos does not stand for the reminder.
        assert!(vault.last_backup().unwrap().is_none());
        assert!(!dir.path().join(format!("no-photos-{DATABASE_FILE}")).exists());
        // The vault itself still has the photo.
        assert_eq!(vault.attachment(photo).unwrap().1.len(), 1_000_000);
        drop(vault);

        let (path, _) = Vault::own_backups(folder.path()).unwrap().remove(0);
        let other = tempfile::tempdir().unwrap();
        let (restored, _) = Vault::restore(other.path(), &path, None, &Credential::Password(PASSWORD)).unwrap();
        assert_eq!(restored.heads(Kind::Firing).unwrap().len(), 1);
        assert!(matches!(restored.attachment(photo), Err(Error::NotFetched)));
    }

    #[test]
    fn older_ones_go_to_stay_within_the_budget() {
        let (dir, folder) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (mut vault, _) = vault_with_a_photo(dir.path(), 10);
        let first = vault.back_up_own(folder.path(), None).unwrap().unwrap();
        age_last(&mut vault);
        vault
            .save(Kind::Recipe, None, &serde_json::json!({ "name": "Shino" }))
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        // Room for one, not two.
        let second = vault
            .back_up_own(folder.path(), Some(first.size * 3 / 2))
            .unwrap()
            .unwrap();
        let kept: Vec<_> = Vault::own_backups(folder.path())
            .unwrap()
            .into_iter()
            .map(|(_, b)| b)
            .collect();
        assert_eq!(kept, vec![second]);
    }
}
