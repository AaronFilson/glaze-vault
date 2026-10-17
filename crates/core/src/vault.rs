//! A vault: the database, its key file, and the keys of the person who unlocked it.
//!
//! A vault starts with one person and one collection (docs/adr/0006-one-person-first.md), stored the
//! way a team's is, so it can grow into one (docs/adr/0012-teams-on-one-computer.md, in `team`).

mod attachments;
mod team;

pub use attachments::{Attachment, MAX_ATTACHMENT_BYTES};
pub use team::{Collection, Grant, Person};

use crate::access::Role;
use crate::backup::Backup;
use crate::crypto::{self, Key, KeyPair, PasswordKdf};
use crate::error::{Error, Result};
use crate::files;
use crate::keyring::{self, Keyring, KeyringUser};
use crate::recovery::RecoveryKey;
use crate::store;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use zeroize::Zeroizing;

pub const MIN_PASSWORD_CHARS: usize = 8;
const MAX_RECORD_BYTES: usize = 1024 * 1024;
/// The most revisions [`Vault::save_all`] takes at once.
const MAX_BATCH: usize = 1000;
const KEYRING_FILE: &str = "vault.keys";
const DATABASE_FILE: &str = "vault.db";

pub struct Vault {
    dir: PathBuf,
    keyring: Keyring,
    user_id: Uuid,
    keys: KeyPair,
    conn: Connection,
    /// The collections this person can open, with their keys and roles.
    collections: Vec<OpenCollection>,
    /// Where a new record goes when no collection is named: the vault's first collection.
    default_collection: Uuid,
    /// The organization's key pair, when this person is an admin of a team's vault.
    organization: Option<KeyPair>,
}

/// A collection this person can open.
struct OpenCollection {
    id: Uuid,
    name: String,
    /// The person whose private collection it is.
    owner: Option<Uuid>,
    role: Role,
    /// The collection's key, or for a batch operator its batch key only.
    key: Key,
}

impl OpenCollection {
    /// The key records of a kind are encrypted with here, if this person may read them: batch
    /// sheets under the batch key, so a batch operator can open them and nothing else.
    fn key_for(&self, kind: Kind) -> Option<Key> {
        match (self.role, kind) {
            (Role::Operator, Kind::Batch) => Some(self.key.clone()),
            (Role::Operator, _) => None,
            (_, Kind::Batch) => Some(batch_key(&self.key, &self.id)),
            _ => Some(self.key.clone()),
        }
    }
}

/// What a record is. Each kind keeps its own list; the core does not look inside the content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Recipe,
    /// A person's own material, colorant or additive.
    Material,
    /// A batch sheet: a recipe's lines with its materials named by in-house codes, for a batch
    /// operator to weigh out (ADR 4).
    Batch,
    /// A firing of a recipe in the firing log: how it was fired, what came out, measurements and
    /// photos (ADR 14).
    Firing,
    /// A set of limits for a unity formula, to check recipes against (ADR 15).
    Limits,
    /// What materials cost, to cost recipes (ADR 15).
    Prices,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Recipe => "recipe",
            Kind::Material => "material",
            Kind::Batch => "batch",
            Kind::Firing => "firing",
            Kind::Limits => "limits",
            Kind::Prices => "prices",
        }
    }

    fn parse(text: &str) -> Option<Kind> {
        [
            Kind::Recipe,
            Kind::Material,
            Kind::Batch,
            Kind::Firing,
            Kind::Limits,
            Kind::Prices,
        ]
        .into_iter()
        .find(|kind| kind.as_str() == text)
    }
}

/// One revision of a record. `content` is whatever the UI saved; the core keeps it encrypted and
/// does not look inside.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub record_id: Uuid,
    pub revision_id: Uuid,
    pub number: i64,
    pub saved_at: i64,
    pub content: serde_json::Value,
    /// This revision deletes the record. It keeps the content it had, to restore it from.
    pub deleted: bool,
    pub collection_id: Uuid,
}

impl Vault {
    /// A vault exists once its key file does: the key file is written last when one is made.
    pub fn exists(dir: &Path) -> bool {
        dir.join(KEYRING_FILE).is_file()
    }

    /// Makes a vault for one person, and returns the recovery key to show them once.
    pub fn create(dir: &Path, password: &str) -> Result<(Vault, RecoveryKey)> {
        check_password(password)?;
        if Vault::exists(dir) {
            return Err(Error::VaultExists);
        }
        fs::create_dir_all(dir)?;
        set_aside_orphan_database(dir)?;

        let vault_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let keys = KeyPair::generate();
        let database_key = crypto::random_key();
        let recovery = RecoveryKey::generate();

        let password_kdf = PasswordKdf::new();
        let private_key = crypto::encrypt(
            &password_kdf.derive(password),
            &keys.secret,
            &keyring::private_key_aad(&vault_id, &user_id, "password"),
        );
        let private_key_by_recovery = crypto::encrypt(
            &crypto::recovery_key(&recovery.entropy(), user_id.as_bytes()),
            &keys.secret,
            &keyring::private_key_aad(&vault_id, &user_id, "recovery"),
        );
        let keyring = Keyring {
            format: keyring::FORMAT,
            vault_id,
            users: vec![KeyringUser {
                id: user_id,
                name: String::new(),
                password_kdf,
                private_key,
                private_key_by_recovery: Some(private_key_by_recovery),
                database_key: crypto::seal_key(
                    &keys.public,
                    &database_key,
                    &keyring::database_key_info(&vault_id, &user_id),
                ),
                previous_database_key: None,
                public_key: Vec::new(),
                organization_key: None,
                must_set_password: false,
            }],
            organization: None,
        };

        let conn = store::open(&dir.join(DATABASE_FILE), &database_key)?;
        let collection_id = Uuid::new_v4();
        let collection_key = crypto::random_key();
        let sealed = crypto::seal_key(
            &keys.public,
            &collection_key,
            &grant_info(&vault_id, &collection_id, &user_id, Role::Admin),
        );
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO meta (name, value) VALUES ('vault_id', ?1), ('default_collection', ?2)",
            params![vault_id.to_string(), collection_id.to_string()],
        )?;
        tx.execute(
            "INSERT INTO collections (id, created_at) VALUES (?1, ?2)",
            params![collection_id.to_string(), now_ms()],
        )?;
        tx.execute(
            "INSERT INTO grants (user_id, collection_id, enc, ciphertext) VALUES (?1, ?2, ?3, ?4)",
            params![
                user_id.to_string(),
                collection_id.to_string(),
                sealed.enc,
                sealed.ciphertext
            ],
        )?;
        tx.commit()?;
        keyring.write(&dir.join(KEYRING_FILE))?;

