//! A team on one computer (docs/adr/0012-teams-on-one-computer.md): growing a one-person vault,
//! people, collections and what each person may do in them.

use super::{KEYRING_FILE, OpenCollection, Vault, check_password, grant_info, now_ms, parse_id, revision_aad};
use crate::access::Role;
use crate::crypto::{self, Key, KeyPair, PasswordKdf, SealedBox};
use crate::error::{Error, Result};
use crate::keyring::{self, Keyring, KeyringUser, Organization};
use crate::recovery::RecoveryKey;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::path::Path;
use uuid::Uuid;
use zeroize::Zeroizing;

/// The name of the collection a one-person vault's records go into when it grows.
const SHARED: &str = "Shared";

/// Someone in the vault, as the lock screen and the people list show them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: Uuid,
    pub name: String,
    pub admin: bool,
    /// Added by an admin and not signed in since.
    pub must_set_password: bool,
}

/// A collection this person can open, and what they may do in it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: Uuid,
    pub name: String,
    /// The person whose private collection it is.
    pub owner: Option<Uuid>,
    pub role: Role,
}

/// One person's role on one collection, for the people screen.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub person: Uuid,
    pub collection: Uuid,
    pub role: Role,
}

impl Vault {
    /// The people in a vault, read from its key file before anyone unlocks it. Empty for a
    /// one-person vault, which asks for no name.
    pub fn people_in(dir: &Path) -> Result<Vec<Person>> {
        let keyring = super::read_keyring(dir)?;
        if keyring.organization.is_none() {
            return Ok(Vec::new());
        }
        Ok(people(&keyring))
    }

    pub fn is_team(&self) -> bool {
        self.keyring.organization.is_some()
    }

    /// The person who unlocked the vault.
    pub fn me(&self) -> Person {
        person(self.user())
    }

    /// Everyone in a team's vault, for an admin.
    pub fn people(&self) -> Result<Vec<Person>> {
        self.admin()?;
        Ok(people(&self.keyring))
    }

    /// The collections this person can open.
    pub fn collections(&self) -> Vec<Collection> {
        self.collections
            .iter()
            .map(|c| Collection {
                id: c.id,
                name: c.name.clone(),
                owner: c.owner,
                role: c.role,
            })
            .collect()
    }

