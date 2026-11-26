//! Personal backups, restoring, and vaults set aside by a restore
//! (docs/adr/0007-backups-locking-updates.md).

use super::{
    Credential, DATABASE_FILE, KEYRING_FILE, Person, Vault, audit, file_name_of, now_ms, open_private_key, own_backups,
    parse_id, person_in, read_keyring, team,
};
use crate::backup::Backup;
use crate::crypto::{self, Key};
use crate::error::{Error, Result};
use crate::files;
use crate::keyring;
use crate::store;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastBackup {
    pub at: i64,
    pub file_name: String,
}

/// A vault that a restore moved into a `replaced-…` folder beside the vault's files.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAside {
    pub name: String,
    pub set_aside_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub created_at: i64,
    pub app_version: String,
    /// For a team's backup, the admins who can restore it; empty for one person's.
    pub admins: Vec<Person>,
}

impl Vault {
    /// When the last backup was made, and the name of its file.
    pub fn last_backup(&self) -> Result<Option<LastBackup>> {
        self.meta("last_backup")?
            .map(|json| serde_json::from_str(&json).map_err(Error::from))
            .transpose()
    }

    /// Writes a backup of the whole vault to `path` (docs/adr/0007-backups-locking-updates.md).
    pub fn back_up(&mut self, path: &Path) -> Result<LastBackup> {
        let at = self.write_backup(path, true)?;
        let last = LastBackup {
            at,
            file_name: file_name_of(path),
        };
        self.set_meta("last_backup", &serde_json::to_string(&last)?)?;
        audit::note(&self.conn, &self.signer, audit::Entry::new("backed-up"))?;
        Ok(last)
    }

    /// Writes a backup to `path` and says when it was made, without recording it. Without
    /// `photos`, attachments go in without their bytes, as a replica pulls them, so the backup is
    /// small (docs/adr/0028-a-phones-own-vault.md).
    pub(super) fn write_backup(&mut self, path: &Path, photos: bool) -> Result<i64> {
        // A backup holds every collection, so in a team only admins make one (ADR 12).
        if self.is_team() {
            self.admin()?;
        }
        // Moves everything from the write-ahead log into the database file, so the file alone is
        // the whole vault. The app holds the only connection, so nothing can be writing meanwhile.
        let busy: i64 = self
            .conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
        if busy != 0 {
            return Err(Error::Io(std::io::Error::other("the vault was busy; try again")));
        }
        let database_key = self.database_key()?;
        let at = now_ms();
        let database = self.dir.join(DATABASE_FILE);
        if photos {
            Backup::write(
                path,
                self.keyring.vault_id,
                at,
                self.keyring.clone(),
                &database_key,
                &database,
            )?;
            return Ok(at);
        }
        let lean = own_backups::without_photos(&database, &database_key)?;
        let written = Backup::write(
            path,
            self.keyring.vault_id,
            at,
            self.keyring.clone(),
            &database_key,
            &lean,
        );
        own_backups::remove_database(&lean);
        written?;
        Ok(at)
    }

    /// What can be told about a backup before it is opened.
    pub fn backup_info(path: &Path) -> Result<BackupInfo> {
        let backup = Backup::open(path)?;
        let admins = match backup.header.keyring.organization {
            Some(_) => team::people(&backup.header.keyring)
                .into_iter()
                .filter(|p| p.admin)
                .collect(),
            None => Vec::new(),
        };
        Ok(BackupInfo {
            created_at: backup.header.created_at,
            app_version: backup.header.app_version,
            admins,
        })
    }

    /// Restores a backup into `dir` and opens it, with the password the backup was made with or
    /// its recovery key. Nothing in `dir` changes until the backup has been opened and checked;
    /// a vault already there is then moved into a `replaced-…` folder beside it, not deleted.
    /// Returns that folder, if there was a vault to move.
    pub fn restore(
        dir: &Path,
        path: &Path,
        person: Option<Uuid>,
        credential: &Credential,
    ) -> Result<(Vault, Option<PathBuf>)> {
        let backup = Backup::open(path)?;
        let keyring = backup.header.keyring.clone();
        let user = person_in(&keyring, person)?;
        // A team's backup replaces everyone's vault, so only an admin restores it (ADR 12).
        if keyring.organization.is_some() && user.organization_key.is_none() {
            return Err(Error::NotAllowed);
        }
        Vault::may_replace(dir, &user.id)?;
        let keys = open_private_key(&keyring, user, credential)?;
        let database_key = crypto::open_key(
            &keys,
            &user.database_key,
            &keyring::database_key_info(&keyring.vault_id, &user.id),
        )
        .ok_or(Error::BackupDamaged)?;
        let user_id = user.id;
        let created_at = backup.header.created_at;
        let set_aside = place_backup(dir, backup, &database_key)?;
        let mut vault = Vault::open(dir, keyring, user_id, keys)?;
        if let Credential::RecoveryKey { new_password, .. } = credential {
            vault.set_password(new_password)?;
        }
        vault.record_restored(created_at, path)?;
        Ok((vault, set_aside))
    }