        let vault = Vault {
            dir: dir.to_owned(),
            keyring,
            user_id,
            keys,
            conn,
            collections: vec![OpenCollection {
                id: collection_id,
                name: String::new(),
                owner: None,
                role: Role::Admin,
                key: collection_key,
            }],
            default_collection: collection_id,
            organization: None,
        };
        Ok((vault, recovery))
    }

    /// Opens a one-person vault with the password.
    pub fn unlock(dir: &Path, password: &str) -> Result<Vault> {
        Vault::unlock_as(dir, None, password)
    }

    /// Opens the vault as a person, with their password. A team's vault needs the person; a
    /// one-person vault's is found without.
    pub fn unlock_as(dir: &Path, person: Option<Uuid>, password: &str) -> Result<Vault> {
        let keyring = read_keyring(dir)?;
        let user = person_in(&keyring, person)?;
        let keys = open_private_key(&keyring, user, &Credential::Password(password))?;
        let user_id = user.id;
        Vault::open(dir, keyring, user_id, keys)
    }

    /// Opens a one-person vault with the recovery key and sets a new password.
    pub fn recover(dir: &Path, words: &str, new_password: &str) -> Result<Vault> {
        Vault::recover_as(dir, None, words, new_password)
    }

    /// Opens the vault as a person with their recovery key and sets a new password. The recovery
    /// key stays the same, so the printed sheet still works.
    pub fn recover_as(dir: &Path, person: Option<Uuid>, words: &str, new_password: &str) -> Result<Vault> {
        let credential = Credential::RecoveryKey { words, new_password };
        let keyring = read_keyring(dir)?;
        let user = person_in(&keyring, person)?;
        let keys = open_private_key(&keyring, user, &credential)?;
        let user_id = user.id;
        let mut vault = Vault::open(dir, keyring, user_id, keys)?;
        vault.set_password(new_password)?;
        Ok(vault)
    }

    pub fn change_password(&mut self, current: &str, new_password: &str) -> Result<()> {
        check_password(new_password)?;
        self.check_current_password(current)?;
        self.set_password(new_password)
    }

    /// Makes a new recovery key and returns it to show once. The old one stops opening the vault
    /// straight away, though backups made before still open with it.
    pub fn new_recovery_key(&mut self, password: &str) -> Result<RecoveryKey> {
        self.check_current_password(password)?;
        let recovery = RecoveryKey::generate();
        let sealed = crypto::encrypt(
            &crypto::recovery_key(&recovery.entropy(), self.user_id.as_bytes()),
            &self.keys.secret,
            &keyring::private_key_aad(&self.keyring.vault_id, &self.user_id, "recovery"),
        );
        let mut keyring = self.keyring.clone();
        user_mut(&mut keyring, &self.user_id).private_key_by_recovery = Some(sealed);
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        self.keyring = keyring;
        Ok(recovery)
    }

    /// This person's settings, or the defaults if they have not changed any.
    pub fn settings(&self) -> Result<Settings> {
        match self.meta(&format!("settings {}", self.user_id))? {
            Some(json) => Ok(serde_json::from_str(&json)?),
            None => Ok(Settings::default()),
        }
    }

    pub fn set_settings(&mut self, settings: &Settings) -> Result<()> {
        settings.check()?;
        self.set_meta(&format!("settings {}", self.user_id), &serde_json::to_string(settings)?)
    }

    /// Keeps edits that are not saved yet, encrypted like a recipe, so they outlast locking,
    /// closing the app or a crash. There is one draft per person; a new one replaces the old.
    pub fn save_draft(&mut self, draft: &serde_json::Value) -> Result<()> {
        let plaintext = Zeroizing::new(serde_json::to_vec(draft)?);
        if plaintext.len() > MAX_RECORD_BYTES {
            return Err(Error::TooLarge);
        }
        let sealed = crypto::encrypt(&self.draft_collection()?.key, &plaintext, &self.draft_aad()?);
        self.set_meta(&self.draft_name(), &serde_json::to_string(&sealed)?)
    }

    /// The kept draft, if there is one.
    pub fn draft(&self) -> Result<Option<serde_json::Value>> {
        let Some(json) = self.meta(&self.draft_name())? else {
            return Ok(None);
        };
        let sealed: crypto::Sealed = serde_json::from_str(&json)?;
        let plaintext = crypto::decrypt(&self.draft_collection()?.key, &sealed, &self.draft_aad()?)
            .ok_or_else(|| Error::Corrupt("the saved draft does not decrypt".into()))?;
        Ok(Some(serde_json::from_slice(&plaintext)?))
    }

    /// Forgets the draft, once its edits are saved or discarded.
    pub fn clear_draft(&mut self) -> Result<()> {
        self.conn
            .execute("DELETE FROM meta WHERE name = ?1", params![self.draft_name()])?;
        Ok(())
    }

    /// When the last backup was made, and the name of its file.
    pub fn last_backup(&self) -> Result<Option<LastBackup>> {
        self.meta("last_backup")?
            .map(|json| serde_json::from_str(&json).map_err(Error::from))
            .transpose()
    }

    /// Writes a backup of the whole vault to `path` (docs/adr/0007-backups-locking-updates.md).
    pub fn back_up(&mut self, path: &Path) -> Result<LastBackup> {
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
        Backup::write(
            path,
            self.keyring.vault_id,
            at,
            self.keyring.clone(),
            &database_key,
            &self.dir.join(DATABASE_FILE),
        )?;

        let last = LastBackup {
            at,
            file_name: file_name_of(path),
        };
        self.set_meta("last_backup", &serde_json::to_string(&last)?)?;
        Ok(last)
    }

    /// What can be told about a backup before it is opened.
    pub fn backup_info(path: &Path) -> Result<BackupInfo> {
        let backup = Backup::open(path)?;
        let admins = match backup.header.keyring.organization {
            Some(_) => team::people_of(&backup.header.keyring)
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

    /// The vault is now what the backup holds, so the backup is its latest, though the copy
    /// inside the backup was made just before it was recorded.
    fn record_restored(&mut self, created_at: i64, path: &Path) -> Result<()> {
        if self.last_backup()?.is_none_or(|last| last.at < created_at) {
            let last = LastBackup {
                at: created_at,
                file_name: file_name_of(path),
            };
            self.set_meta("last_backup", &serde_json::to_string(&last)?)?;
        }
        Ok(())
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
    /// place, so switching back is the same step. The vault must be locked. Returns the folder the
    /// vault that was there went into.
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

    /// Saves a record. With no parent it starts a new one; with one, it adds the next revision
    /// after it. Revisions are never changed, only added (docs/adr/0005-lan-host-and-replicas.md).
    /// Saving after a revision that deletes a record restores it.
    pub fn save(&mut self, kind: Kind, parent: Option<Uuid>, content: &serde_json::Value) -> Result<Revision> {
        self.add_revision(kind, parent, None, content, false)
    }

    /// Saves a new record into a collection, rather than the vault's first.
    pub fn save_in(&mut self, kind: Kind, collection: Uuid, content: &serde_json::Value) -> Result<Revision> {
        self.add_revision(kind, None, Some(collection), content, false)
    }

    /// Saves several revisions at once, all or none: an import's hundreds of records in one
    /// write to disk rather than one each. Each is `(parent, content)` as for [`Vault::save`];
    /// new records go into `collection`, or the vault's first.
    pub fn save_all(
        &mut self,
        kind: Kind,
        collection: Option<Uuid>,
        revisions: &[(Option<Uuid>, serde_json::Value)],
    ) -> Result<Vec<Revision>> {
        if revisions.len() > MAX_BATCH {
            return Err(Error::TooLarge);
        }
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let saved = revisions
            .iter()
            .map(|(parent, content)| self.add_revision(kind, *parent, collection, content, false))
            .collect::<Result<Vec<_>>>()
            .and_then(|saved| Ok(self.conn.execute_batch("COMMIT").map(|()| saved)?));
        if saved.is_err() {
            let _ = self.conn.execute_batch("ROLLBACK");
        }
        saved
    }

    /// Deletes a record by adding a revision after its newest that says so, with the same content.
    /// It leaves the lists for the deleted ones, where it can be restored or erased (ADR 9).
    pub fn delete(&mut self, kind: Kind, newest: Uuid) -> Result<Revision> {
        let revision = self
            .read_revisions(
                "WHERE r.kind = ?1 AND r.id = ?2 AND r.deleted = 0
                 AND NOT EXISTS (SELECT 1 FROM revisions c WHERE c.parent_id = r.id)",
                params![kind.as_str(), newest.to_string()],
                kind,
            )?
            .pop()
            .ok_or(Error::NotFound)?;
        self.add_revision(kind, Some(newest), None, &revision.content, true)
    }

    /// Erases a deleted record: every revision of it is removed from the vault, and cannot be
    /// brought back. Backups made before still hold it. Returns how many revisions there were.
    pub fn erase(&mut self, kind: Kind, record_id: Uuid) -> Result<usize> {
        let deleted = self.deleted(kind)?;
        let Some(record) = deleted.iter().find(|r| r.record_id == record_id) else {
            return Err(Error::NotDeleted);
        };
        self.editable(&record.collection_id)?;
        let tx = self.conn.unchecked_transaction()?;
        let erased = tx.execute(
            "DELETE FROM revisions WHERE record_id = ?1 AND kind = ?2",
            params![record_id.to_string(), kind.as_str()],
        )?;
        tx.execute(
            "DELETE FROM attachments WHERE record_id = ?1 AND kind = ?2",
            params![record_id.to_string(), kind.as_str()],
        )?;
        tx.commit()?;
        // secure_delete has zeroed the freed pages; this empties the write-ahead log of them too.
        self.conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(erased)
    }

    /// Adds a revision after `parent`, in its collection, or starts a record in `collection` (or
    /// the vault's first), if this person may change records there.
    fn add_revision(
        &mut self,
        kind: Kind,
        parent: Option<Uuid>,
        collection: Option<Uuid>,
        content: &serde_json::Value,
        deleted: bool,
    ) -> Result<Revision> {
        let plaintext = Zeroizing::new(serde_json::to_vec(content)?);
        if plaintext.len() > MAX_RECORD_BYTES {
            return Err(Error::TooLarge);
        }
        let (record_id, number, collection_id) = match parent {
            None => (Uuid::new_v4(), 1, collection.unwrap_or(self.default_collection)),
            Some(parent_id) => {
                let (record_id, number, collection_id): (String, i64, String) = self
                    .conn
                    .query_row(
                        "SELECT record_id, number, collection_id FROM revisions WHERE id = ?1 AND kind = ?2",
                        params![parent_id.to_string(), kind.as_str()],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?
                    .ok_or(Error::NotFound)?;
                (parse_id(&record_id)?, number + 1, parse_id(&collection_id)?)
            }
        };
        let collection_key = self.editable(&collection_id)?.key_for(kind).ok_or(Error::NotAllowed)?;
        let revision_id = Uuid::new_v4();
        let saved_at = now_ms();
        let aad = revision_aad(
            &revision_id,
            &record_id,
            kind.as_str(),
            &collection_id,
            number,
            parent.as_ref(),
            deleted,
        );
        let sealed = crypto::encrypt(&collection_key, &plaintext, &aad);
        self.conn.execute(
            "INSERT INTO revisions (id, record_id, kind, parent_id, number, collection_id, author_id, created_at, nonce, ciphertext, deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                revision_id.to_string(),
                record_id.to_string(),
                kind.as_str(),
                parent.map(|id| id.to_string()),
                number,
                collection_id.to_string(),
                self.user_id.to_string(),
                saved_at,
                sealed.nonce,
                sealed.ciphertext,
                deleted,
            ],
        )?;
        Ok(Revision {
            record_id,
            revision_id,
            number,
            saved_at,
            content: content.clone(),
            deleted,
            collection_id,
        })
    }

    /// The newest revision of every record of a kind, newest first, leaving out deleted records.
    pub fn heads(&self, kind: Kind) -> Result<Vec<Revision>> {
        Ok(self.newest(kind)?.into_iter().filter(|r| !r.deleted).collect())
    }

    /// The deleted records of a kind, newest first: each one's revision that deleted it.
    pub fn deleted(&self, kind: Kind) -> Result<Vec<Revision>> {
        Ok(self.newest(kind)?.into_iter().filter(|r| r.deleted).collect())
    }

    /// The newest revision of every record of a kind, deleted or not, newest first.
    fn newest(&self, kind: Kind) -> Result<Vec<Revision>> {
        let revisions = self.read_revisions(
            "WHERE r.kind = ?1 AND NOT EXISTS (SELECT 1 FROM revisions c WHERE c.parent_id = r.id)
             ORDER BY r.created_at DESC",
            params![kind.as_str()],
            kind,
        )?;
        // Two heads for one record means a fork from offline editing (ADR 5): show the newest
        // until forks can be resolved.
        let mut heads: Vec<Revision> = Vec::new();
        for revision in revisions {
            if !heads.iter().any(|head| head.record_id == revision.record_id) {
                heads.push(revision);
            }
        }
        Ok(heads)
    }

    /// Every saved revision of one record, newest first. Revisions that deleted it are left out:
    /// each has the content of the one before.
    pub fn history(&self, kind: Kind, record_id: Uuid) -> Result<Vec<Revision>> {
        let revisions = self.read_revisions(
            "WHERE r.kind = ?1 AND r.record_id = ?2 AND r.deleted = 0 ORDER BY r.number DESC, r.created_at DESC",
            params![kind.as_str(), record_id.to_string()],
            kind,
        )?;
        if revisions.is_empty() {
            return Err(Error::NotFound);
        }
        Ok(revisions)
    }

    /// Reads and decrypts the revisions that `where_clause` picks, in the collections this person
    /// can open. The clause is fixed SQL, never built from input: values go in `values`.
    fn read_revisions(
        &self,
        where_clause: &'static str,
        values: impl rusqlite::Params,
        kind: Kind,
    ) -> Result<Vec<Revision>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT r.id, r.record_id, r.parent_id, r.number, r.collection_id, r.created_at, r.nonce, r.ciphertext,
                    r.deleted
             FROM revisions r {where_clause}"
        ))?;
        let rows = statement.query_map(values, |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Vec<u8>>(6)?,
                row.get::<_, Vec<u8>>(7)?,
                row.get::<_, bool>(8)?,
            ))
        })?;
        let mut revisions = Vec::new();
        for row in rows {
            let (id, record_id, parent_id, number, collection_id, saved_at, nonce, ciphertext, deleted) = row?;
            let (revision_id, record_id, collection_id) =
                (parse_id(&id)?, parse_id(&record_id)?, parse_id(&collection_id)?);
            let parent = parent_id.as_deref().map(parse_id).transpose()?;
            let Some(key) = self
                .collections
                .iter()
                .find(|c| c.id == collection_id)
                .and_then(|c| c.key_for(kind))
            else {
                continue;
            };
            let aad = revision_aad(
                &revision_id,
                &record_id,
                kind.as_str(),
                &collection_id,
                number,
                parent.as_ref(),
                deleted,
            );
            let plaintext = crypto::decrypt(&key, &crypto::Sealed { nonce, ciphertext }, &aad)
                .ok_or_else(|| Error::Corrupt(format!("revision {revision_id} does not decrypt")))?;
            revisions.push(Revision {
                record_id,
                revision_id,
                number,
                saved_at,
                content: serde_json::from_slice(&plaintext)?,
                deleted,
                collection_id,
            });
        }
        Ok(revisions)
    }

    fn open(dir: &Path, mut keyring: Keyring, user_id: Uuid, keys: KeyPair) -> Result<Vault> {
        let path = dir.join(DATABASE_FILE);
        let conn = {
            let user = keyring.user(&user_id)?;
            let database_key = |sealed: &crypto::SealedBox| {
                crypto::open_key(&keys, sealed, &keyring::database_key_info(&keyring.vault_id, &user_id))
                    .ok_or_else(|| Error::Corrupt("the database key is not sealed to this user".into()))
            };
            match (
                store::open(&path, &database_key(&user.database_key)?),
                &user.previous_database_key,
            ) {
                // A change of database key that did not finish (team::rotate_database_key) left
                // the database with the one before: finish it.
                (Err(_), Some(previous)) => {
                    let conn = store::open(&path, &database_key(previous)?)?;
                    store::rekey(&conn, &database_key(&user.database_key)?)?;
                    conn
                }
                (opened, _) => opened?,
            }
        };

        let stored_id: String =
            conn.query_row("SELECT value FROM meta WHERE name = 'vault_id'", [], |row| row.get(0))?;
        if parse_id(&stored_id)? != keyring.vault_id {
            return Err(Error::Corrupt("the key file belongs to another vault".into()));
        }
        if keyring.users.iter().any(|u| u.previous_database_key.is_some()) {
            keyring.users.iter_mut().for_each(|u| u.previous_database_key = None);
            keyring.write(&dir.join(KEYRING_FILE))?;
        }
        let default_collection: String =
            conn.query_row("SELECT value FROM meta WHERE name = 'default_collection'", [], |row| {
                row.get(0)
            })?;
        let organization = match (&keyring.organization, &keyring.user(&user_id)?.organization_key) {
            (Some(_), Some(sealed)) => Some(team::open_organization_key(&keyring, &keys, user_id, sealed)?),
            _ => None,
        };
        let mut vault = Vault {
            dir: dir.to_owned(),
            keyring,
            user_id,
            keys,
            conn,
            collections: Vec::new(),
            default_collection: parse_id(&default_collection)?,
            organization,
        };
        vault.load_collections()?;
        Ok(vault)
    }

    /// Opens the keys of every collection granted to this person, and of all of them for an
    /// admin. Someone who must still choose their own password opens none.
    fn load_collections(&mut self) -> Result<()> {
        self.collections.clear();
        if self.user().must_set_password {
            return Ok(());
        }
        let mut statement = self.conn.prepare(
            "SELECT c.id, c.name, c.owner_id, g.role, g.enc, g.ciphertext
             FROM grants g JOIN collections c ON c.id = g.collection_id WHERE g.user_id = ?1
             ORDER BY c.created_at",
        )?;
        let rows = statement
            .query_map(params![self.user_id.to_string()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        let mut collections = Vec::new();
        for (id, name, owner, role, enc, ciphertext) in rows {
            let id = parse_id(&id)?;
            let role = Role::parse(&role).ok_or_else(|| Error::Corrupt(format!("unknown role {role}")))?;
            let key = crypto::open_key(
                &self.keys,
                &crypto::SealedBox { enc, ciphertext },
                &grant_info(&self.keyring.vault_id, &id, &self.user_id, role),
            )
            .ok_or_else(|| Error::Corrupt("a collection key does not open".into()))?;
            collections.push(OpenCollection {
                id,
                name,
                owner: owner.as_deref().map(parse_id).transpose()?,
                role,
                key,
            });
        }
        if let Some(organization) = &self.organization {
            for collection in team::organization_collections(&self.conn, &self.keyring, organization)? {
                match collections.iter_mut().find(|c| c.id == collection.id) {
                    Some(granted) => granted.role = Role::Admin,
                    None => collections.push(collection),
                }
            }
        }
        self.collections = collections;
        Ok(())
    }

    /// A collection this person can open, or NotFound: one they cannot is not shown to exist.
    fn readable(&self, id: &Uuid) -> Result<&OpenCollection> {
        self.collections.iter().find(|c| c.id == *id).ok_or(Error::NotFound)
    }

    /// A collection this person may change records in.
    fn editable(&self, id: &Uuid) -> Result<&OpenCollection> {
        let collection = self.readable(id)?;
        if !collection.role.can_edit() {
            return Err(Error::NotAllowed);
        }
        Ok(collection)
    }

    fn user(&self) -> &KeyringUser {
        self.keyring
            .users
            .iter()
            .find(|user| user.id == self.user_id)
            .expect("the unlocked user is in the keyring")
    }

    /// Encrypts the private key under a new password, with a new salt.
    fn set_password(&mut self, password: &str) -> Result<()> {
        let kdf = PasswordKdf::new();
        let sealed = crypto::encrypt(
            &kdf.derive(password),
            &self.keys.secret,
            &keyring::private_key_aad(&self.keyring.vault_id, &self.user_id, "password"),
        );
        let mut keyring = self.keyring.clone();
        let user = user_mut(&mut keyring, &self.user_id);
        user.password_kdf = kdf;
        user.private_key = sealed;
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        self.keyring = keyring;
        Ok(())
    }

    fn check_current_password(&self, password: &str) -> Result<()> {
        let user = self.user();
        crypto::decrypt(
            &user.password_kdf.derive(password),
            &user.private_key,
            &keyring::private_key_aad(&self.keyring.vault_id, &self.user_id, "password"),
        )
        .map(|_| ())
        .ok_or(Error::WrongPassword)
    }

    /// Opened again from the key file when needed, rather than kept in memory.
    fn database_key(&self) -> Result<Key> {
        crypto::open_key(
            &self.keys,
            &self.user().database_key,
            &keyring::database_key_info(&self.keyring.vault_id, &self.user_id),
        )
        .ok_or_else(|| Error::Corrupt("the database key is not sealed to this user".into()))
    }

    fn draft_name(&self) -> String {
        format!("draft {}", self.user_id)
    }

    fn draft_aad(&self) -> Result<Vec<u8>> {
        Ok(draft_aad_for(
            &self.keyring.vault_id,
            &self.user_id.to_string(),
            &self.draft_collection()?.id,
        ))
    }

    /// Drafts are encrypted with the person's private collection's key in a team's vault, which
    /// only they and admins hold; in a one-person vault, with its only collection's.
    fn draft_collection(&self) -> Result<&OpenCollection> {
        self.collections
            .iter()
            .find(|c| c.owner == Some(self.user_id))
            .or_else(|| self.collections.iter().find(|c| c.id == self.default_collection))
            .ok_or(Error::NotAllowed)
    }

    fn meta(&self, name: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM meta WHERE name = ?1", params![name], |row| {
                row.get(0)
            })
            .optional()?)
    }

    fn set_meta(&self, name: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta (name, value) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET value = excluded.value",
            params![name, value],
        )?;
        Ok(())
    }
}