    /// Every grant in the vault, for an admin.
    pub fn grants(&self) -> Result<Vec<Grant>> {
        self.admin()?;
        let mut statement = self
            .conn
            .prepare("SELECT user_id, collection_id, role FROM grants ORDER BY user_id")?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(person, collection, role)| {
                Ok(Grant {
                    person: parse_id(&person)?,
                    collection: parse_id(&collection)?,
                    role: Role::parse(&role).ok_or_else(|| Error::Corrupt(format!("unknown role {role}")))?,
                })
            })
            .collect()
    }

    /// Makes a one-person vault a team's, with this person as its first admin, named `name`.
    /// Returns the organization's recovery key, to show once (ADR 3).
    pub fn grow_into_team(&mut self, name: &str) -> Result<RecoveryKey> {
        if self.is_team() {
            return Err(Error::AlreadyATeam);
        }
        let name = checked_name(&self.keyring, name, Some(self.user_id))?;
        let draft = self.draft()?;
        let vault_id = self.keyring.vault_id;
        let organization = KeyPair::generate();
        let recovery = RecoveryKey::generate();
        let database_key = self.database_key()?;

        let mut keyring = self.keyring.clone();
        keyring.organization = Some(Organization {
            public_key: organization.public.clone(),
            private_key_by_recovery: crypto::encrypt(
                &crypto::recovery_key(&recovery.entropy(), vault_id.as_bytes()),
                &organization.secret,
                &keyring::organization_recovery_aad(&vault_id),
            ),
            database_key: crypto::seal_key(
                &organization.public,
                &database_key,
                &keyring::organization_database_key_info(&vault_id),
            ),
        });
        let user = super::user_mut(&mut keyring, &self.user_id);
        user.name = name;
        user.public_key = self.keys.public.clone();
        user.organization_key = Some(seal_organization_key(&vault_id, user, &organization));

        // Every collection key is sealed to the organization, the first is named, and the admin
        // gets a private collection.
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE collections SET name = ?1 WHERE id = ?2 AND name = ''",
            params![SHARED, self.default_collection.to_string()],
        )?;
        for collection in &self.collections {
            insert_organization_grant(&tx, &vault_id, &organization.public, &collection.id, &collection.key)?;
        }
        // A vault that was a team's before keeps the private collection it had.
        if !self.collections.iter().any(|c| c.owner == Some(self.user_id)) {
            let private = create_collection(&tx, "", Some(self.user_id))?;
            insert_grant(
                &tx,
                &vault_id,
                &self.user_id,
                &self.keys.public,
                &private.0,
                &private.1,
                Role::Formulator,
            )?;
            insert_organization_grant(&tx, &vault_id, &organization.public, &private.0, &private.1)?;
        }
        tx.commit()?;
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        self.keyring = keyring;
        self.organization = Some(organization);
        self.load_collections()?;
        // The draft moves to the private collection's key, which drafts use in a team's vault.
        if let Some(draft) = draft {
            self.save_draft(&draft)?;
        }
        Ok(recovery)
    }

    /// Adds a person with a one-time password to pass on, and roles on collections. They choose
    /// their own password, and get their recovery key, when they first sign in.
    pub fn add_person(&mut self, name: &str, one_time_password: &str, roles: &[(Uuid, Role)]) -> Result<Person> {
        let organization = self.admin()?;
        check_password(one_time_password)?;
        let name = checked_name(&self.keyring, name, None)?;
        let vault_id = self.keyring.vault_id;
        let id = Uuid::new_v4();
        let keys = KeyPair::generate();
        let database_key = self.database_key()?;
        let user = new_user(&vault_id, id, name, &keys, one_time_password, &database_key);
        let organization_public = organization.public.clone();

        let tx = self.conn.unchecked_transaction()?;
        let private = create_collection(&tx, "", Some(id))?;
        insert_grant(
            &tx,
            &vault_id,
            &id,
            &keys.public,
            &private.0,
            &private.1,
            Role::Formulator,
        )?;
        insert_organization_grant(&tx, &vault_id, &organization_public, &private.0, &private.1)?;
        for (collection, role) in roles {
            let collection = self.readable(collection)?;
            insert_grant(
                &tx,
                &vault_id,
                &id,
                &keys.public,
                &collection.id,
                &collection.key,
                *role,
            )?;
        }
        tx.commit()?;
        let mut keyring = self.keyring.clone();
        keyring.users.push(user);
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        self.keyring = keyring;
        self.load_collections()?;
        Ok(person(self.keyring.user(&id)?))
    }

    /// At a person's first sign-in: sets the password they chose and returns their recovery key,
    /// to show once. Until then they can open nothing.
    pub fn set_own_password(&mut self, new_password: &str) -> Result<RecoveryKey> {
        if !self.user().must_set_password {
            return Err(Error::NotAllowed);
        }
        check_password(new_password)?;
        let recovery = RecoveryKey::generate();
        let vault_id = self.keyring.vault_id;
        let kdf = PasswordKdf::new();
        let mut keyring = self.keyring.clone();
        let user = super::user_mut(&mut keyring, &self.user_id);
        user.private_key = crypto::encrypt(
            &kdf.derive(new_password),
            &self.keys.secret,
            &keyring::private_key_aad(&vault_id, &self.user_id, "password"),
        );
        user.password_kdf = kdf;
        user.private_key_by_recovery = Some(crypto::encrypt(
            &crypto::recovery_key(&recovery.entropy(), self.user_id.as_bytes()),
            &self.keys.secret,
            &keyring::private_key_aad(&vault_id, &self.user_id, "recovery"),
        ));
        user.must_set_password = false;
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        self.keyring = keyring;
        self.load_collections()?;
        Ok(recovery)
    }

    /// Gives a person a role on a collection, or with None takes it away. Taking it away gives the
    /// collection a new key, since they may have kept the old one (ADR 3).
    pub fn set_role(&mut self, person: Uuid, collection: Uuid, role: Option<Role>) -> Result<()> {
        self.admin()?;
        let user = self.keyring.user(&person)?.clone();
        let vault_id = self.keyring.vault_id;
        match role {
            Some(role) => {
                let previous: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT role FROM grants WHERE user_id = ?1 AND collection_id = ?2",
                        params![person.to_string(), collection.to_string()],
                        |row| row.get(0),
                    )
                    .optional()?;
                // Someone who held the collection's key and now gets only its batch key may have
                // kept the first, so the collection gets a new one.
                if role == Role::Operator && previous.is_some_and(|previous| previous != Role::Operator.as_str()) {
                    self.conn.execute(
                        "DELETE FROM grants WHERE user_id = ?1 AND collection_id = ?2",
                        params![person.to_string(), collection.to_string()],
                    )?;
                    self.rotate_collection_key(&collection)?;
                    self.load_collections()?;
                }
                let collection = self.readable(&collection)?;
                let tx = self.conn.unchecked_transaction()?;
                tx.execute(
                    "DELETE FROM grants WHERE user_id = ?1 AND collection_id = ?2",
                    params![person.to_string(), collection.id.to_string()],
                )?;
                insert_grant(
                    &tx,
                    &vault_id,
                    &person,
                    &user.public_key,
                    &collection.id,
                    &collection.key,
                    role,
                )?;
                tx.commit()?;
            }
            None => {
                let removed = self.conn.execute(
                    "DELETE FROM grants WHERE user_id = ?1 AND collection_id = ?2",
                    params![person.to_string(), collection.to_string()],
                )?;
                if removed > 0 {
                    self.rotate_collection_key(&collection)?;
                }
            }
        }
        self.load_collections()
    }

    /// Takes a person out of the vault. Every collection they could open, and the database, get
    /// new keys. Their private collection stays, for admins. Nobody removes themselves.
    pub fn remove_person(&mut self, person: Uuid) -> Result<()> {
        self.admin()?;
        if person == self.user_id {
            return Err(Error::NotAllowed);
        }
        // An admin holds the organization's private key, which opens every collection's key, so
        // removing one needs a new organization key: not built yet.
        if self.keyring.user(&person)?.organization_key.is_some() {
            return Err(Error::RemovingAdmin);
        }
        let mut statement = self
            .conn
            .prepare("SELECT collection_id FROM grants WHERE user_id = ?1")?;
        let theirs = statement
            .query_map(params![person.to_string()], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        self.conn
            .execute("DELETE FROM grants WHERE user_id = ?1", params![person.to_string()])?;
        let mut keyring = self.keyring.clone();
        keyring.users.retain(|user| user.id != person);
        self.keyring = keyring;
        self.rotate_database_key()?;
        for collection in theirs {
            self.rotate_collection_key(&parse_id(&collection)?)?;
        }
        self.load_collections()
    }

    /// Gives someone who lost both their password and their recovery sheet a new one-time
    /// password. They get new keys, so their old sheet stops working, and they choose a password
    /// and get a new sheet at their next sign-in, as when they were added.
    pub fn reset_person(&mut self, person: Uuid, one_time_password: &str) -> Result<()> {
        let organization = self.admin()?;
        if person == self.user_id {
            return Err(Error::NotAllowed);
        }
        check_password(one_time_password)?;
        let database_key = self.database_key()?;
        let mut keyring = self.keyring.clone();
        rekey_person(
            &self.conn,
            &mut keyring,
            organization,
            &database_key,
            person,
            one_time_password,
            true,
        )?;
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        self.keyring = keyring;
        Ok(())
    }

    /// Makes someone an admin: the organization key is sealed to them. Taking it back, or removing
    /// an admin, needs a new organization key, which comes later.
    pub fn make_admin(&mut self, person: Uuid) -> Result<()> {
        let organization = self.admin()?;
        let vault_id = self.keyring.vault_id;
        let mut keyring = self.keyring.clone();
        let user = super::user_mut(&mut keyring, &person);
        if user.public_key.is_empty() {
            return Err(Error::NoSuchPerson);
        }
        user.organization_key = Some(seal_organization_key(&vault_id, user, organization));
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        self.keyring = keyring;
        Ok(())
    }

    /// Makes a collection to share, which only admins can open until they give others roles on it.
    pub fn create_collection(&mut self, name: &str) -> Result<Collection> {
        let organization = self.admin()?.public.clone();
        let name = collection_name(name)?;
        let tx = self.conn.unchecked_transaction()?;
        let (id, key) = create_collection(&tx, &name, None)?;
        insert_organization_grant(&tx, &self.keyring.vault_id, &organization, &id, &key)?;
        tx.commit()?;
        self.load_collections()?;
        Ok(Collection {
            id,
            name,
            owner: None,
            role: Role::Admin,
        })
    }

    pub fn rename_collection(&mut self, id: Uuid, name: &str) -> Result<()> {
        self.admin()?;
        let name = collection_name(name)?;
        if self.readable(&id)?.owner.is_some() {
            return Err(Error::NotAllowed);
        }
        self.conn.execute(
            "UPDATE collections SET name = ?1 WHERE id = ?2",
            params![name, id.to_string()],
        )?;
        self.load_collections()
    }

    /// When every admin has lost their password and recovery sheet: the organization's recovery
    /// key gives an admin new keys and a new password, and returns their new recovery key.
    pub fn recover_organization(
        dir: &Path,
        words: &str,
        admin: Uuid,
        new_password: &str,
    ) -> Result<(Vault, RecoveryKey)> {
        check_password(new_password)?;
        let mut keyring = super::read_keyring(dir)?;
        let (organization, database_key) = open_by_organization_recovery(&keyring, words)?;
        if keyring.user(&admin)?.organization_key.is_none() {
            return Err(Error::NotAllowed);
        }
        let conn = crate::store::open(&dir.join(super::DATABASE_FILE), &database_key)?;
        rekey_person(
            &conn,
            &mut keyring,
            &organization,
            &database_key,
            admin,
            new_password,
            false,
        )?;
        keyring.write(&dir.join(KEYRING_FILE))?;
        drop(conn);
        let mut vault = Vault::unlock_as(dir, Some(admin), new_password)?;
        let recovery = vault.new_recovery_key(new_password)?;
        Ok((vault, recovery))
    }

    /// Restores a team's backup with the organization's recovery key, giving `admin` a new
    /// password as [`Vault::recover_organization`] does.
    pub fn restore_by_organization(
        dir: &Path,
        path: &Path,
        words: &str,
        admin: Uuid,
        new_password: &str,
    ) -> Result<(Vault, Option<std::path::PathBuf>, RecoveryKey)> {
        check_password(new_password)?;
        let backup = crate::backup::Backup::open(path)?;
        let (_, database_key) = open_by_organization_recovery(&backup.header.keyring, words)?;
        if backup.header.keyring.user(&admin)?.organization_key.is_none() {
            return Err(Error::NotAllowed);
        }
        let created_at = backup.header.created_at;
        let set_aside = super::place_backup(dir, backup, &database_key)?;
        let (mut vault, recovery) = Vault::recover_organization(dir, words, admin, new_password)?;
        vault.record_restored(created_at, path)?;
        Ok((vault, set_aside, recovery))
    }

    /// Makes a team's vault one person's again, this admin's (ADR 6). Everyone else is removed;
    /// their private collections stay, named "From" them. The organization key goes, and every
    /// collection and the database get new keys, so this person's password and recovery key are
    /// once more the only ways in. A backup is made first, beside the vault, and its path returned.
    pub fn go_back_to_one_person(&mut self) -> Result<std::path::PathBuf> {
        self.admin()?;
        let backup = self
            .dir
            .join(format!("before-one-person-{}.{}", now_ms(), crate::backup::EXTENSION));
        self.back_up(&backup)?;
        let vault_id = self.keyring.vault_id;
        let me = self.user_id;
        let others: Vec<(Uuid, String)> = self
            .keyring
            .users
            .iter()
            .filter(|user| user.id != me)
            .map(|user| (user.id, user.name.clone()))
            .collect();

        // This person keeps every collection, as a one-person vault's person does.
        let tx = self.conn.unchecked_transaction()?;
        for collection in &self.collections {
            tx.execute(
                "DELETE FROM grants WHERE user_id = ?1 AND collection_id = ?2",
                params![me.to_string(), collection.id.to_string()],
            )?;
            insert_grant(
                &tx,
                &vault_id,
                &me,
                &self.keys.public,
                &collection.id,
                &collection.key,
                Role::Admin,
            )?;
        }
        tx.execute("DELETE FROM grants WHERE user_id != ?1", params![me.to_string()])?;
        for (id, name) in &others {
            tx.execute(
                "UPDATE collections SET name = ?1, owner_id = NULL WHERE owner_id = ?2",
                params![format!("From {name}"), id.to_string()],
            )?;
        }
        tx.commit()?;
        let collections: Vec<Uuid> = self.collections.iter().map(|c| c.id).collect();
        for collection in &collections {
            self.rotate_collection_key(collection)?;
        }
        self.conn.execute("DELETE FROM organization_grants", [])?;

        let mut keyring = self.keyring.clone();
        keyring.users.retain(|user| user.id == me);
        keyring.organization = None;
        super::user_mut(&mut keyring, &me).organization_key = None;
        self.keyring = keyring;
        self.organization = None;
        // Writes the key file, now without the organization, with the new database key.
        self.rotate_database_key()?;
        self.load_collections()?;
        Ok(backup)
    }

    /// Fails unless this person is an admin of a team's vault, and returns the organization key.
    pub(super) fn admin(&self) -> Result<&KeyPair> {
        if !self.is_team() {
            return Err(Error::NotATeam);
        }
        self.organization.as_ref().ok_or(Error::NotAllowed)
    }

    /// A new key for a collection: every revision in it is encrypted again, and the key sealed to
    /// the people who keep their grants and to the organization.
    fn rotate_collection_key(&mut self, collection: &Uuid) -> Result<()> {
        let organization = self.admin()?.public.clone();
        let vault_id = self.keyring.vault_id;
        let old = self.readable(collection)?.key.clone();
        let new = crypto::random_key();
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut statement = tx.prepare(
                "SELECT id, record_id, kind, number, parent_id, deleted, nonce, ciphertext
                 FROM revisions WHERE collection_id = ?1",
            )?;
            let rows = statement
                .query_map(params![collection.to_string()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, bool>(5)?,
                        row.get::<_, Vec<u8>>(6)?,
                        row.get::<_, Vec<u8>>(7)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (id, record_id, kind, number, parent, deleted, nonce, ciphertext) in rows {
                let parent = parent.as_deref().map(parse_id).transpose()?;
                let aad = revision_aad(
                    &parse_id(&id)?,
                    &parse_id(&record_id)?,
                    &kind,
                    collection,
                    number,
                    parent.as_ref(),
                    deleted,
                );
                let (old, new) = if kind == "batch" {
                    (super::batch_key(&old, collection), super::batch_key(&new, collection))
                } else {
                    (old.clone(), new.clone())
                };
                let plaintext = crypto::decrypt(&old, &crypto::Sealed { nonce, ciphertext }, &aad)
                    .ok_or_else(|| Error::Corrupt(format!("revision {id} does not decrypt")))?;
                let sealed = crypto::encrypt(&new, &plaintext, &aad);
                tx.execute(
                    "UPDATE revisions SET nonce = ?1, ciphertext = ?2 WHERE id = ?3",
                    params![sealed.nonce, sealed.ciphertext, id],
                )?;
            }
            // Drafts kept under this collection's key, each bound to its person (Vault::draft_aad).
            let mut statement = tx.prepare("SELECT name, value FROM meta WHERE name LIKE 'draft %'")?;
            let drafts = statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for (name, value) in drafts {
                let person = name.trim_start_matches("draft ");
                let aad = super::draft_aad_for(&vault_id, person, collection);
                let sealed: crypto::Sealed = serde_json::from_str(&value)?;
                if let Some(plaintext) = crypto::decrypt(&old, &sealed, &aad) {
                    let resealed = crypto::encrypt(&new, &plaintext, &aad);
                    tx.execute(
                        "UPDATE meta SET value = ?1 WHERE name = ?2",
                        params![serde_json::to_string(&resealed)?, name],
                    )?;
                }
            }
            let mut statement = tx.prepare("SELECT user_id, role FROM grants WHERE collection_id = ?1")?;
            let grants = statement
                .query_map(params![collection.to_string()], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            tx.execute(
                "DELETE FROM grants WHERE collection_id = ?1",
                params![collection.to_string()],
            )?;
            for (person, role) in grants {
                let person = parse_id(&person)?;
                let user = self.keyring.user(&person)?;
                let role = Role::parse(&role).ok_or_else(|| Error::Corrupt(format!("unknown role {role}")))?;
                insert_grant(
                    &tx,
                    &vault_id,
                    &person,
                    &user_public_key(user, &self.keys, &self.user_id),
                    collection,
                    &new,
                    role,
                )?;
            }
            tx.execute(
                "DELETE FROM organization_grants WHERE collection_id = ?1",
                params![collection.to_string()],
            )?;
            insert_organization_grant(&tx, &vault_id, &organization, collection, &new)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// A new database key, sealed to everyone left and to the organization, and SQLCipher encrypts
    /// the whole file again. The key file keeps the old key until the database has changed, so a
    /// crash part way leaves a vault that opens with one or the other.
    fn rotate_database_key(&mut self) -> Result<()> {
        let vault_id = self.keyring.vault_id;
        let new = crypto::random_key();
        let mut keyring = self.keyring.clone();
        for user in &mut keyring.users {
            let public = user_public_key(user, &self.keys, &self.user_id);
            let sealed = crypto::seal_key(&public, &new, &keyring::database_key_info(&vault_id, &user.id));
            user.previous_database_key = Some(std::mem::replace(&mut user.database_key, sealed));
        }
        if let Some(organization) = &mut keyring.organization {
            organization.database_key = crypto::seal_key(
                &organization.public_key,
                &new,
                &keyring::organization_database_key_info(&vault_id),
            );
        }
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        self.keyring = keyring;
        crate::store::rekey(&self.conn, &new)?;
        let mut keyring = self.keyring.clone();
        for user in &mut keyring.users {
            user.previous_database_key = None;
        }
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        self.keyring = keyring;
        Ok(())
    }
}

/// The organization's key pair and the database key, from the organization's recovery key.
fn open_by_organization_recovery(keyring: &Keyring, words: &str) -> Result<(KeyPair, Key)> {
    let organization = keyring.organization.as_ref().ok_or(Error::NotATeam)?;
    let recovery = RecoveryKey::parse(words)?;
    let secret = crypto::decrypt(
        &crypto::recovery_key(&recovery.entropy(), keyring.vault_id.as_bytes()),
        &organization.private_key_by_recovery,
        &keyring::organization_recovery_aad(&keyring.vault_id),
    )
    .ok_or(Error::WrongRecoveryKey)?;
    let pair =
        KeyPair::from_secret(secret).ok_or_else(|| Error::Corrupt("the organization key is not valid".into()))?;
    let database_key = crypto::open_key(
        &pair,
        &organization.database_key,
        &keyring::organization_database_key_info(&keyring.vault_id),
    )
    .ok_or_else(|| Error::Corrupt("the database key is not sealed to the organization".into()))?;
    Ok((pair, database_key))
}

/// New keys for a person, under `password`: the database key, their grants and, for an admin, the
/// organization key are sealed to them again. Their recovery key goes, since it opened the old
/// private key; `one_time` makes them choose a password and get a new one at their next sign-in.
fn rekey_person(
    conn: &Connection,
    keyring: &mut Keyring,
    organization: &KeyPair,
    database_key: &Key,
    person: Uuid,
    password: &str,
    one_time: bool,
) -> Result<()> {
    let vault_id = keyring.vault_id;
    let keys = KeyPair::generate();
    let collections = organization_collections(conn, keyring, organization)?;
    let mut statement = conn.prepare("SELECT collection_id, role FROM grants WHERE user_id = ?1")?;
    let grants = statement
        .query_map(params![person.to_string()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM grants WHERE user_id = ?1", params![person.to_string()])?;
    for (collection, role) in grants {
        let collection = parse_id(&collection)?;
        let key = &collections
            .iter()
            .find(|c| c.id == collection)
            .ok_or_else(|| Error::Corrupt("a collection is not sealed to the organization".into()))?
            .key;
        let role = Role::parse(&role).ok_or_else(|| Error::Corrupt(format!("unknown role {role}")))?;
        insert_grant(&tx, &vault_id, &person, &keys.public, &collection, key, role)?;
    }
    let old = keyring.user(&person)?.clone();
    let mut user = new_user(&vault_id, person, old.name, &keys, password, database_key);
    user.must_set_password = one_time;
    if old.organization_key.is_some() {
        user.organization_key = Some(seal_organization_key(&vault_id, &user, organization));
    }
    tx.commit()?;
    *super::user_mut(keyring, &person) = user;
    Ok(())
}

fn collection_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::NameMissing);
    }
    Ok(name.to_owned())
}

/// Opens the organization's key pair, sealed to an admin.
pub(super) fn open_organization_key(
    keyring: &Keyring,
    keys: &KeyPair,
    user_id: Uuid,
    sealed: &SealedBox,
) -> Result<KeyPair> {
    let secret = crypto::open_key(
        keys,
        sealed,
        &keyring::organization_key_info(&keyring.vault_id, &user_id),
    )
    .ok_or_else(|| Error::Corrupt("the organization key is not sealed to this admin".into()))?;
    let pair = KeyPair::from_secret(Zeroizing::new(secret.to_vec()))
        .ok_or_else(|| Error::Corrupt("the organization key is not valid".into()))?;
    let organization = keyring.organization.as_ref().ok_or(Error::NotATeam)?;
    if pair.public != organization.public_key {
        return Err(Error::Corrupt(
            "the organization key does not match the key file".into(),
        ));
    }
    Ok(pair)
}

/// Every collection, opened with the organization's key, for an admin.
pub(super) fn organization_collections(
    conn: &Connection,
    keyring: &Keyring,
    organization: &KeyPair,
) -> Result<Vec<OpenCollection>> {
    let mut statement = conn.prepare(
        "SELECT c.id, c.name, c.owner_id, o.enc, o.ciphertext
         FROM organization_grants o JOIN collections c ON c.id = o.collection_id ORDER BY c.created_at",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, Vec<u8>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(id, name, owner, enc, ciphertext)| {
            let id = parse_id(&id)?;
            let key = crypto::open_key(
                organization,
                &SealedBox { enc, ciphertext },
                &organization_grant_info(&keyring.vault_id, &id),
            )
            .ok_or_else(|| Error::Corrupt("a collection key does not open with the organization key".into()))?;
            Ok(OpenCollection {
                id,
                name,
                owner: owner.as_deref().map(parse_id).transpose()?,
                role: Role::Admin,
                key,
            })
        })
        .collect()
}

pub(super) fn people_of(keyring: &Keyring) -> Vec<Person> {
    people(keyring)
}

fn people(keyring: &Keyring) -> Vec<Person> {
    let mut people: Vec<Person> = keyring.users.iter().map(person).collect();
    people.sort_by_key(|p| p.name.to_lowercase());
    people
}

fn person(user: &KeyringUser) -> Person {
    Person {
        id: user.id,
        name: user.name.clone(),
        admin: user.organization_key.is_some(),
        must_set_password: user.must_set_password,
    }
}

/// A name, trimmed, that nobody else in the vault has.
fn checked_name(keyring: &Keyring, name: &str, except: Option<Uuid>) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::NameMissing);
    }
    let taken = keyring
        .users
        .iter()
        .any(|user| Some(user.id) != except && user.name.trim().to_lowercase() == name.to_lowercase());
    if taken {
        return Err(Error::NameTaken);
    }
    Ok(name.to_owned())
}

