//! A vault: the database, its key file, and the keys of the person who unlocked it.
//!
//! A vault starts with one person and one collection (docs/adr/0006-one-person-first.md), stored the
//! way a team's is, so it can grow into one (docs/adr/0012-teams-on-one-computer.md, in `team`).

mod attachments;
mod audit;
mod backups;
mod events;
mod host;
mod host_backup;
mod host_key;
mod hosting;
mod items;
mod moving;
mod offline;
mod own_backups;
mod records;
mod replica;
mod roles;
mod signatures;
mod summaries;
mod team;

pub use attachments::{Attachment, AttachmentSigned, MAX_ATTACHMENT_BYTES};
pub use audit::{AuditEntry, AuditLog, Note};
use backups::place_backup;
pub use backups::{BackupInfo, LastBackup, SetAside};
pub(crate) use events::Body;
pub use host::HostStore;
pub use host_backup::{BACKUPS, ExportCopy, HOST_BACKUP_EXTENSION, HostBackup, RESTORE_FILE};
pub use offline::{OfflinePolicy, OfflineStatus, RoleLimit};
pub use own_backups::{OWN_BACKUPS_KEPT, OwnBackup};
pub use roles::{Capabilities, CustomRole};
pub use signatures::{SignatureCheck, Signed, SignedAs};
pub use team::{Collection, Grant, Person};

use crate::access::{Directory, Role};
use crate::crypto::{self, Key, KeyPair, PasswordKdf};
use crate::error::{Error, Result};
use crate::keyring::{self, Keyring, KeyringUser};
use crate::recovery::RecoveryKey;
use crate::signing::Signer;
use crate::store;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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
    /// Who is in the vault, who holds what on each collection, and the roles admins made: what
    /// the checks of who may do what read (access.rs).
    directory: Directory,
    /// This person's signing key, which signs what they save (ADR 19).
    signer: Signer,
    /// The records opened this sign-in, each noted in the audit log once.
    opened: HashSet<Uuid>,
    /// Whether firings are kept under each collection's summary key and every recipe revision has
    /// a summary (summaries.rs). Vaults from before are changed over by the first person to
    /// unlock who holds every collection's key.
    summaries: bool,
    /// On a replica: who is changing which records, as the host last said, and when it said so
    /// (plan section 3.5).
    checkouts: Option<(i64, Vec<crate::sync::Checkout>)>,
}

/// A collection this person can open.
struct OpenCollection {
    id: Uuid,
    name: String,
    /// The person whose private collection it is.
    owner: Option<Uuid>,
    role: Role,
    /// Which key this person's grant holds.
    held: Held,
    /// The collection's current key epoch (ADR 17): new revisions and attachments go under its key.
    epoch: i64,
    /// That epoch's key: the collection's, or one made from it.
    key: Key,
    /// The same key at each earlier epoch, newest first, for what was stored before it changed.
    older: Vec<(i64, Key)>,
}

/// Which of a collection's keys a grant holds. Only the collection's key leads to the others.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Held {
    /// The collection's key: everything in it.
    Collection,
    /// The batch key (batch_key): its batch sheets, for a batch operator.
    Batch,
    /// The summary key (summary_key): its recipes without their chemistry, and its firings and
    /// their photos, for a role that reads without chemistry.
    Summary,
}

impl OpenCollection {
    /// The collection's own key, which only a grant of the whole collection holds.
    fn full_key(&self) -> Result<&Key> {
        match self.held {
            Held::Collection => Ok(&self.key),
            _ => Err(Error::NotAllowed),
        }
    }