/// How a person proves who they are: their password, or their recovery key along with the new
/// password it sets.
pub enum Credential<'a> {
    Password(&'a str),
    RecoveryKey { words: &'a str, new_password: &'a str },
}

/// A person's choices, kept in the vault so they follow it onto another computer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Lock the vault when nobody has used the app for `auto_lock_minutes`.
    pub auto_lock: bool,
    pub auto_lock_minutes: u32,
    /// Remind about backups this many days after the last one; 0 means never.
    pub backup_reminder_days: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            auto_lock: true,
            auto_lock_minutes: 15,
            backup_reminder_days: 30,
        }
    }
}

impl Settings {
    fn check(&self) -> Result<()> {
        if !(1..=480).contains(&self.auto_lock_minutes) {
            return Err(Error::InvalidSetting(
                "Choose between 1 and 480 minutes before the vault locks.",
            ));
        }
        if self.backup_reminder_days > 365 {
            return Err(Error::InvalidSetting("Choose a backup reminder of a year or less."));
        }
        Ok(())
    }
}

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

/// When a `replaced-<milliseconds>` folder was made, or None for any other name.
fn set_aside_time(name: &str) -> Option<i64> {
    let digits = name.strip_prefix("replaced-")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub created_at: i64,
    pub app_version: String,
    /// For a team's backup, the admins who can restore it; empty for one person's.
    pub admins: Vec<Person>,
}