/// A user's public key. A one-person vault's file did not keep it, so the unlocked person's own
/// comes from their keys.
fn user_public_key(user: &KeyringUser, keys: &KeyPair, me: &Uuid) -> Vec<u8> {
    if user.id == *me {
        keys.public.clone()
    } else {
        user.public_key.clone()
    }
}

fn new_user(
    vault_id: &Uuid,
    id: Uuid,
    name: String,
    keys: &KeyPair,
    password: &str,
    database_key: &Key,
) -> KeyringUser {
    let password_kdf = PasswordKdf::new();
    let private_key = crypto::encrypt(
        &password_kdf.derive(password),
        &keys.secret,
        &keyring::private_key_aad(vault_id, &id, "password"),
    );
    KeyringUser {
        id,
        name,
        password_kdf,
        private_key,
        private_key_by_recovery: None,
        database_key: crypto::seal_key(&keys.public, database_key, &keyring::database_key_info(vault_id, &id)),
        previous_database_key: None,
        public_key: keys.public.clone(),
        organization_key: None,
        must_set_password: true,
    }
}

fn seal_organization_key(vault_id: &Uuid, user: &KeyringUser, organization: &KeyPair) -> SealedBox {
    let secret: [u8; 32] = organization
        .secret
        .as_slice()
        .try_into()
        .expect("X25519 keys are 32 bytes");
    crypto::seal_key(
        &user.public_key,
        &Zeroizing::new(secret),
        &keyring::organization_key_info(vault_id, &user.id),
    )
}