    /// The key this person holds at an epoch. Every earlier epoch is reachable from the current
    /// one, so only an epoch the collection has not had yet is missing.
    fn key_at(&self, epoch: i64) -> Result<&Key> {
        if epoch == self.epoch {
            return Ok(&self.key);
        }
        self.older
            .iter()
            .find(|(e, _)| *e == epoch)
            .map(|(_, key)| key)
            .ok_or_else(|| Error::Corrupt(format!("collection {} has no key epoch {epoch}", self.id)))
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
    /// A batch as it was mixed: when, how much, the lot of each material, and for a slip,
    /// deflocculant and water added in steps and readings as it aged (ADR 16). Under the batch
    /// key, so a batch operator logs the lots they weigh.
    Mix,
    /// A set of limits for a unity formula, to check recipes against (ADR 15).
    Limits,
    /// What materials cost, to cost recipes (ADR 15).
    Prices,
}

impl Kind {
    pub const ALL: [Kind; 7] = [
        Kind::Recipe,
        Kind::Material,
        Kind::Batch,
        Kind::Firing,
        Kind::Mix,
        Kind::Limits,
        Kind::Prices,
    ];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Kind::Recipe => "recipe",
            Kind::Material => "material",
            Kind::Batch => "batch",
            Kind::Firing => "firing",
            Kind::Mix => "mix",
            Kind::Limits => "limits",
            Kind::Prices => "prices",
        }
    }

    pub(crate) fn parse(text: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|kind| kind.as_str() == text)
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
    /// The record's other newest revisions, when it was changed in two places from the same one
    /// (ADR 5, 17): a fork, until someone chooses a version with [`Vault::resolve_fork`]. Only a
    /// record's listed revision has them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub forks: Vec<Fork>,
    /// The person who saved it.
    pub author: Uuid,
    /// Who signed it and whether it checks (ADR 19). Only a record's history has it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed: Option<Signed>,
}