    /// A team's vault holds everyone's work, so only one of its admins may restore over it.
    pub(super) fn may_replace(dir: &Path, person: &Uuid) -> Result<()> {
        let Ok(here) = read_keyring(dir) else {
            return Ok(());
        };
        if here.organization.is_some()
            && here
                .user(person)
                .ok()
                .is_none_or(|user| user.organization_key.is_none())
        {
            return Err(Error::NotAnAdminHere);
        }
        Ok(())
    }

    /// The vault is now what the backup holds, so the backup is its latest, though the copy
    /// inside the backup was made just before it was recorded.
    pub(super) fn record_restored(&mut self, created_at: i64, path: &Path) -> Result<()> {
        if self.last_backup()?.is_none_or(|last| last.at < created_at) {
            let last = LastBackup {
                at: created_at,
                file_name: file_name_of(path),
            };
            self.set_meta("last_backup", &serde_json::to_string(&last)?)?;
        }
        audit::note(&self.conn, &self.signer, audit::Entry::new("restored"))
    }

    /// The vaults a restore set aside in `dir`, newest first.
    pub fn set_aside(dir: &Path) -> Result<Vec<SetAside>> {
        let mut found = Vec::new();
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(found),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if let Some(at) = set_aside_time(&name)
                && Vault::exists(&dir.join(&name))
            {
                found.push(SetAside { name, set_aside_at: at });
            }
        }
        found.sort_by_key(|aside| std::cmp::Reverse(aside.set_aside_at));
        Ok(found)
    }

    /// Puts a vault that a restore set aside back in `dir`, and sets aside the one there in its
    /// place, so switching back is the same step. The vault must be locked.
    pub fn bring_back(dir: &Path, name: &str) -> Result<Option<PathBuf>> {
        // Only a folder this module named: never a path elsewhere.
        if set_aside_time(name).is_none() || !Vault::exists(&dir.join(name)) {
            return Err(Error::NotFound);
        }
        let from = dir.join(name);
        let replaced = set_aside_vault(dir)?;
        for file in [KEYRING_FILE, DATABASE_FILE, "vault.db-wal", "vault.db-shm"] {
            if from.join(file).exists() {
                fs::rename(from.join(file), dir.join(file))?;
            }
        }
        // Empty now, unless something else was put in it.
        let _ = fs::remove_dir(&from);
        Ok(replaced)
    }
}

/// When a `replaced-<milliseconds>` folder was made, or None for any other name.
pub(super) fn set_aside_time(name: &str) -> Option<i64> {
    let digits = name.strip_prefix("replaced-")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Puts a backup's database and key file in `dir`, once the database has opened and been checked,
/// and returns the folder the vault already there was moved to, if there was one.
pub(super) fn place_backup(dir: &Path, backup: Backup, database_key: &Key) -> Result<Option<PathBuf>> {
    let keyring = backup.header.keyring.clone();
    let created = !dir.exists();
    fs::create_dir_all(dir)?;
    let restoring = dir.join(format!("{DATABASE_FILE}.restoring"));
    // Decrypted a piece at a time; a backup found damaged part way leaves nothing behind.
    let checked = files::write_atomically_with(&restoring, |file| {
        backup
            .restore_into(database_key, &mut std::io::BufWriter::new(file))
            .map_err(std::io::Error::other)
    })
    .map_err(|error| match error.downcast::<Error>() {
        Ok(error) => error,
        Err(error) => Error::Io(error),
    })
    .and_then(|()| store::open(&restoring, database_key))
    .and_then(|conn| {
        let stored_id: String =
            conn.query_row("SELECT value FROM meta WHERE name = 'vault_id'", [], |row| row.get(0))?;
        if parse_id(&stored_id)? != keyring.vault_id {
            return Err(Error::BackupDamaged);
        }
        Ok(())
    });
    if let Err(error) = checked {
        let _ = fs::remove_file(&restoring);
        if created {
            let _ = fs::remove_dir(dir);
        }
        return Err(error);
    }
    let set_aside = set_aside_vault(dir)?;
    fs::rename(&restoring, dir.join(DATABASE_FILE))?;
    keyring.write(&dir.join(KEYRING_FILE))?;
    Ok(set_aside)
}

/// Moves a vault's files into a new `replaced-…` folder in `dir`, and returns the folder, or None
/// if there was nothing to move.
pub(super) fn set_aside_vault(dir: &Path) -> Result<Option<PathBuf>> {
    let names = [KEYRING_FILE, DATABASE_FILE, "vault.db-wal", "vault.db-shm"];
    if !names.iter().any(|name| dir.join(name).exists()) {
        return Ok(None);
    }
    let aside = dir.join(format!("replaced-{}", now_ms()));
    fs::create_dir(&aside)?;
    for name in names {
        let path = dir.join(name);
        if path.exists() {
            fs::rename(&path, aside.join(name))?;
        }
    }
    Ok(Some(aside))
}