/// Makes a collection and its key.
fn create_collection(conn: &Connection, name: &str, owner: Option<Uuid>) -> Result<(Uuid, Key)> {
    let id = Uuid::new_v4();
    conn.execute(
        "INSERT INTO collections (id, created_at, name, owner_id) VALUES (?1, ?2, ?3, ?4)",
        params![id.to_string(), now_ms(), name, owner.map(|o| o.to_string())],
    )?;
    Ok((id, crypto::random_key()))
}

fn insert_grant(
    conn: &Connection,
    vault_id: &Uuid,
    person: &Uuid,
    public_key: &[u8],
    collection: &Uuid,
    key: &Key,
    role: Role,
) -> Result<()> {
    // A batch operator gets the batch key only (super::batch_key).
    let key = if role == Role::Operator {
        super::batch_key(key, collection)
    } else {
        key.clone()
    };
    let sealed = crypto::seal_key(public_key, &key, &grant_info(vault_id, collection, person, role));
    conn.execute(
        "INSERT INTO grants (user_id, collection_id, enc, ciphertext, role) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            person.to_string(),
            collection.to_string(),
            sealed.enc,
            sealed.ciphertext,
            role.as_str()
        ],
    )?;
    Ok(())
}

fn insert_organization_grant(
    conn: &Connection,
    vault_id: &Uuid,
    organization: &[u8],
    collection: &Uuid,
    key: &Key,
) -> Result<()> {
    let sealed = crypto::seal_key(organization, key, &organization_grant_info(vault_id, collection));
    conn.execute(
        "INSERT INTO organization_grants (collection_id, enc, ciphertext) VALUES (?1, ?2, ?3)",
        params![collection.to_string(), sealed.enc, sealed.ciphertext],
    )?;
    Ok(())
}