/// Decrypts a person's private key with their password or recovery key.
fn open_private_key(keyring: &Keyring, user: &KeyringUser, credential: &Credential) -> Result<KeyPair> {
    let secret = match credential {
        Credential::Password(password) => crypto::decrypt(
            &user.password_kdf.derive(password),
            &user.private_key,
            &keyring::private_key_aad(&keyring.vault_id, &user.id, "password"),
        )
        .ok_or(Error::WrongPassword)?,
        Credential::RecoveryKey { words, new_password } => {
            check_password(new_password)?;
            let recovery = RecoveryKey::parse(words)?;
            let sealed = user.private_key_by_recovery.as_ref().ok_or(Error::WrongRecoveryKey)?;
            crypto::decrypt(
                &crypto::recovery_key(&recovery.entropy(), user.id.as_bytes()),
                sealed,
                &keyring::private_key_aad(&keyring.vault_id, &user.id, "recovery"),
            )
            .ok_or(Error::WrongRecoveryKey)?
        }
    };
    KeyPair::from_secret(secret).ok_or_else(|| Error::Corrupt("the private key is not valid".into()))
}

fn user_mut<'a>(keyring: &'a mut Keyring, id: &Uuid) -> &'a mut KeyringUser {
    keyring
        .users
        .iter_mut()
        .find(|user| user.id == *id)
        .expect("the unlocked user is in the keyring")
}