/// Another newest revision of a forked record.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fork {
    pub revision_id: Uuid,
    pub saved_at: i64,
    /// This branch deleted the record, as on a computer that did not see the other change.
    pub deleted: bool,
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
                elsewhere: false,
            }],
            organization: None,
        };

        let conn = store::open(&dir.join(DATABASE_FILE), &database_key)?;
        let collection_id = Uuid::new_v4();
        let collection_key = crypto::random_key();
        let signer = Signer::new(vault_id, user_id, &keys);
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO meta (name, value) VALUES ('vault_id', ?1), ('default_collection', ?2), ('summaries', '1')",
            params![vault_id.to_string(), collection_id.to_string()],
        )?;
        events::mark_filled(&tx)?;
        audit::note(&tx, &signer, audit::Entry::new("created"))?;
        // Its person, its collection, and their grant of it.
        events::record(
            &tx,
            &signer,
            Body::PersonAdded {
                person: user_id,
                name: String::new(),
                public_key: keys.public.clone(),
            },
        )?;
        events::record(
            &tx,
            &signer,
            Body::CollectionCreated {
                collection: collection_id,
                name: String::new(),
                owner: None,
            },
        )?;
        events::record(
            &tx,
            &signer,
            team::grant_set(
                &vault_id,
                &user_id,
                &keys.public,
                &collection_id,
                &collection_key,
                1,
                Role::Admin,
                Held::Collection,
            ),
        )?;
        events::record(
            &tx,
            &signer,
            signatures::own_certificate(&vault_id, &keys, user_id, None),
        )?;
        tx.commit()?;
        keyring.write(&dir.join(KEYRING_FILE))?;

        let directory = Directory::load(&conn)?;
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
                held: Held::Collection,
                epoch: 1,
                key: collection_key,
                older: Vec::new(),
            }],
            default_collection: collection_id,
            organization: None,
            directory,
            signer,
            opened: HashSet::new(),
            summaries: true,
            checkouts: None,
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
        self.set_password(new_password)?;
        audit::note(&self.conn, &self.signer, audit::Entry::new("password-changed"))
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
        audit::note(&self.conn, &self.signer, audit::Entry::new("recovery-key-changed"))?;
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
        let collection = self.draft_collection()?;
        let sealed = SealedDraft {
            epoch: collection.epoch,
            sealed: crypto::encrypt(&collection.key, &plaintext, &self.draft_aad()?),
        };
        self.set_meta(&self.draft_name(), &serde_json::to_string(&sealed)?)
    }

    /// The kept draft, if there is one.
    pub fn draft(&self) -> Result<Option<serde_json::Value>> {
        let Some(json) = self.meta(&self.draft_name())? else {
            return Ok(None);
        };
        let draft: SealedDraft = serde_json::from_str(&json)?;
        let key = self.draft_collection()?.key_at(draft.epoch)?;
        let plaintext = crypto::decrypt(key, &draft.sealed, &self.draft_aad()?)
            .ok_or_else(|| Error::Corrupt("the saved draft does not decrypt".into()))?;
        Ok(Some(serde_json::from_slice(&plaintext)?))
    }

    /// Forgets the draft, once its edits are saved or discarded.
    pub fn clear_draft(&mut self) -> Result<()> {
        self.conn
            .execute("DELETE FROM meta WHERE name = ?1", params![self.draft_name()])?;
        Ok(())
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
        team::finish_organization_change(&conn, &mut keyring, dir)?;
        events::fill(&conn, &keyring, Some((user_id, &keys.public)))?;
        let default_collection: String =
            conn.query_row("SELECT value FROM meta WHERE name = 'default_collection'", [], |row| {
                row.get(0)
            })?;
        let organization = match (&keyring.organization, &keyring.user(&user_id)?.organization_key) {
            (Some(_), Some(sealed)) => Some(team::open_organization_key(&keyring, &keys, user_id, sealed)?),
            _ => None,
        };
        let signer = Signer::new(keyring.vault_id, user_id, &keys);
        let mut vault = Vault {
            dir: dir.to_owned(),
            keyring,
            user_id,
            keys,
            conn,
            collections: Vec::new(),
            default_collection: parse_id(&default_collection)?,
            organization,
            directory: Directory::default(),
            signer,
            opened: HashSet::new(),
            summaries: false,
            checkouts: None,
        };
        vault.summaries = vault.meta(summaries::META)?.is_some();
        vault.load_collections()?;
        // A change-over that fails, as over a record that does not decrypt, is tried again at the
        // next unlock; it does not keep anyone out. Until it is done, nobody can be given a role
        // that reads without chemistry.
        let _ = vault.change_to_summaries();
        // Likewise certifying this person's signing key, and vouching for what was saved before
        // signing (signatures.rs), which needs the change-over done first: it changes rows.
        let _ = vault.certify_myself();
        let _ = vault.attest();
        // Best effort, like attesting: a host converted before ADR 34 gets its certificate.
        let _ = vault.certify_pinned_host();
        audit::note(&vault.conn, &vault.signer, audit::Entry::new("signed-in"))?;
        if vault.is_replica() {
            vault.note_time()?;
        }
        Ok(vault)
    }

    /// Reads the directory again, and opens the keys of every collection granted to this person,
    /// and of all of them for an admin. Someone who must still choose their own password opens
    /// none.
    fn load_collections(&mut self) -> Result<()> {
        self.directory = Directory::load(&self.conn)?;
        self.collections.clear();
        let catching_up = self.is_replica();
        if self.user().must_set_password {
            return Ok(());
        }
        type Row = (String, String, Option<String>, String, Vec<u8>, Vec<u8>, i64, i64);
        let mut statement = self.conn.prepare(
            "SELECT c.id, c.name, c.owner_id, g.role, g.enc, g.ciphertext, g.epoch, c.epoch
             FROM grants g JOIN collections c ON c.id = g.collection_id WHERE g.user_id = ?1
             ORDER BY c.created_at, c.rowid",
        )?;
        let rows = statement
            .query_map(params![self.user_id.to_string()], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<Row>>>()?;
        drop(statement);
        let mut collections = Vec::new();
        for (id, name, owner, role, enc, ciphertext, epoch, current) in rows {
            let id = parse_id(&id)?;
            let role = parse_role(&role)?;
            let held = self.held(role);
            // Every grant is sealed again when its collection's key changes (team::new_epoch). A
            // replica may have the new grant before the new key's event, which comes with the
            // collection's items (ADR 20): the collection stays closed until it has both.
            if epoch != current {
                if catching_up {
                    continue;
                }
                return Err(Error::Corrupt(format!(
                    "a grant on collection {id} is from an earlier key"
                )));
            }
            let key = crypto::open_key(
                &self.keys,
                &crypto::SealedBox { enc, ciphertext },
                &grant_info(&self.keyring.vault_id, &id, &self.user_id, held, epoch),
            )
            .ok_or_else(|| Error::Corrupt("a collection key does not open".into()))?;
            let older = match older_keys(&self.conn, &self.keyring.vault_id, &id, held, epoch, &key) {
                Err(_) if catching_up => continue,
                older => older?,
            };
            collections.push(OpenCollection {
                id,
                name,
                owner: owner.as_deref().map(parse_id).transpose()?,
                role,
                held,
                epoch,
                key,
                older,
            });
        }
        if let Some(organization) = &self.organization {
            for collection in team::organization_collections(&self.conn, &self.keyring, organization, catching_up)? {
                match collections.iter_mut().find(|c| c.id == collection.id) {
                    // An admin's own grant may hold only a batch or summary key.
                    Some(granted) => *granted = collection,
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

    /// A collection this person may change records of a kind in.
    fn editable(&self, id: &Uuid, kind: Kind) -> Result<&OpenCollection> {
        let collection = self.readable(id)?;
        if !self.directory.may_change(self.user_id, *id, kind) {
            return Err(Error::NotAllowed);
        }
        Ok(collection)
    }

    /// The key records of a kind are encrypted with in a collection, if this person may read
    /// them. A recipe's own ciphertext needs the collection's key; its summary is read with
    /// summary_key_for.
    fn key_for(&self, collection: &OpenCollection, kind: Kind, epoch: i64) -> Result<Option<Key>> {
        let readable = match collection.held {
            Held::Collection => true,
            Held::Batch => matches!(kind, Kind::Batch | Kind::Mix),
            Held::Summary => kind == Kind::Firing,
        };
        if !readable {
            return Ok(None);
        }
        let key = collection.key_at(epoch)?;
        Ok(Some(match collection.held {
            Held::Collection => kind_key(key, kind, &collection.id, self.summaries),
            _ => key.clone(),
        }))
    }

    /// The key a collection's recipe summaries are under at an epoch, if this person may read them.
    fn summary_key_for(&self, collection: &OpenCollection, epoch: i64) -> Result<Option<Key>> {
        Ok(match collection.held {
            Held::Collection => Some(summary_key(collection.key_at(epoch)?, &collection.id)),
            Held::Summary => Some(collection.key_at(epoch)?.clone()),
            Held::Batch => None,
        })
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

/// A draft, under its collection's key at an epoch: the epoch it was saved at, since a change of
/// key leaves it as it was. Drafts from before epochs have none, and are at the first.
#[derive(Serialize, Deserialize)]
struct SealedDraft {
    #[serde(default = "first_epoch")]
    epoch: i64,
    #[serde(flatten)]
    sealed: crypto::Sealed,
}

fn first_epoch() -> i64 {
    1
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
    /// On a phone, keep backups where the phone's own backup takes them
    /// (docs/adr/0028-a-phones-own-vault.md).
    pub phone_backups: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            auto_lock: true,
            auto_lock_minutes: 15,
            backup_reminder_days: 30,
            phone_backups: true,
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
        (Some(id), _) => keyring.user(&id).and_then(|user| match user.elsewhere {
            true => Err(Error::NoSuchPerson),
            false => Ok(user),
        }),
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

/// Binds a person's draft to them and to the collection whose key encrypts it.
fn draft_aad_for(vault_id: &Uuid, user_id: &str, collection_id: &Uuid) -> Vec<u8> {
    format!("glaze-vault v1 draft vault {vault_id} user {user_id} collection {collection_id}").into_bytes()
}

/// Runs `step` all or none, whether or not the caller has begun a transaction: a savepoint.
pub(crate) fn atomically<T>(conn: &Connection, step: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    conn.execute_batch("SAVEPOINT step")?;
    match step(conn) {
        Ok(value) => {
            conn.execute_batch("RELEASE step")?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK TO step; RELEASE step");
            Err(error)
        }
    }
}

/// What the change log lists besides events (ADR 17, 18).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Change {
    Revision,
    Attachment,
}

/// Adds an item to the end of this store's change log.
pub(crate) fn log_change(conn: &Connection, change: Change, id: &Uuid, collection: &Uuid, kind: Kind) -> Result<()> {
    let item = match change {
        Change::Revision => "revision",
        Change::Attachment => "attachment",
    };
    conn.execute(
        "INSERT INTO changes (item, item_id, collection_id, kind) VALUES (?1, ?2, ?3, ?4)",
        params![item, id.to_string(), collection.to_string(), kind.as_str()],
    )?;
    Ok(())
}

impl Fork {
    fn of(revision: &Revision) -> Fork {
        Fork {
            revision_id: revision.revision_id,
            saved_at: revision.saved_at,
            deleted: revision.deleted,
        }
    }
}

/// How a revision keeps the revisions it supersedes: their ids in order, comma-separated.
fn supersedes_list(ids: &[Uuid]) -> String {
    let mut ids: Vec<String> = ids.iter().map(Uuid::to_string).collect();
    ids.sort();
    ids.dedup();
    ids.join(",")
}

/// What a grant's sealed key is bound to. A grant of the batch or summary key holds it under other
/// words, so it cannot be passed off as the collection's key.
fn grant_info(vault_id: &Uuid, collection_id: &Uuid, user_id: &Uuid, held: Held, epoch: i64) -> Vec<u8> {
    let what = held_words(held);
    format!(
        "glaze-vault v1 {what} vault {vault_id} collection {collection_id} user {user_id}{}",
        epoch_words(epoch)
    )
    .into_bytes()
}

fn held_words(held: Held) -> &'static str {
    match held {
        Held::Collection => "collection-key",
        Held::Batch => "batch-key",
        Held::Summary => "summary-key",
    }
}

/// Binds a sealed key to its epoch, so a grant cannot hand over an earlier key as the current one.
/// Keys sealed before epochs, at the first, say nothing, so they still open.
pub(crate) fn epoch_words(epoch: i64) -> String {
    if epoch == 1 {
        String::new()
    } else {
        format!(" epoch {epoch}")
    }
}

/// What a collection's key at `epoch` - 1 is bound to, wrapped under its key at `epoch`
/// (collection_epochs), for each of the keys a grant may hold.
pub(crate) fn epoch_aad(vault_id: &Uuid, collection_id: &Uuid, epoch: i64, held: Held) -> Vec<u8> {
    let what = held_words(held);
    format!(
        "glaze-vault v1 {what} vault {vault_id} collection {collection_id} epoch {} under epoch {epoch}",
        epoch - 1
    )
    .into_bytes()
}

/// A collection's key, as `held`, at every epoch before `epoch`, newest first: each one unwrapped
/// with the one after it.
pub(crate) fn older_keys(
    conn: &Connection,
    vault_id: &Uuid,
    collection_id: &Uuid,
    held: Held,
    epoch: i64,
    key: &Key,
) -> Result<Vec<(i64, Key)>> {
    let column = match held {
        Held::Collection => "previous",
        Held::Batch => "previous_batch",
        Held::Summary => "previous_summary",
    };
    let mut statement = conn.prepare(&format!(
        "SELECT epoch, {column} FROM collection_epochs WHERE collection_id = ?1 AND epoch <= ?2 ORDER BY epoch DESC"
    ))?;
    let wraps = statement
        .query_map(params![collection_id.to_string(), epoch], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut older: Vec<(i64, Key)> = Vec::new();
    let mut expected = epoch;
    for (at, wrapped) in wraps {
        if at != expected || at < 2 {
            return Err(Error::Corrupt(format!(
                "collection {collection_id} is missing key epoch {expected}"
            )));
        }
        let under = older.last().map_or(key, |(_, key)| key);
        let previous = crypto::Sealed::from_bytes(&wrapped)
            .and_then(|sealed| crypto::decrypt(under, &sealed, &epoch_aad(vault_id, collection_id, at, held)))
            .and_then(|plain| <[u8; 32]>::try_from(plain.as_slice()).ok())
            .ok_or_else(|| {
                Error::Corrupt(format!(
                    "key epoch {} of collection {collection_id} does not open",
                    at - 1
                ))
            })?;
        older.push((at - 1, Zeroizing::new(previous)));
        expected = at - 1;
    }
    if expected != 1 {
        return Err(Error::Corrupt(format!(
            "collection {collection_id} is missing key epoch {expected}"
        )));
    }
    Ok(older)
}

/// A collection's batch sheets are encrypted with a key made from its key, which is all a batch
/// operator is given: it opens the sheets, and does not lead back to the recipes and materials.
pub(crate) fn batch_key(collection_key: &Key, collection_id: &Uuid) -> Key {
    crypto::narrower_key(
        collection_key,
        format!("glaze-vault v1 batch-key collection {collection_id}").as_bytes(),
    )
}

/// A collection's recipe summaries, firings and their photos are encrypted with a key made from its
/// key: a role that reads without chemistry is given it, and it does not lead back to the recipes'
/// lines, the materials or the batch sheets.
pub(crate) fn summary_key(collection_key: &Key, collection_id: &Uuid) -> Key {
    crypto::narrower_key(
        collection_key,
        format!("glaze-vault v1 summary-key collection {collection_id}").as_bytes(),
    )
}

/// What records of a kind in a collection are encrypted with, from the collection's key: batch
/// sheets and mixes under the batch key, firings under the summary key once the vault keeps summaries, and
/// everything else under the collection's.
pub(crate) fn kind_key(collection_key: &Key, kind: Kind, collection_id: &Uuid, summaries: bool) -> Key {
    match kind {
        Kind::Batch | Kind::Mix => batch_key(collection_key, collection_id),
        Kind::Firing if summaries => summary_key(collection_key, collection_id),
        _ => collection_key.clone(),
    }
}

/// Binds a revision's content to where it belongs, so ciphertext cannot be moved to another
/// record, collection or place in the history.
#[allow(clippy::too_many_arguments)]
fn revision_aad(
    id: &Uuid,
    record_id: &Uuid,
    kind: &str,
    collection_id: &Uuid,
    number: i64,
    parent: Option<&Uuid>,
    deleted: bool,
    supersedes: Option<&str>,
) -> Vec<u8> {
    let parent = parent.map(Uuid::to_string).unwrap_or_default();
    // Added only for a revision that deletes, so revisions saved before ADR 9 still open, and the
    // flag cannot be set or cleared without the key.
    let deleted = if deleted { " deleted" } else { "" };
    // Likewise only for one that resolves a fork (ADR 17), so the revisions it sets aside cannot
    // be changed without the key.
    let supersedes = supersedes.map(|list| format!(" supersedes {list}")).unwrap_or_default();
    format!("glaze-vault v1 revision {id} record {record_id} kind {kind} collection {collection_id} number {number} parent {parent}{deleted}{supersedes}")
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

fn parse_role(text: &str) -> Result<Role> {
    Role::parse(text).ok_or_else(|| Error::Corrupt(format!("unknown role {text}")))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