fn organization_grant_info(vault_id: &Uuid, collection_id: &Uuid) -> Vec<u8> {
    format!("glaze-vault v1 collection-key vault {vault_id} collection {collection_id} organization").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;
    use crate::vault::{Credential, Kind};
    use serde_json::json;
    use std::fs;

    const PASSWORD: &str = "cone six oxidation";
    const ONE_TIME: &str = "pass this on";
    const BENS: &str = "bens own password";

    fn names(vault: &Vault, kind: Kind) -> Vec<String> {
        let mut names: Vec<String> = vault
            .heads(kind)
            .unwrap()
            .iter()
            .map(|r| r.content["name"].as_str().unwrap().to_owned())
            .collect();
        names.sort();
        names
    }

    /// A one-person vault with a recipe and a draft, grown into a team with Ana as admin.
    fn team() -> (tempfile::TempDir, Vault, RecoveryKey) {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
        vault.save_draft(&json!({ "editing": "Celadon" })).unwrap();
        let recovery = vault.grow_into_team(" Ana ").unwrap();
        (dir, vault, recovery)
    }

    fn shared(vault: &Vault) -> Uuid {
        vault.collections().iter().find(|c| c.name == SHARED).unwrap().id
    }

    fn private_of(vault: &Vault, person: Uuid) -> Uuid {
        vault.collections().iter().find(|c| c.owner == Some(person)).unwrap().id
    }

    #[test]
    fn growing_keeps_everything_and_asks_for_a_name_after() {
        let (dir, vault, recovery) = team();
        assert_eq!(recovery.words().len(), 24);
        let ana = vault.me();
        assert!(ana.admin && ana.name == "Ana" && vault.is_team());
        assert_eq!(vault.collections().len(), 2);
        assert_eq!(names(&vault, Kind::Recipe), ["Shino"]);
        assert_eq!(vault.draft().unwrap().unwrap(), json!({ "editing": "Celadon" }));
        drop(vault);

        // While Ana is the only one, her name is not needed.
        Vault::unlock(dir.path(), PASSWORD).unwrap();
        let people = Vault::people_in(dir.path()).unwrap();
        assert_eq!(people.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Ana"]);
        let vault = Vault::unlock_as(dir.path(), Some(ana.id), PASSWORD).unwrap();
        assert_eq!(names(&vault, Kind::Recipe), ["Shino"]);
        assert_eq!(vault.draft().unwrap().unwrap(), json!({ "editing": "Celadon" }));
        assert!(matches!(vault.grants(), Ok(grants) if grants.len() == 2));
    }

    #[test]
    fn a_vault_for_one_keeps_its_old_key_file() {
        let dir = tempfile::tempdir().unwrap();
        Vault::create(dir.path(), PASSWORD).unwrap();
        let text = fs::read_to_string(dir.path().join(KEYRING_FILE)).unwrap();
        assert!(text.contains("\"format\": 1"));
        for field in [
            "organization",
            "public_key",
            "must_set_password",
            "previous_database_key",
        ] {
            assert!(!text.contains(field), "{field}");
        }
        assert!(Vault::people_in(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn someone_added_sees_only_what_they_were_given_once_they_choose_a_password() {
        let (dir, mut ana, _) = team();
        let shared = shared(&ana);
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
        assert!(ben.must_set_password && !ben.admin);
        assert!(matches!(Vault::unlock(dir.path(), PASSWORD), Err(Error::ChooseName)));
        assert!(matches!(ana.add_person("ben", ONE_TIME, &[]), Err(Error::NameTaken)));
        ana.save_in(
            Kind::Recipe,
            private_of(&ana, ana.me().id),
            &json!({ "name": "Ana's secret" }),
        )
        .unwrap();

        // With the one-time password, nothing opens until Ben chooses his own.
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        assert!(as_ben.collections().is_empty() && names(&as_ben, Kind::Recipe).is_empty());
        assert!(matches!(
            as_ben.save(Kind::Recipe, None, &json!({})),
            Err(Error::NotFound)
        ));
        let recovery = as_ben.set_own_password(BENS).unwrap();
        assert!(matches!(as_ben.set_own_password(BENS), Err(Error::NotAllowed)));
        drop(as_ben);
        assert!(matches!(
            Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME),
            Err(Error::WrongPassword)
        ));

        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
        assert_eq!(names(&as_ben, Kind::Recipe), ["Shino"]);
        assert!(matches!(
            as_ben.save_in(Kind::Recipe, shared, &json!({ "name": "Mine" })),
            Err(Error::NotAllowed)
        ));
        let head = as_ben.heads(Kind::Recipe).unwrap().remove(0);
        assert!(matches!(
            as_ben.delete(Kind::Recipe, head.revision_id),
            Err(Error::NotAllowed)
        ));
        assert!(matches!(as_ben.people(), Err(Error::NotAllowed)));
        let bens_private = private_of(&as_ben, ben.id);
        as_ben
            .save_in(Kind::Recipe, bens_private, &json!({ "name": "Ben's test" }))
            .unwrap();
        drop(as_ben);

        // His recovery key works, and an admin sees his private collection too.
        Vault::recover_as(
            dir.path(),
            Some(ben.id),
            &recovery.words().join(" "),
            "bens newer password",
        )
        .unwrap();
        ana.load_collections().unwrap();
        assert_eq!(names(&ana, Kind::Recipe), ["Ana's secret", "Ben's test", "Shino"]);
    }

    #[test]
    fn a_batch_operator_opens_batch_sheets_and_nothing_else() {
        let (dir, mut ana, _) = team();
        let shared = shared(&ana);
        let sheet = ana
            .save_in(
                Kind::Batch,
                shared,
                &json!({ "name": "Shino", "lines": [{ "material": "M-104", "amount": "40" }] }),
            )
            .unwrap();
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Operator)]).unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        as_ben.set_own_password(BENS).unwrap();

        assert_eq!(names(&as_ben, Kind::Batch), ["Shino"]);
        assert!(names(&as_ben, Kind::Recipe).is_empty());
        assert!(names(&as_ben, Kind::Material).is_empty());
        let recipe = ana.heads(Kind::Recipe).unwrap()[0].record_id;
        assert!(matches!(as_ben.history(Kind::Recipe, recipe), Err(Error::NotFound)));
        assert!(matches!(
            as_ben.save(Kind::Batch, Some(sheet.revision_id), &json!({ "name": "Changed" })),
            Err(Error::NotAllowed)
        ));
        assert!(matches!(
            as_ben.save_in(Kind::Recipe, shared, &json!({ "name": "Ben's glaze" })),
            Err(Error::NotAllowed)
        ));
        // What Ben holds is the batch key, made from the collection's key, which it does not lead
        // back to, so it opens no recipe, whatever the app does.
        let held = as_ben.readable(&shared).unwrap().key.clone();
        let collection_key = ana.readable(&shared).unwrap().key.clone();
        assert_eq!(*held, *super::super::batch_key(&collection_key, &shared));
        assert_ne!(*held, *collection_key);
        // In their own private collection, Ben does as he likes.
        let own = private_of(&as_ben, ben.id);
        as_ben
            .save_in(Kind::Recipe, own, &json!({ "name": "Ben's glaze" }))
            .unwrap();
    }

    #[test]
    fn making_someone_a_batch_operator_changes_the_collections_key() {
        let (dir, mut ana, _) = team();
        let shared = shared(&ana);
        ana.save_in(Kind::Batch, shared, &json!({ "name": "Shino" })).unwrap();
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        as_ben.set_own_password(BENS).unwrap();
        let kept_key = as_ben.readable(&shared).unwrap().key.clone();
        drop(as_ben);

        ana.set_role(ben.id, shared, Some(Role::Operator)).unwrap();
        assert_ne!(*ana.readable(&shared).unwrap().key, *kept_key);
        assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
        assert_eq!(names(&ana, Kind::Batch), ["Shino"]);
        let as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
        assert!(names(&as_ben, Kind::Recipe).is_empty());
        assert_eq!(names(&as_ben, Kind::Batch), ["Shino"]);
        drop(as_ben);

        // And taking it away again re-encrypts the sheets too.
        ana.set_role(ben.id, shared, None).unwrap();
        assert_eq!(names(&ana, Kind::Batch), ["Shino"]);
    }

    #[test]
    fn taking_a_role_away_changes_the_collections_key() {
        let (dir, mut ana, _) = team();
        let shared = shared(&ana);
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Formulator)]).unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        as_ben.set_own_password(BENS).unwrap();
        as_ben
            .save_in(Kind::Recipe, shared, &json!({ "name": "Ben's glaze" }))
            .unwrap();
        let kept_key = as_ben.readable(&shared).unwrap().key.clone();
        drop(as_ben);

        ana.set_role(ben.id, shared, None).unwrap();
        assert_ne!(*ana.readable(&shared).unwrap().key, *kept_key);
        assert_eq!(names(&ana, Kind::Recipe), ["Ben's glaze", "Shino"]);
        let as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
        assert!(names(&as_ben, Kind::Recipe).is_empty());
        drop(as_ben);
        drop(ana);
        let ana = Vault::unlock_as(
            dir.path(),
            Vault::people_in(dir.path())
                .unwrap()
                .iter()
                .find(|p| p.admin)
                .map(|p| p.id),
            PASSWORD,
        )
        .unwrap();
        assert_eq!(names(&ana, Kind::Recipe), ["Ben's glaze", "Shino"]);
    }

    #[test]
    fn removing_someone_changes_the_database_key_too() {
        let (dir, mut ana, _) = team();
        let ana_id = ana.me().id;
        let shared = shared(&ana);
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
        let old_database_key = ana.database_key().unwrap();
        assert!(matches!(ana.remove_person(ana_id), Err(Error::NotAllowed)));
        ana.remove_person(ben.id).unwrap();
        assert!(matches!(
            Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME),
            Err(Error::NoSuchPerson)
        ));
        drop(ana);
        assert!(store::open(&dir.path().join(super::super::DATABASE_FILE), &old_database_key).is_err());
        let ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
        assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
        // Ben's private collection stays, for admins.
        assert_eq!(ana.collections().len(), 3);
    }

    #[test]
    fn a_change_of_database_key_that_stopped_part_way_is_finished_on_opening() {
        let (dir, ana, _) = team();
        let ana_id = ana.me().id;
        // As if the key file was written with the new key, and the app stopped before the
        // database changed to it.
        let mut keyring = ana.keyring.clone();
        let new = crypto::random_key();
        let sealed = crypto::seal_key(
            &ana.keys.public,
            &new,
            &keyring::database_key_info(&keyring.vault_id, &ana_id),
        );
        let user = super::super::user_mut(&mut keyring, &ana_id);
        user.previous_database_key = Some(std::mem::replace(&mut user.database_key, sealed));
        drop(ana);
        keyring.write(&dir.path().join(KEYRING_FILE)).unwrap();

        let ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
        assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
        assert!(ana.keyring.users.iter().all(|u| u.previous_database_key.is_none()));
        drop(ana);
        assert!(store::open(&dir.path().join(super::super::DATABASE_FILE), &new).is_ok());
    }

    #[test]
    fn an_admin_resets_someone_who_lost_everything() {
        let (dir, mut ana, _) = team();
        let shared = shared(&ana);
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        let old_sheet = as_ben.set_own_password(BENS).unwrap();
        drop(as_ben);

        ana.reset_person(ben.id, "a new one-time").unwrap();
        assert!(matches!(
            Vault::unlock_as(dir.path(), Some(ben.id), BENS),
            Err(Error::WrongPassword)
        ));
        let words = old_sheet.words().join(" ");
        assert!(matches!(
            Vault::recover_as(dir.path(), Some(ben.id), &words, "whatever it is"),
            Err(Error::WrongRecoveryKey)
        ));
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), "a new one-time").unwrap();
        assert!(as_ben.me().must_set_password);
        as_ben.set_own_password(BENS).unwrap();
        assert_eq!(names(&as_ben, Kind::Recipe), ["Shino"]);
    }

    #[test]
    fn the_organization_recovery_key_gets_an_admin_back_in() {
        let (dir, mut ana, organization_sheet) = team();
        let ana_id = ana.me().id;
        let ben = ana.add_person("Ben", ONE_TIME, &[]).unwrap();
        drop(ana);
        let words = organization_sheet.words().join(" ");
        assert!(matches!(
            Vault::recover_organization(dir.path(), &words, ben.id, "new admin password"),
            Err(Error::NotAllowed)
        ));
        let (ana, sheet) = Vault::recover_organization(dir.path(), &words, ana_id, "new admin password").unwrap();
        assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
        assert!(ana.me().admin);
        drop(ana);
        Vault::recover_as(dir.path(), Some(ana_id), &sheet.words().join(" "), "and another one").unwrap();
    }

    #[test]
    fn only_admins_back_up_and_restore_a_teams_vault() {
        let (dir, mut ana, organization_sheet) = team();
        let ana_id = ana.me().id;
        let shared = shared(&ana);
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Formulator)]).unwrap();
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("team.gvbackup");
        ana.back_up(&path).unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        as_ben.set_own_password(BENS).unwrap();
        assert!(matches!(
            as_ben.back_up(&files.path().join("b.gvbackup")),
            Err(Error::NotAllowed)
        ));
        drop(as_ben);
        drop(ana);

        let info = Vault::backup_info(&path).unwrap();
        assert_eq!(info.admins.iter().map(|p| p.id).collect::<Vec<_>>(), [ana_id]);
        let elsewhere = tempfile::tempdir().unwrap();
        assert!(matches!(
            Vault::restore(elsewhere.path(), &path, Some(ben.id), &Credential::Password(ONE_TIME)),
            Err(Error::NotAllowed)
        ));
        let (restored, _) =
            Vault::restore(elsewhere.path(), &path, Some(ana_id), &Credential::Password(PASSWORD)).unwrap();
        assert_eq!(restored.people().unwrap().len(), 2);
        drop(restored);

        let again = tempfile::tempdir().unwrap();
        let words = organization_sheet.words().join(" ");
        let (restored, _, _) =
            Vault::restore_by_organization(again.path(), &path, &words, ana_id, "new admin password").unwrap();
        assert_eq!(names(&restored, Kind::Recipe), ["Shino"]);
    }

    #[test]
    fn admins_make_collections_and_admins() {
        let (dir, mut ana, _) = team();
        let ben = ana.add_person("Ben", ONE_TIME, &[]).unwrap();
        let glazes = ana.create_collection("  Production glazes ").unwrap();
        assert_eq!(glazes.name, "Production glazes");
        ana.save_in(Kind::Recipe, glazes.id, &json!({ "name": "Tenmoku" }))
            .unwrap();
        ana.rename_collection(glazes.id, "Production").unwrap();
        assert!(matches!(
            ana.rename_collection(private_of(&ana, ana.me().id), "Mine"),
            Err(Error::NotAllowed)
        ));
        ana.make_admin(ben.id).unwrap();
        assert!(matches!(ana.remove_person(ben.id), Err(Error::RemovingAdmin)));
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        as_ben.set_own_password(BENS).unwrap();
        assert!(as_ben.me().admin);
        assert_eq!(names(&as_ben, Kind::Recipe), ["Shino", "Tenmoku"]);
        assert!(as_ben.collections().iter().any(|c| c.name == "Production"));
    }

    #[test]
    fn a_team_goes_back_to_one_person_and_can_grow_again() {
        let (dir, mut ana, _) = team();
        let ana_id = ana.me().id;
        let shared = shared(&ana);
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Formulator)]).unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        as_ben.set_own_password(BENS).unwrap();
        as_ben
            .save_in(
                Kind::Recipe,
                private_of(&as_ben, ben.id),
                &json!({ "name": "Ben's test" }),
            )
            .unwrap();
        let bens_shared_key = as_ben.readable(&shared).unwrap().key.clone();
        drop(as_ben);
        ana.load_collections().unwrap();

        let backup = ana.go_back_to_one_person().unwrap();
        assert!(backup.is_file());
        assert!(!ana.is_team());
        assert_ne!(*ana.readable(&shared).unwrap().key, *bens_shared_key);
        assert_eq!(names(&ana, Kind::Recipe), ["Ben's test", "Shino"]);
        assert!(
            ana.collections()
                .iter()
                .any(|c| c.name == "From Ben" && c.owner.is_none())
        );
        assert_eq!(ana.draft().unwrap().unwrap(), json!({ "editing": "Celadon" }));
        drop(ana);

        assert!(Vault::people_in(dir.path()).unwrap().is_empty());
        let text = fs::read_to_string(dir.path().join(KEYRING_FILE)).unwrap();
        assert!(text.contains("\"format\": 1") && !text.contains("organization"));
        assert!(matches!(
            Vault::unlock_as(dir.path(), Some(ben.id), BENS),
            Err(Error::NoSuchPerson)
        ));
        let mut ana = Vault::unlock(dir.path(), PASSWORD).unwrap();
        assert_eq!(names(&ana, Kind::Recipe), ["Ben's test", "Shino"]);

        // Growing again keeps Ana's private collection rather than making another.
        ana.grow_into_team("Ana").unwrap();
        assert_eq!(ana.collections().iter().filter(|c| c.owner == Some(ana_id)).count(), 1);
        assert_eq!(names(&ana, Kind::Recipe), ["Ben's test", "Shino"]);
    }
}