fn check_password(password: &str) -> Result<()> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(Error::PasswordTooShort(MIN_PASSWORD_CHARS));
    }
    Ok(())
}

fn read_keyring(dir: &Path) -> Result<Keyring> {
    if !Vault::exists(dir) {
        return Err(Error::NoVault);
    }
    Keyring::read(&dir.join(KEYRING_FILE))
}

/// The person named, or a one-person vault's only person.
fn person_in(keyring: &Keyring, person: Option<Uuid>) -> Result<&KeyringUser> {
    match (person, keyring.users.as_slice()) {
        (Some(id), _) => keyring.user(&id),
        (None, [user]) => Ok(user),
        (None, _) => Err(Error::ChooseName),
    }
}

/// A database with no key file is left from a setup that stopped part way. Its key was never
/// saved, so nothing can open it, but it is moved aside rather than deleted.
fn set_aside_orphan_database(dir: &Path) -> Result<()> {
    for name in [DATABASE_FILE, "vault.db-wal", "vault.db-shm"] {
        let path = dir.join(name);
        if path.exists() {
            fs::rename(&path, dir.join(format!("{name}.unfinished-{}", now_ms())))?;
        }
    }
    Ok(())
}

/// Puts a backup's database and key file in `dir`, once the database has opened and been checked,
/// and returns the folder the vault already there was moved to, if there was one.
fn place_backup(dir: &Path, backup: Backup, database_key: &Key) -> Result<Option<PathBuf>> {
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
fn set_aside_vault(dir: &Path) -> Result<Option<PathBuf>> {
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

/// Binds a person's draft to them and to the collection whose key encrypts it.
fn draft_aad_for(vault_id: &Uuid, user_id: &str, collection_id: &Uuid) -> Vec<u8> {
    format!("glaze-vault v1 draft vault {vault_id} user {user_id} collection {collection_id}").into_bytes()
}

/// What a grant's sealed key is bound to. A batch operator's grant holds the batch key, under
/// other words, so it cannot be passed off as the collection's key.
fn grant_info(vault_id: &Uuid, collection_id: &Uuid, user_id: &Uuid, role: Role) -> Vec<u8> {
    let what = if role == Role::Operator {
        "batch-key"
    } else {
        "collection-key"
    };
    format!("glaze-vault v1 {what} vault {vault_id} collection {collection_id} user {user_id}").into_bytes()
}

/// A collection's batch sheets are encrypted with a key made from its key, which is all a batch
/// operator is given: it opens the sheets, and does not lead back to the recipes and materials.
pub(crate) fn batch_key(collection_key: &Key, collection_id: &Uuid) -> Key {
    crypto::narrower_key(
        collection_key,
        format!("glaze-vault v1 batch-key collection {collection_id}").as_bytes(),
    )
}

/// Binds a revision's content to where it belongs, so ciphertext cannot be moved to another
/// record, collection or place in the history.
fn revision_aad(
    id: &Uuid,
    record_id: &Uuid,
    kind: &str,
    collection_id: &Uuid,
    number: i64,
    parent: Option<&Uuid>,
    deleted: bool,
) -> Vec<u8> {
    let parent = parent.map(Uuid::to_string).unwrap_or_default();
    // Added only for a revision that deletes, so revisions saved before ADR 9 still open, and the
    // flag cannot be set or cleared without the key.
    let deleted = if deleted { " deleted" } else { "" };
    format!("glaze-vault v1 revision {id} record {record_id} kind {kind} collection {collection_id} number {number} parent {parent}{deleted}")
        .into_bytes()
}

/// The name a backup is shown by: its file's, without the folder.
fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn parse_id(text: &str) -> Result<Uuid> {
    Uuid::parse_str(text).map_err(|_| Error::Corrupt(format!("bad id {text}")))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PASSWORD: &str = "cone six oxidation";

    #[test]
    fn create_lock_and_unlock() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!Vault::exists(dir.path()));
        let (mut vault, recovery) = Vault::create(dir.path(), PASSWORD).unwrap();
        assert_eq!(recovery.words().len(), 24);
        let saved = vault
            .save(Kind::Recipe, None, &json!({ "name": "Leach 4321" }))
            .unwrap();
        drop(vault);

        assert!(Vault::exists(dir.path()));
        assert!(matches!(Vault::create(dir.path(), PASSWORD), Err(Error::VaultExists)));
        assert!(matches!(
            Vault::unlock(dir.path(), "wrong password"),
            Err(Error::WrongPassword)
        ));
        let vault = Vault::unlock(dir.path(), PASSWORD).unwrap();
        let recipes = vault.heads(Kind::Recipe).unwrap();
        assert_eq!(recipes.len(), 1);
        assert_eq!(recipes[0].revision_id, saved.revision_id);
        assert_eq!(recipes[0].content["name"], "Leach 4321");
    }

    #[test]
    fn short_passwords_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            Vault::create(dir.path(), "1234567"),
            Err(Error::PasswordTooShort(8))
        ));
        assert!(!Vault::exists(dir.path()));
    }

    #[test]
    fn nothing_readable_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        vault
            .save(
                Kind::Recipe,
                None,
                &json!({ "name": "Secret Celadon", "lines": [{ "material": "Whiting", "amount": 20 }] }),
            )
            .unwrap();
        drop(vault);
        for entry in fs::read_dir(dir.path()).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            let text = String::from_utf8_lossy(&bytes);
            assert!(!text.contains("Secret Celadon"));
            assert!(!text.contains("Whiting"));
            assert!(!text.starts_with("SQLite format 3"));
        }
    }

    #[test]
    fn recovery_key_resets_the_password() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, recovery) = Vault::create(dir.path(), PASSWORD).unwrap();
        vault.save(Kind::Recipe, None, &json!({ "name": "Tenmoku" })).unwrap();
        drop(vault);

        let words = recovery.words().join(" ");
        let other = RecoveryKey::generate().words().join(" ");
        assert!(matches!(
            Vault::recover(dir.path(), &other, "a new password"),
            Err(Error::WrongRecoveryKey)
        ));
        assert!(matches!(
            Vault::recover(dir.path(), "not words at all", "a new password"),
            Err(Error::WrongRecoveryKey)
        ));

        let vault = Vault::recover(dir.path(), &words, "a new password").unwrap();
        assert_eq!(vault.heads(Kind::Recipe).unwrap()[0].content["name"], "Tenmoku");
        drop(vault);
        assert!(matches!(Vault::unlock(dir.path(), PASSWORD), Err(Error::WrongPassword)));
        Vault::unlock(dir.path(), "a new password").unwrap();
        // The same sheet still works afterwards.
        Vault::recover(dir.path(), &words, "a third password").unwrap();
    }

    #[test]
    fn change_password_needs_the_current_one() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        assert!(matches!(
            vault.change_password("not it at all", "new password 1"),
            Err(Error::WrongPassword)
        ));
        vault.change_password(PASSWORD, "new password 1").unwrap();
        drop(vault);
        assert!(matches!(Vault::unlock(dir.path(), PASSWORD), Err(Error::WrongPassword)));
        Vault::unlock(dir.path(), "new password 1").unwrap();
    }

    #[test]
    fn revisions_chain_and_the_newest_is_listed() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let first = vault
            .save(Kind::Recipe, None, &json!({ "name": "Shino", "v": 1 }))
            .unwrap();
        let second = vault
            .save(
                Kind::Recipe,
                Some(first.revision_id),
                &json!({ "name": "Shino", "v": 2 }),
            )
            .unwrap();
        assert_eq!(second.record_id, first.record_id);
        assert_eq!(second.number, 2);
        vault.save(Kind::Recipe, None, &json!({ "name": "Ash" })).unwrap();

        let recipes = vault.heads(Kind::Recipe).unwrap();
        assert_eq!(recipes.len(), 2);
        let shino = recipes.iter().find(|r| r.record_id == first.record_id).unwrap();
        assert_eq!(shino.content["v"], 2);
        assert!(matches!(
            vault.save(Kind::Recipe, Some(Uuid::new_v4()), &json!({})),
            Err(Error::NotFound)
        ));
    }

    #[test]
    fn moved_ciphertext_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let a = vault.save(Kind::Recipe, None, &json!({ "name": "A" })).unwrap();
        let b = vault.save(Kind::Recipe, None, &json!({ "name": "B" })).unwrap();
        // Copy A's ciphertext onto B, as someone editing the database file directly might.
        vault
            .conn
            .execute(
                "UPDATE revisions SET nonce = (SELECT nonce FROM revisions WHERE id = ?1),
                 ciphertext = (SELECT ciphertext FROM revisions WHERE id = ?1) WHERE id = ?2",
                params![a.revision_id.to_string(), b.revision_id.to_string()],
            )
            .unwrap();
        assert!(matches!(vault.heads(Kind::Recipe), Err(Error::Corrupt(_))));
    }

    #[test]
    fn a_half_made_vault_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(DATABASE_FILE), b"left over").unwrap();
        Vault::create(dir.path(), PASSWORD).unwrap();
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().any(|n| n.starts_with("vault.db.unfinished-")));
    }

    fn names_in(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn a_backup_restores_on_another_computer() {
        let (home, elsewhere, files) = (
            tempfile::tempdir().unwrap(),
            tempfile::tempdir().unwrap(),
            tempfile::tempdir().unwrap(),
        );
        let (mut vault, _) = Vault::create(home.path(), PASSWORD).unwrap();
        vault
            .save(Kind::Recipe, None, &json!({ "name": "Secret Celadon" }))
            .unwrap();
        let settings = Settings {
            auto_lock: false,
            auto_lock_minutes: 5,
            backup_reminder_days: 7,
        };
        vault.set_settings(&settings).unwrap();
        let path = files.path().join("vault.gvbackup");
        let last = vault.back_up(&path).unwrap();
        assert_eq!(last.file_name, "vault.gvbackup");
        assert_eq!(vault.last_backup().unwrap().unwrap().at, last.at);

        let bytes = fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("Secret Celadon"));
        assert_eq!(Vault::backup_info(&path).unwrap().created_at, last.at);

        let target = elsewhere.path().join("vault");
        assert!(matches!(
            Vault::restore(&target, &path, None, &Credential::Password("wrong password")),
            Err(Error::WrongPassword)
        ));
        assert!(!target.exists());
        let (restored, set_aside) = Vault::restore(&target, &path, None, &Credential::Password(PASSWORD)).unwrap();
        assert!(set_aside.is_none());
        assert_eq!(
            restored.heads(Kind::Recipe).unwrap()[0].content["name"],
            "Secret Celadon"
        );
        assert_eq!(restored.settings().unwrap(), settings);
        drop(restored);
        Vault::unlock(&target, PASSWORD).unwrap();
    }

    #[test]
    fn restoring_over_a_vault_keeps_the_old_one_aside() {
        let (dir, files) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (mut vault, recovery) = Vault::create(dir.path(), PASSWORD).unwrap();
        vault.save(Kind::Recipe, None, &json!({ "name": "Before" })).unwrap();
        let path = files.path().join("b.gvbackup");
        vault.back_up(&path).unwrap();
        vault.save(Kind::Recipe, None, &json!({ "name": "After" })).unwrap();
        vault.change_password(PASSWORD, "changed since").unwrap();
        drop(vault);

        // The backup opens with the recovery key, and sets a new password.
        let words = recovery.words().join(" ");
        let credential = Credential::RecoveryKey {
            words: &words,
            new_password: "restored password",
        };
        let (restored, set_aside) = Vault::restore(dir.path(), &path, None, &credential).unwrap();
        let names: Vec<_> = restored
            .heads(Kind::Recipe)
            .unwrap()
            .iter()
            .map(|r| r.content["name"].clone())
            .collect();
        assert_eq!(names, vec![json!("Before")]);
        // The backup it came from counts as its latest.
        let last = restored.last_backup().unwrap().unwrap();
        assert_eq!(last.file_name, "b.gvbackup");
        assert_eq!(last.at, Vault::backup_info(&path).unwrap().created_at);
        drop(restored);
        Vault::unlock(dir.path(), "restored password").unwrap();

        let aside = set_aside.unwrap();
        assert!(aside.file_name().unwrap().to_string_lossy().starts_with("replaced-"));
        let old = Vault::unlock(&aside, "changed since").unwrap();
        assert_eq!(old.heads(Kind::Recipe).unwrap().len(), 2);
    }

    #[test]
    fn a_vault_set_aside_can_be_brought_back() {
        let (dir, files) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        vault.save(Kind::Recipe, None, &json!({ "name": "Before" })).unwrap();
        let path = files.path().join("b.gvbackup");
        vault.back_up(&path).unwrap();
        vault.save(Kind::Recipe, None, &json!({ "name": "After" })).unwrap();
        drop(vault);
        let (restored, _) = Vault::restore(dir.path(), &path, None, &Credential::Password(PASSWORD)).unwrap();
        drop(restored);

        let aside = Vault::set_aside(dir.path()).unwrap();
        assert_eq!(aside.len(), 1);
        let replaced = Vault::bring_back(dir.path(), &aside[0].name).unwrap().unwrap();
        assert!(!dir.path().join(&aside[0].name).exists());
        let back = Vault::unlock(dir.path(), PASSWORD).unwrap();
        assert_eq!(back.heads(Kind::Recipe).unwrap().len(), 2);
        drop(back);
        // The restored vault went aside in its place, to switch back to.
        let now = Vault::set_aside(dir.path()).unwrap();
        assert_eq!(now.len(), 1);
        assert_eq!(dir.path().join(&now[0].name), replaced);

        for name in ["../elsewhere", "replaced-", "replaced-1/..", "vault.keys"] {
            assert!(
                matches!(Vault::bring_back(dir.path(), name), Err(Error::NotFound)),
                "{name}"
            );
        }
        assert!(Vault::set_aside(&dir.path().join("missing")).unwrap().is_empty());
    }

    #[test]
    fn damaged_backups_and_other_files_are_refused() {
        let (dir, files) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
        let path = files.path().join("b.gvbackup");
        vault.back_up(&path).unwrap();
        drop(vault);
        let good = fs::read(&path).unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let restore = |bytes: &[u8]| {
            let path = files.path().join("try.gvbackup");
            fs::write(&path, bytes).unwrap();
            Vault::restore(elsewhere.path(), &path, None, &Credential::Password(PASSWORD)).map(|_| ())
        };

        let mut flipped = good.clone();
        *flipped.last_mut().unwrap() ^= 1;
        assert!(matches!(restore(&flipped), Err(Error::BackupDamaged)));
        assert!(matches!(restore(&good[..good.len() - 100]), Err(Error::BackupDamaged)));
        assert!(matches!(restore(&good[..20]), Err(Error::BackupDamaged)));
        assert!(matches!(restore(b"name,material,amount\n"), Err(Error::NotABackup)));
        assert!(
            names_in(elsewhere.path()).is_empty(),
            "a backup that fails writes nothing"
        );
        restore(&good).unwrap();
    }

    #[test]
    fn a_new_recovery_key_replaces_the_old_one() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, old) = Vault::create(dir.path(), PASSWORD).unwrap();
        assert!(matches!(
            vault.new_recovery_key("not the password"),
            Err(Error::WrongPassword)
        ));
        let new = vault.new_recovery_key(PASSWORD).unwrap();
        drop(vault);
        assert!(matches!(
            Vault::recover(dir.path(), &old.words().join(" "), "another password"),
            Err(Error::WrongRecoveryKey)
        ));
        Vault::recover(dir.path(), &new.words().join(" "), "another password").unwrap();
    }

    #[test]
    fn settings_have_defaults_and_limits() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        assert_eq!(vault.settings().unwrap(), Settings::default());
        assert!(vault.settings().unwrap().auto_lock);
        let zero = Settings {
            auto_lock_minutes: 0,
            ..Settings::default()
        };
        assert!(matches!(vault.set_settings(&zero), Err(Error::InvalidSetting(_))));
        let off = Settings {
            auto_lock: false,
            ..Settings::default()
        };
        vault.set_settings(&off).unwrap();
        drop(vault);
        assert_eq!(Vault::unlock(dir.path(), PASSWORD).unwrap().settings().unwrap(), off);
    }

    #[test]
    fn a_draft_is_kept_until_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        assert!(vault.draft().unwrap().is_none());
        vault
            .save_draft(&json!({ "content": { "name": "Half done" } }))
            .unwrap();
        vault.save_draft(&json!({ "content": { "name": "Newer" } })).unwrap();
        drop(vault);
        let mut vault = Vault::unlock(dir.path(), PASSWORD).unwrap();
        assert_eq!(vault.draft().unwrap().unwrap()["content"]["name"], "Newer");
        assert_eq!(vault.draft().unwrap().unwrap()["content"]["name"], "Newer");
        vault.clear_draft().unwrap();
        assert!(vault.draft().unwrap().is_none());
    }

    #[test]
    fn kinds_keep_their_own_lists_and_histories() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let recipe = vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
        let spar = vault
            .save(Kind::Material, None, &json!({ "name": "Custer, lot 7" }))
            .unwrap();
        let spar2 = vault
            .save(
                Kind::Material,
                Some(spar.revision_id),
                &json!({ "name": "Custer, lot 8" }),
            )
            .unwrap();
        let spar3 = vault
            .save(
                Kind::Material,
                Some(spar2.revision_id),
                &json!({ "name": "Custer, lot 9" }),
            )
            .unwrap();

        let recipes = vault.heads(Kind::Recipe).unwrap();
        assert_eq!(recipes.len(), 1);
        assert_eq!(recipes[0].content["name"], "Shino");
        let materials = vault.heads(Kind::Material).unwrap();
        assert_eq!(materials.len(), 1);
        assert_eq!(materials[0].revision_id, spar3.revision_id);

        let history = vault.history(Kind::Material, spar.record_id).unwrap();
        let names: Vec<_> = history.iter().map(|r| (r.number, r.content["name"].clone())).collect();
        assert_eq!(
            names,
            [
                (3, json!("Custer, lot 9")),
                (2, json!("Custer, lot 8")),
                (1, json!("Custer, lot 7"))
            ]
        );
        assert_eq!(vault.history(Kind::Recipe, recipe.record_id).unwrap().len(), 1);

        // A record is only found as its own kind, so a recipe cannot continue a material.
        assert!(matches!(
            vault.history(Kind::Recipe, spar.record_id),
            Err(Error::NotFound)
        ));
        assert!(matches!(
            vault.save(Kind::Recipe, Some(spar3.revision_id), &json!({})),
            Err(Error::NotFound)
        ));
    }

    #[test]
    fn a_revision_cannot_pass_as_another_kind() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        vault.save(Kind::Material, None, &json!({ "name": "Spar" })).unwrap();
        vault.conn.execute("UPDATE revisions SET kind = 'recipe'", []).unwrap();
        assert!(matches!(vault.heads(Kind::Recipe), Err(Error::Corrupt(_))));
    }

    #[test]
    fn saving_many_at_once_saves_all_or_none() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let first = vault.save(Kind::Material, None, &json!({ "name": "Spar" })).unwrap();
        let saved = vault
            .save_all(
                Kind::Material,
                None,
                &[
                    (None, json!({ "name": "Frit" })),
                    (Some(first.revision_id), json!({ "name": "Spar, lot 2" })),
                ],
            )
            .unwrap();
        assert_eq!(saved[1].record_id, first.record_id);
        assert_eq!(saved[1].number, 2);
        assert_eq!(vault.heads(Kind::Material).unwrap().len(), 2);

        // One that cannot be saved, here a parent that is not there, leaves out the rest too.
        let error = vault
            .save_all(
                Kind::Material,
                None,
                &[(None, json!({ "name": "Whiting" })), (Some(Uuid::new_v4()), json!({}))],
            )
            .unwrap_err();
        assert!(matches!(error, Error::NotFound));
        let names: Vec<_> = vault
            .heads(Kind::Material)
            .unwrap()
            .iter()
            .map(|r| r.content["name"].clone())
            .collect();
        assert_eq!(names.len(), 2);
        assert!(!names.contains(&json!("Whiting")));
        drop(vault);
        // And what was saved is still there after reopening.
        assert_eq!(
            Vault::unlock(dir.path(), PASSWORD)
                .unwrap()
                .heads(Kind::Material)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn deleting_hides_a_record_until_it_is_restored() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let first = vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
        let second = vault
            .save(Kind::Recipe, Some(first.revision_id), &json!({ "name": "Shino 2" }))
            .unwrap();
        // Only the newest revision can delete, so a delete cannot fork the record.
        assert!(matches!(
            vault.delete(Kind::Recipe, first.revision_id),
            Err(Error::NotFound)
        ));

        let gone = vault.delete(Kind::Recipe, second.revision_id).unwrap();
        assert!(gone.deleted);
        assert_eq!((gone.number, &gone.content), (3, &json!({ "name": "Shino 2" })));
        assert!(vault.heads(Kind::Recipe).unwrap().is_empty());
        assert_eq!(vault.deleted(Kind::Recipe).unwrap()[0].revision_id, gone.revision_id);
        assert_eq!(vault.history(Kind::Recipe, first.record_id).unwrap().len(), 2);
        assert!(matches!(
            vault.delete(Kind::Recipe, gone.revision_id),
            Err(Error::NotFound)
        ));

        let back = vault.save(Kind::Recipe, Some(gone.revision_id), &gone.content).unwrap();
        assert_eq!((back.number, back.deleted), (4, false));
        assert_eq!(vault.heads(Kind::Recipe).unwrap()[0].revision_id, back.revision_id);
        assert!(vault.deleted(Kind::Recipe).unwrap().is_empty());
    }

    #[test]
    fn erasing_removes_every_revision_of_a_deleted_record() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let kept = vault.save(Kind::Recipe, None, &json!({ "name": "Tenmoku" })).unwrap();
        let first = vault
            .save(Kind::Recipe, None, &json!({ "name": "Secret Celadon" }))
            .unwrap();
        let second = vault
            .save(
                Kind::Recipe,
                Some(first.revision_id),
                &json!({ "name": "Secret Celadon 2" }),
            )
            .unwrap();
        assert!(matches!(
            vault.erase(Kind::Recipe, first.record_id),
            Err(Error::NotDeleted)
        ));

        vault.delete(Kind::Recipe, second.revision_id).unwrap();
        assert_eq!(vault.erase(Kind::Recipe, first.record_id).unwrap(), 3);
        assert!(vault.deleted(Kind::Recipe).unwrap().is_empty());
        assert!(matches!(
            vault.history(Kind::Recipe, first.record_id),
            Err(Error::NotFound)
        ));
        assert_eq!(vault.heads(Kind::Recipe).unwrap()[0].record_id, kept.record_id);
        let left: i64 = vault
            .conn
            .query_row(
                "SELECT count(*) FROM revisions WHERE record_id = ?1",
                params![first.record_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn a_deletion_cannot_be_undone_without_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let saved = vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
        vault.delete(Kind::Recipe, saved.revision_id).unwrap();
        vault.conn.execute("UPDATE revisions SET deleted = 0", []).unwrap();
        assert!(matches!(vault.heads(Kind::Recipe), Err(Error::Corrupt(_))));
    }
}
