//! A team on one computer (docs/adr/0012-teams-on-one-computer.md): growing a one-person vault,
//! people, collections and what each person may do in them. Each change is made of directory
//! events (events.rs, ADR 18), which the shared checks in access.rs allow or refuse; this file
//! makes the keys they carry.

use super::events::{self, Body, Renamed};
use super::roles::Capabilities;
use super::signatures;
use super::{
    Held, KEYRING_FILE, Kind, OpenCollection, Vault, batch_key, check_password, epoch_aad, epoch_words, grant_info,
    now_ms, older_keys, parse_id, summary_key,
};
use crate::access::{Directory, Role};
use crate::crypto::{self, Key, KeyPair, PasswordKdf, SealedBox};
use crate::error::{Error, Result};
use crate::keyring::{self, Keyring, KeyringUser, Organization};
use crate::recovery::RecoveryKey;
use crate::signing::{self, Signer};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
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
    /// The kinds of record this person may make and change here.
    pub changes: Vec<Kind>,
    /// What else they may do here. An admin manages every collection.
    #[serde(flatten)]
    pub may: Capabilities,
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

    /// Everyone in a team's vault, for an admin or someone who manages a collection. The lock
    /// screen names them all anyway.
    pub fn people(&self) -> Result<Vec<Person>> {
        if self.admin().is_err() && !self.collections.iter().any(|c| self.managed(&c.id).is_ok()) {
            return Err(Error::NotAllowed);
        }
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
                changes: Kind::ALL
                    .into_iter()
                    .filter(|&kind| self.may_change(c.role, kind))
                    .collect(),
                may: Capabilities {
                    manage: self.managed(&c.id).is_ok(),
                    ..self.capabilities(c.role)
                },
            })
            .collect()
    }

    /// Whether this person may export from any collection they can open.
    pub fn may_export(&self) -> bool {
        self.collections.iter().any(|c| self.capabilities(c.role).export)
    }

    /// Every grant in the vault for an admin, and on the collections they manage for anyone else.
    pub fn grants(&self) -> Result<Vec<Grant>> {
        let admin = self.admin().is_ok();
        if !admin && !self.collections.iter().any(|c| self.managed(&c.id).is_ok()) {
            return Err(Error::NotAllowed);
        }
        Ok(self
            .directory
            .grants
            .iter()
            .filter(|g| admin || self.managed(&g.collection).is_ok())
            .map(|g| Grant {
                person: g.person,
                collection: g.collection,
                role: g.role,
            })
            .collect())
    }

    /// Makes a one-person vault a team's, with this person as its first admin, named `name`.
    /// Returns the organization's recovery key, to show once (ADR 3).
    pub fn grow_into_team(&mut self, name: &str) -> Result<RecoveryKey> {
        if self.is_team() {
            return Err(Error::AlreadyATeam);
        }
        let name = name.trim().to_owned();
        let draft = self.draft()?;
        let vault_id = self.keyring.vault_id;
        let me = self.user_id;
        let organization = KeyPair::generate();
        let recovery = RecoveryKey::generate();
        let database_key = self.database_key()?;

        let mut keyring = self.keyring.clone();
        keyring.organization = Some(new_organization(&vault_id, &organization, &recovery, &database_key));
        let user = super::user_mut(&mut keyring, &me);
        user.name = name.clone();
        user.public_key = self.keys.public.clone();
        user.organization_key = Some(seal_organization_key(&vault_id, user, &organization));

        // This person becomes its admin, every collection key is sealed to the organization, the
        // first is named, and the admin gets a private collection. The key file is written before
        // the database's changes are kept, so a failure leaves the vault one person's.
        let tx = self.conn.unchecked_transaction()?;
        events::record(
            &tx,
            &self.signer,
            Body::TeamFormed {
                person: me,
                name,
                public_key: self.keys.public.clone(),
                organization_key: organization.public.clone(),
            },
        )?;
        // The organization's signing key vouches for people's keys from now on, starting with
        // this person's.
        signatures::add_organization_key(&tx, &self.signer, &organization)?;
        events::record(
            &tx,
            &self.signer,
            signatures::organization_certificate(
                &vault_id,
                &organization,
                me,
                &signing::public(&self.signer.key),
                &self.keys.public,
            ),
        )?;
        if self.readable(&self.default_collection).is_ok_and(|c| c.name.is_empty()) {
            events::record(
                &tx,
                &self.signer,
                Body::CollectionRenamed {
                    collection: self.default_collection,
                    name: SHARED.into(),
                },
            )?;
        }
        for collection in &self.collections {
            events::record(
                &tx,
                &self.signer,
                organization_grant_set(
                    &vault_id,
                    &organization.public,
                    &collection.id,
                    collection.full_key()?,
                    collection.epoch,
                ),
            )?;
        }
        // A vault that was a team's before keeps the private collection it had.
        if !self.collections.iter().any(|c| c.owner == Some(me)) {
            let (private, key) = create_collection(&tx, &self.signer, "", Some(me))?;
            events::record(
                &tx,
                &self.signer,
                grant_set(
                    &vault_id,
                    &me,
                    &self.keys.public,
                    &private,
                    &key,
                    1,
                    Role::Formulator,
                    Held::Collection,
                ),
            )?;
            events::record(
                &tx,
                &self.signer,
                organization_grant_set(&vault_id, &organization.public, &private, &key, 1),
            )?;
        }
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        tx.commit()?;
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
        let organization = self.admin()?.public.clone();
        check_password(one_time_password)?;
        let name = name.trim().to_owned();
        let vault_id = self.keyring.vault_id;
        let id = Uuid::new_v4();
        let keys = KeyPair::generate();
        let database_key = self.database_key()?;
        let user = new_user(&vault_id, id, name.clone(), &keys, one_time_password, &database_key);

        let tx = self.conn.unchecked_transaction()?;
        events::record(
            &tx,
            &self.signer,
            Body::PersonAdded {
                person: id,
                name,
                public_key: keys.public.clone(),
            },
        )?;
        // Their keys are made here, so the organization certifies their signing key at once.
        let organization_pair = self.admin()?;
        signatures::add_organization_key(&tx, &self.signer, organization_pair)?;
        let signing_key = signing::public(&signing::person_key(&keys));
        events::record(
            &tx,
            &self.signer,
            signatures::organization_certificate(&vault_id, organization_pair, id, &signing_key, &keys.public),
        )?;
        let (private, key) = create_collection(&tx, &self.signer, "", Some(id))?;
        events::record(
            &tx,
            &self.signer,
            grant_set(
                &vault_id,
                &id,
                &keys.public,
                &private,
                &key,
                1,
                Role::Formulator,
                Held::Collection,
            ),
        )?;
        events::record(
            &tx,
            &self.signer,
            organization_grant_set(&vault_id, &organization, &private, &key, 1),
        )?;
        for (collection, role) in roles {
            self.ready_for(self.held(*role))?;
            let collection = self.readable(collection)?;
            events::record(
                &tx,
                &self.signer,
                grant_set(
                    &vault_id,
                    &id,
                    &keys.public,
                    &collection.id,
                    collection.full_key()?,
                    collection.epoch,
                    *role,
                    self.held(*role),
                ),
            )?;
        }
        // Into the key file before the database keeps them, so a failure adds nobody.
        let mut keyring = self.keyring.clone();
        keyring.users.push(user);
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        tx.commit()?;
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
        // An admin signing in for the first time may be the first who can change the vault over.
        let _ = self.change_to_summaries();
        Ok(recovery)
    }

    /// Gives a person a role on a collection, or with None takes it away. Taking it away gives the
    /// collection a new key, since they may have kept the old one (ADR 3). An admin may give any
    /// role; someone who manages the collection may give any but an admin's or a manager's, to
    /// anyone but an admin, a manager or themselves (access.rs).
    pub fn set_role(&mut self, person: Uuid, collection: Uuid, role: Option<Role>) -> Result<()> {
        let user = self.keyring.user(&person)?.clone();
        let vault_id = self.keyring.vault_id;
        let previous = self.directory.grant(person, collection).map(|g| g.role);
        match role {
            Some(role) => {
                self.ready_for(self.held(role))?;
                // In one transaction: a failure part way leaves them with the role they had.
                let tx = self.conn.unchecked_transaction()?;
                // Someone who held the collection's key and now gets only a key made from it, or
                // who goes from one such key to the other, may have kept what they had, so the
                // collection gets a new key, sealed again for everyone but them.
                let held = self.held(role);
                let before = previous.map(|previous| self.held(previous));
                let (epoch, key) = if before.is_some_and(|before| before != held && held != Held::Collection) {
                    let organization = self.organization_public_key()?;
                    self.new_epoch_for(&tx, &collection, Some(&organization), Some(person))?
                } else {
                    let open = self.readable(&collection)?;
                    (open.epoch, open.full_key()?.clone())
                };
                events::record(
                    &tx,
                    &self.signer,
                    grant_set(
                        &vault_id,
                        &person,
                        &user.public_key,
                        &collection,
                        &key,
                        epoch,
                        role,
                        held,
                    ),
                )?;
                tx.commit()?;
            }
            // In one transaction, so a failure part way leaves them their role, and trying again
            // takes it away and changes the key.
            None if previous.is_some() => {
                let tx = self.conn.unchecked_transaction()?;
                events::record(&tx, &self.signer, Body::GrantRemoved { person, collection })?;
                self.new_epoch_in(&tx, &collection)?;
                tx.commit()?;
            }
            None => {}
        }
        self.load_collections()
    }

    /// Takes a person out of the vault. Every collection they could open, and the database, get
    /// new keys. Their private collection stays, for admins. Nobody removes themselves.
    pub fn remove_person(&mut self, person: Uuid) -> Result<()> {
        self.admin()?;
        self.keyring.user(&person)?;
        // Already gone from the directory when the key file could not be written last time: only
        // that is left to do.
        if self.directory.person(person).is_some() {
            let theirs: Vec<Uuid> = self
                .directory
                .grants
                .iter()
                .filter(|g| g.person == person)
                .map(|g| g.collection)
                .collect();
            // Their grants go and their collections get new keys all at once, or not at all.
            let tx = self.conn.unchecked_transaction()?;
            events::record(&tx, &self.signer, Body::PersonRemoved { person })?;
            for collection in theirs {
                self.new_epoch_in(&tx, &collection)?;
            }
            tx.commit()?;
            self.load_collections()?;
        }
        // Only then do they leave the key file. Until the new database key is written there, they
        // are still listed, so removing them again finishes the job.
        let mut keyring = self.keyring.clone();
        keyring.users.retain(|user| user.id != person);
        self.rotate_database_key(keyring)
    }

    /// Gives someone who lost both their password and their recovery sheet a new one-time
    /// password. They get new keys, so their old sheet stops working, and they choose a password
    /// and get a new sheet at their next sign-in, as when they were added.
    pub fn reset_person(&mut self, person: Uuid, one_time_password: &str) -> Result<()> {
        let organization = self.admin()?;
        // Not themselves: they would lose their own way in.
        if person == self.user_id {
            return Err(Error::NotAllowed);
        }
        check_password(one_time_password)?;
        let database_key = self.database_key()?;
        let mut keyring = self.keyring.clone();
        let tx = self.conn.unchecked_transaction()?;
        rekey_person(
            &tx,
            &mut keyring,
            organization,
            &database_key,
            person,
            &KeyPair::generate(),
            one_time_password,
            true,
            &self.signer,
        )?;
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        tx.commit()?;
        self.keyring = keyring;
        self.load_collections()
    }

    /// Makes someone an admin: the organization key is sealed to them.
    pub fn make_admin(&mut self, person: Uuid) -> Result<()> {
        let organization = self.admin()?;
        self.keyring.user(&person)?;
        let vault_id = self.keyring.vault_id;
        let mut keyring = self.keyring.clone();
        let user = super::user_mut(&mut keyring, &person);
        if user.public_key.is_empty() {
            return Err(Error::NoSuchPerson);
        }
        user.organization_key = Some(seal_organization_key(&vault_id, user, organization));
        let tx = self.conn.unchecked_transaction()?;
        events::record(&tx, &self.signer, Body::AdminGiven { person })?;
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        tx.commit()?;
        self.keyring = keyring;
        self.load_collections()
    }

    /// Takes admin away from someone. The organization gets a new key, sealed to the admins left,
    /// and a new recovery key, returned to print: the old sheet stops working. Every collection
    /// gets a new key, since theirs opened them all. They keep their roles on collections, an
    /// admin's grant becoming a formulator's. Nobody takes admin away from themselves.
    ///
    /// The collections' new keys and the new organization key go into the database in one
    /// transaction, the organization's as public and sealed parts only, and then into the key
    /// file; if that is not reached, the next unlock finishes it (finish_organization_change).
    pub fn take_admin_away(&mut self, person: Uuid) -> Result<RecoveryKey> {
        self.admin()?;
        // One that stopped before goes into the key file first, so its admin is not counted as
        // one still, nor its organization key lost under this one.
        self.finish_organization_change()?;
        let user = self.keyring.user(&person)?.clone();
        let vault_id = self.keyring.vault_id;
        let organization = KeyPair::generate();
        let recovery = RecoveryKey::generate();
        let pending = PendingOrganization {
            organization: new_organization(&vault_id, &organization, &recovery, &self.database_key()?),
            admins: self
                .keyring
                .users
                .iter()
                .filter(|user| user.organization_key.is_some() && user.id != person)
                .map(|user| (user.id, seal_organization_key(&vault_id, user, &organization)))
                .collect(),
            demoted: person,
        };
        let tx = self.conn.unchecked_transaction()?;
        events::record(
            &tx,
            &self.signer,
            Body::AdminTaken {
                person,
                organization_key: organization.public.clone(),
            },
        )?;
        // The new organization key's signing key vouches for keys from now on; what the old one
        // certified stays good, and it can certify nothing more (ADR 19).
        signatures::add_organization_key(&tx, &self.signer, &organization)?;
        let demoted: Vec<Uuid> = self
            .directory
            .grants
            .iter()
            .filter(|g| g.person == person && g.role == Role::Admin)
            .map(|g| g.collection)
            .collect();
        for collection in demoted {
            let open = self.readable(&collection)?;
            events::record(
                &tx,
                &self.signer,
                grant_set(
                    &vault_id,
                    &person,
                    &user.public_key,
                    &collection,
                    open.full_key()?,
                    open.epoch,
                    Role::Formulator,
                    Held::Collection,
                ),
            )?;
        }
        let collections: Vec<Uuid> = self.collections.iter().map(|c| c.id).collect();
        for collection in &collections {
            self.new_epoch_for(&tx, collection, Some(&organization.public), None)?;
        }
        tx.execute(
            "INSERT INTO meta (name, value) VALUES (?1, ?2)
             ON CONFLICT (name) DO UPDATE SET value = excluded.value",
            params![PENDING_ORGANIZATION, serde_json::to_string(&pending)?],
        )?;
        tx.commit()?;
        // The collections are sealed to the new key now, so it is the one to open them with,
        // whether or not the key file below is written.
        self.organization = Some(organization);
        self.load_collections()?;
        let mut keyring = self.keyring.clone();
        finish_organization_change(&self.conn, &mut keyring, &self.dir)?;
        self.keyring = keyring;
        Ok(recovery)
    }

    /// A new organization recovery key, when its sheet is lost: the organization's private key is
    /// encrypted again under it, and the old sheet stops working. For an admin.
    pub fn new_organization_recovery_key(&mut self) -> Result<RecoveryKey> {
        self.admin()?;
        // The key it encrypts must be the one the key file names.
        self.finish_organization_change()?;
        let organization = self.admin()?;
        let vault_id = self.keyring.vault_id;
        let recovery = RecoveryKey::generate();
        let mut keyring = self.keyring.clone();
        let kept = keyring.organization.as_mut().ok_or(Error::NotATeam)?;
        kept.private_key_by_recovery = crypto::encrypt(
            &crypto::recovery_key(&recovery.entropy(), vault_id.as_bytes()),
            &organization.secret,
            &keyring::organization_recovery_aad(&vault_id),
        );
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        self.keyring = keyring;
        Ok(recovery)
    }

    /// Finishes a change of organization key in this session's key file, if one is waiting.
    fn finish_organization_change(&mut self) -> Result<()> {
        let mut keyring = self.keyring.clone();
        finish_organization_change(&self.conn, &mut keyring, &self.dir)?;
        self.keyring = keyring;
        Ok(())
    }

    /// Makes a collection to share, which only admins can open until they give others roles on it.
    pub fn create_collection(&mut self, name: &str) -> Result<Collection> {
        let organization = self.admin()?.public.clone();
        let name = collection_name(name)?;
        let tx = self.conn.unchecked_transaction()?;
        let (id, key) = create_collection(&tx, &self.signer, &name, None)?;
        events::record(
            &tx,
            &self.signer,
            organization_grant_set(&self.keyring.vault_id, &organization, &id, &key, 1),
        )?;
        tx.commit()?;
        self.load_collections()?;
        Ok(Collection {
            id,
            name,
            owner: None,
            role: Role::Admin,
            changes: Kind::ALL.to_vec(),
            may: Capabilities {
                manage: true,
                ..Capabilities::BUILT_IN
            },
        })
    }

    pub fn rename_collection(&mut self, id: Uuid, name: &str) -> Result<()> {
        let name = collection_name(name)?;
        events::record(
            &self.conn,
            &self.signer,
            Body::CollectionRenamed { collection: id, name },
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
        let (mut organization, database_key) = open_by_organization_recovery(&keyring, words)?;
        let conn = crate::store::open(&dir.join(super::DATABASE_FILE), &database_key)?;
        // A change of organization key that stopped part way is finished first, and then only
        // the new organization's sheet opens it.
        let before = keyring.organization.as_ref().map(|o| o.public_key.clone());
        finish_organization_change(&conn, &mut keyring, dir)?;
        if keyring.organization.as_ref().map(|o| o.public_key.clone()) != before {
            organization = open_by_organization_recovery(&keyring, words)?.0;
        }
        if keyring.user(&admin)?.organization_key.is_none() {
            return Err(Error::NotAllowed);
        }
        events::fill(&conn, &keyring, None)?;
        // The admin signs with their new key, which the organization certifies in the same step.
        let keys = KeyPair::generate();
        let signer = Signer::new(keyring.vault_id, admin, &keys);
        let tx = conn.unchecked_transaction()?;
        rekey_person(
            &tx,
            &mut keyring,
            &organization,
            &database_key,
            admin,
            &keys,
            new_password,
            false,
            &signer,
        )?;
        keyring.write(&dir.join(KEYRING_FILE))?;
        tx.commit()?;
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
        Vault::may_replace(dir, &admin)?;
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

        // Already one person's in the database when the key file could not be written last time:
        // only that is left to do.
        if self.directory.is_team() {
            let renamed: Vec<Renamed> = self
                .keyring
                .users
                .iter()
                .filter(|user| user.id != me)
                .flat_map(|user| {
                    self.collections
                        .iter()
                        .filter(move |c| c.owner == Some(user.id))
                        .map(move |c| Renamed {
                            collection: c.id,
                            name: format!("From {}", user.name),
                        })
                })
                .collect();
            let tx = self.conn.unchecked_transaction()?;
            // This person keeps every collection, as a one-person vault's person does, and then
            // each gets a new key, sealed to them alone.
            for collection in &self.collections {
                events::record(
                    &tx,
                    &self.signer,
                    grant_set(
                        &vault_id,
                        &me,
                        &self.keys.public,
                        &collection.id,
                        collection.full_key()?,
                        collection.epoch,
                        Role::Admin,
                        Held::Collection,
                    ),
                )?;
            }
            events::record(&tx, &self.signer, Body::TeamDisbanded { renamed })?;
            for collection in &self.collections {
                self.new_epoch_for(&tx, &collection.id, None, None)?;
            }
            tx.commit()?;
        }

        let mut keyring = self.keyring.clone();
        keyring.users.retain(|user| user.id == me);
        keyring.organization = None;
        super::user_mut(&mut keyring, &me).organization_key = None;
        self.organization = None;
        // Writes the key file, now without the organization, with the new database key.
        self.rotate_database_key(keyring)?;
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

    /// The organization's public key, as the key file has it.
    pub(super) fn organization_public_key(&self) -> Result<Vec<u8>> {
        Ok(self
            .keyring
            .organization
            .as_ref()
            .ok_or(Error::NotATeam)?
            .public_key
            .clone())
    }

    /// A new key epoch for a collection (ADR 17), in the caller's transaction, which it must
    /// commit and then reload the collections. Returns the new epoch and its key.
    fn new_epoch_in(&self, tx: &Connection, collection: &Uuid) -> Result<(i64, Key)> {
        let organization = self.organization_public_key()?;
        self.new_epoch_for(tx, collection, Some(&organization), None)
    }

    /// A collection this person manages: an admin manages every one.
    pub(super) fn managed(&self, collection: &Uuid) -> Result<&OpenCollection> {
        if !self.is_team() {
            return Err(Error::NotATeam);
        }
        let open = self.readable(collection)?;
        if !self.directory.may_manage(self.user_id, *collection) {
            return Err(Error::NotAllowed);
        }
        Ok(open)
    }

    /// After a role admins make changes what key it holds, in the caller's transaction: its
    /// grants sealed again for the key it now holds. Going to a narrower key gives each of its
    /// collections a new key, since its people held the old one.
    pub(super) fn regrant(&self, tx: &Connection, role: Role, before: Held) -> Result<()> {
        let directory = Directory::load(tx)?;
        let after = directory.held(role);
        if after == before {
            return Ok(());
        }
        let vault_id = self.keyring.vault_id;
        let mut rotated: Vec<Uuid> = Vec::new();
        for grant in directory.grants.iter().filter(|g| g.role == role) {
            if after == Held::Collection {
                let user = self.keyring.user(&grant.person)?;
                let open = self.readable(&grant.collection)?;
                events::record(
                    tx,
                    &self.signer,
                    grant_set(
                        &vault_id,
                        &grant.person,
                        &user_public_key(user, &self.keys, &self.user_id),
                        &grant.collection,
                        open.full_key()?,
                        open.epoch,
                        role,
                        after,
                    ),
                )?;
            } else if !rotated.contains(&grant.collection) {
                self.new_epoch_in(tx, &grant.collection)?;
                rotated.push(grant.collection);
            }
        }
        Ok(())
    }

    /// A new key epoch for a collection (ADR 17): a new key, which wraps the one before, sealed to
    /// the people who keep their grants, other than `except`, whose grant the caller sets, and to
    /// `organization`, the organization's public key, or a new one's while it is changing. What
    /// is already stored stays under the key it was saved with, which whoever held it may have
    /// kept, so the new key keeps someone who has lost the collection from reading what is saved
    /// from now on. Each grant is sealed for the key its role holds as the transaction has it.
    fn new_epoch_for(
        &self,
        tx: &Connection,
        collection: &Uuid,
        organization: Option<&[u8]>,
        except: Option<Uuid>,
    ) -> Result<(i64, Key)> {
        let vault_id = self.keyring.vault_id;
        let open = self.readable(collection)?;
        let old = open.full_key()?;
        let directory = Directory::load(tx)?;
        let stored = directory.collection(*collection).ok_or(Error::NotFound)?.epoch;
        // Twice in one transaction would wrap the wrong key: the collections are reloaded between.
        if stored != open.epoch {
            return Err(Error::Corrupt(format!(
                "collection {collection}'s key changed twice at once"
            )));
        }
        let epoch = open.epoch + 1;
        let new = crypto::random_key();
        let wrap = |old: &Key, new: &Key, held: Held| {
            crypto::encrypt(new, &old[..], &epoch_aad(&vault_id, collection, epoch, held)).to_bytes()
        };
        events::record(
            tx,
            &self.signer,
            Body::KeyEpoch {
                collection: *collection,
                epoch,
                previous: wrap(old, &new, Held::Collection),
                previous_batch: wrap(&batch_key(old, collection), &batch_key(&new, collection), Held::Batch),
                previous_summary: wrap(
                    &summary_key(old, collection),
                    &summary_key(&new, collection),
                    Held::Summary,
                ),
            },
        )?;
        for grant in directory
            .grants
            .iter()
            .filter(|g| g.collection == *collection && Some(g.person) != except)
        {
            let user = self.keyring.user(&grant.person)?;
            events::record(
                tx,
                &self.signer,
                grant_set(
                    &vault_id,
                    &grant.person,
                    &user_public_key(user, &self.keys, &self.user_id),
                    collection,
                    &new,
                    epoch,
                    grant.role,
                    directory.held(grant.role),
                ),
            )?;
        }
        if let Some(organization) = organization {
            events::record(
                tx,
                &self.signer,
                organization_grant_set(&vault_id, organization, collection, &new, epoch),
            )?;
        }
        Ok((epoch, new))
    }

    /// A new database key, sealed to everyone in `keyring` and to the organization, and SQLCipher
    /// encrypts the whole file again. `keyring` becomes this vault's only once it is written. The
    /// key file keeps the old key until the database has changed, so a crash part way leaves a
    /// vault that opens with one or the other, and the next unlock finishes the change.
    fn rotate_database_key(&mut self, mut keyring: Keyring) -> Result<()> {
        let vault_id = self.keyring.vault_id;
        let new = crypto::random_key();
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

/// New keys for a person, `keys`, under `password`, in the caller's transaction, which it commits
/// once `keyring` is written: the database key, their grants and, for an admin, the organization
/// key are sealed to them again, and the organization certifies their new signing key. Their
/// recovery key goes, since it opened the old private key; `one_time` makes them choose a password
/// and get a new one at their next sign-in. `signer` signs the events: the admin who does it.
#[allow(clippy::too_many_arguments)]
fn rekey_person(
    tx: &Connection,
    keyring: &mut Keyring,
    organization: &KeyPair,
    database_key: &Key,
    person: Uuid,
    keys: &KeyPair,
    password: &str,
    one_time: bool,
    signer: &Signer,
) -> Result<()> {
    let vault_id = keyring.vault_id;
    let collections = organization_collections(tx, keyring, organization)?;
    let directory = Directory::load(tx)?;
    events::record(
        tx,
        signer,
        Body::PersonKeysChanged {
            person,
            public_key: keys.public.clone(),
        },
    )?;
    for grant in directory.grants.iter().filter(|g| g.person == person) {
        let open = collections
            .iter()
            .find(|c| c.id == grant.collection)
            .ok_or_else(|| Error::Corrupt("a collection is not sealed to the organization".into()))?;
        events::record(
            tx,
            signer,
            grant_set(
                &vault_id,
                &person,
                &keys.public,
                &grant.collection,
                &open.key,
                open.epoch,
                grant.role,
                directory.held(grant.role),
            ),
        )?;
    }
    signatures::add_organization_key(tx, signer, organization)?;
    let signing_key = signing::public(&signing::person_key(keys));
    events::record(
        tx,
        signer,
        signatures::organization_certificate(&vault_id, organization, person, &signing_key, &keys.public),
    )?;
    let old = keyring.user(&person)?.clone();
    let mut user = new_user(&vault_id, person, old.name, keys, password, database_key);
    user.must_set_password = one_time;
    if old.organization_key.is_some() {
        user.organization_key = Some(seal_organization_key(&vault_id, &user, organization));
    }
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
    type Row = (String, String, Option<String>, Vec<u8>, Vec<u8>, i64, i64);
    let mut statement = conn.prepare(
        "SELECT c.id, c.name, c.owner_id, o.enc, o.ciphertext, o.epoch, c.epoch
         FROM organization_grants o JOIN collections c ON c.id = o.collection_id ORDER BY c.created_at, c.rowid",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<Row>>>()?;
    rows.into_iter()
        .map(|(id, name, owner, enc, ciphertext, epoch, current)| {
            let id = parse_id(&id)?;
            if epoch != current {
                return Err(Error::Corrupt(format!(
                    "collection {id} is sealed to the organization at an earlier key"
                )));
            }
            let key = crypto::open_key(
                organization,
                &SealedBox { enc, ciphertext },
                &organization_grant_info(&keyring.vault_id, &id, epoch),
            )
            .ok_or_else(|| Error::Corrupt("a collection key does not open with the organization key".into()))?;
            let older = older_keys(conn, &keyring.vault_id, &id, Held::Collection, epoch, &key)?;
            Ok(OpenCollection {
                id,
                name,
                owner: owner.as_deref().map(parse_id).transpose()?,
                role: Role::Admin,
                held: Held::Collection,
                epoch,
                key,
                older,
            })
        })
        .collect()
}

pub(super) fn people(keyring: &Keyring) -> Vec<Person> {
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

/// The organization part of the key file for a key pair: its private key under its recovery key,
/// and the database key sealed to it.
fn new_organization(
    vault_id: &Uuid,
    organization: &KeyPair,
    recovery: &RecoveryKey,
    database_key: &Key,
) -> Organization {
    Organization {
        public_key: organization.public.clone(),
        private_key_by_recovery: crypto::encrypt(
            &crypto::recovery_key(&recovery.entropy(), vault_id.as_bytes()),
            &organization.secret,
            &keyring::organization_recovery_aad(vault_id),
        ),
        database_key: crypto::seal_key(
            &organization.public,
            database_key,
            &keyring::organization_database_key_info(vault_id),
        ),
    }
}

const PENDING_ORGANIZATION: &str = "pending_organization";

/// A new organization key on its way into the key file, kept in the database with the
/// collections sealed to it (Vault::take_admin_away). Nothing in it opens without an admin's own
/// key or the new recovery key.
#[derive(Serialize, Deserialize)]
struct PendingOrganization {
    organization: Organization,
    /// The new organization key, sealed to each admin it stays with.
    admins: Vec<(Uuid, SealedBox)>,
    /// The admin it no longer goes to.
    demoted: Uuid,
}

/// Puts a new organization key waiting in the database into the key file, and forgets it there.
/// Run on unlocking, so a change of organization key that stopped part way is finished before the
/// organization key is opened.
pub(super) fn finish_organization_change(conn: &Connection, keyring: &mut Keyring, dir: &Path) -> Result<()> {
    let Some(text) = conn
        .query_row(
            "SELECT value FROM meta WHERE name = ?1",
            params![PENDING_ORGANIZATION],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    else {
        return Ok(());
    };
    let pending: PendingOrganization = serde_json::from_str(&text)?;
    if keyring.organization.as_ref().map(|o| &o.public_key) != Some(&pending.organization.public_key) {
        let mut changed = keyring.clone();
        changed.organization = Some(pending.organization);
        for user in &mut changed.users {
            user.organization_key = if user.id == pending.demoted {
                None
            } else {
                pending
                    .admins
                    .iter()
                    .find(|(id, _)| *id == user.id)
                    .map(|(_, sealed)| sealed.clone())
                    .or(user.organization_key.take())
            };
        }
        changed.write(&dir.join(KEYRING_FILE))?;
        *keyring = changed;
    }
    conn.execute("DELETE FROM meta WHERE name = ?1", params![PENDING_ORGANIZATION])?;
    Ok(())
}

/// Makes a collection, signed by `signer`, and its key.
fn create_collection(conn: &Connection, signer: &Signer, name: &str, owner: Option<Uuid>) -> Result<(Uuid, Key)> {
    let id = Uuid::new_v4();
    events::record(
        conn,
        signer,
        Body::CollectionCreated {
            collection: id,
            name: name.to_owned(),
            owner,
        },
    )?;
    Ok((id, crypto::random_key()))
}

/// A grant of a role on a collection, its key sealed to a person at an epoch: what they hold of
/// the collection's `key`.
#[allow(clippy::too_many_arguments)]
pub(super) fn grant_set(
    vault_id: &Uuid,
    person: &Uuid,
    public_key: &[u8],
    collection: &Uuid,
    key: &Key,
    epoch: i64,
    role: Role,
    held: Held,
) -> Body {
    // A batch operator gets the batch key only, and a role that reads without chemistry the
    // summary key only, each made from the collection's `key`.
    let key = match held {
        Held::Collection => key.clone(),
        Held::Batch => super::batch_key(key, collection),
        Held::Summary => summary_key(key, collection),
    };
    Body::GrantSet {
        person: *person,
        collection: *collection,
        role,
        epoch,
        sealed: crypto::seal_key(public_key, &key, &grant_info(vault_id, collection, person, held, epoch)),
    }
}

/// A collection's key at an epoch, sealed to the organization.
fn organization_grant_set(vault_id: &Uuid, organization: &[u8], collection: &Uuid, key: &Key, epoch: i64) -> Body {
    Body::OrganizationGrantSet {
        collection: *collection,
        epoch,
        sealed: crypto::seal_key(organization, key, &organization_grant_info(vault_id, collection, epoch)),
    }
}

fn organization_grant_info(vault_id: &Uuid, collection_id: &Uuid, epoch: i64) -> Vec<u8> {
    format!(
        "glaze-vault v1 collection-key vault {vault_id} collection {collection_id} organization{}",
        epoch_words(epoch)
    )
    .into_bytes()
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
        // They log a mix of the sheet, under the batch key, which the rest of the team reads.
        let mix = as_ben
            .save_in(Kind::Mix, shared, &json!({ "name": "Shino", "lots": ["L-7"] }))
            .unwrap();
        assert_eq!(names(&as_ben, Kind::Mix), ["Shino"]);
        assert_eq!(names(&ana, Kind::Mix), ["Shino"]);
        as_ben
            .save(
                Kind::Mix,
                Some(mix.revision_id),
                &json!({ "name": "Shino", "lots": ["L-8"] }),
            )
            .unwrap();
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

        ana.save_in(Kind::Mix, shared, &json!({ "name": "Shino" })).unwrap();
        ana.set_role(ben.id, shared, Some(Role::Operator)).unwrap();
        assert_ne!(*ana.readable(&shared).unwrap().key, *kept_key);
        assert_eq!(names(&ana, Kind::Mix), ["Shino"]);
        assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
        assert_eq!(names(&ana, Kind::Batch), ["Shino"]);
        let as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
        assert!(names(&as_ben, Kind::Recipe).is_empty());
        assert_eq!(names(&as_ben, Kind::Batch), ["Shino"]);
        assert_eq!(names(&as_ben, Kind::Mix), ["Shino"]);
        drop(as_ben);

        // And taking it away again starts another key epoch, under which the sheets still open.
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
    fn only_an_admin_here_restores_over_a_teams_vault() {
        let (dir, mut ana, organization_sheet) = team();
        let ana_id = ana.me().id;
        let files = tempfile::tempdir().unwrap();
        let team_backup = files.path().join("team.gvbackup");
        ana.back_up(&team_backup).unwrap();
        ana.add_person("Ben", ONE_TIME, &[(shared(&ana), Role::Chemist)])
            .unwrap();
        drop(ana);
        // Ben's own vault, elsewhere, whose password he knows.
        let elsewhere = tempfile::tempdir().unwrap();
        let (mut bens, _) = Vault::create(elsewhere.path(), BENS).unwrap();
        let bens_backup = files.path().join("bens.gvbackup");
        bens.back_up(&bens_backup).unwrap();
        drop(bens);

        assert!(matches!(
            Vault::restore(dir.path(), &bens_backup, None, &Credential::Password(BENS)),
            Err(Error::NotAnAdminHere)
        ));
        assert_eq!(Vault::people_in(dir.path()).unwrap().len(), 2);
        assert!(Vault::set_aside(dir.path()).unwrap().is_empty());

        let (restored, set_aside) =
            Vault::restore(dir.path(), &team_backup, Some(ana_id), &Credential::Password(PASSWORD)).unwrap();
        assert!(set_aside.is_some());
        drop(restored);
        let words = organization_sheet.words().join(" ");
        Vault::restore_by_organization(dir.path(), &team_backup, &words, ana_id, "new admin password").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn removing_someone_can_be_finished_after_it_fails() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, mut ana, _) = team();
        let ben = ana
            .add_person("Ben", ONE_TIME, &[(shared(&ana), Role::Chemist)])
            .unwrap();
        // The key file cannot be written, so the database key cannot change.
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let failed = ana.remove_person(ben.id);
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(failed.is_err());
        // Ben is still listed, so nothing written later drops him while the database key stays.
        assert!(ana.people().unwrap().iter().any(|p| p.id == ben.id));
        assert!(Vault::people_in(dir.path()).unwrap().iter().any(|p| p.id == ben.id));
        assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);

        ana.remove_person(ben.id).unwrap();
        assert!(ana.people().unwrap().iter().all(|p| p.id != ben.id));
        assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
        assert!(matches!(
            Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME),
            Err(Error::NoSuchPerson)
        ));
    }

    #[test]
    fn taking_admin_away_gives_the_organization_and_every_collection_new_keys() {
        let (dir, mut ana, organization_sheet) = team();
        let ana_id = ana.me().id;
        let shared = shared(&ana);
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Formulator)]).unwrap();
        ana.make_admin(ben.id).unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        as_ben.set_own_password(BENS).unwrap();
        assert!(as_ben.me().admin);
        drop(as_ben);
        // One person signs in at a time, as in the app.
        drop(ana);
        let mut ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
        let kept_key = ana.readable(&shared).unwrap().key.clone();

        assert!(matches!(ana.take_admin_away(ana_id), Err(Error::NotAllowed)));
        assert!(matches!(ana.remove_person(ben.id), Err(Error::RemovingAdmin)));
        let new_sheet = ana.take_admin_away(ben.id).unwrap();
        assert!(matches!(ana.take_admin_away(ben.id), Err(Error::NotAnAdmin)));
        assert_ne!(*ana.readable(&shared).unwrap().key, *kept_key);
        assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
        assert!(!ana.people().unwrap().iter().find(|p| p.id == ben.id).unwrap().admin);

        // Ben keeps his role on Shared, and nothing more.
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
        assert!(!as_ben.me().admin);
        assert_eq!(names(&as_ben, Kind::Recipe), ["Shino"]);
        as_ben
            .save_in(Kind::Recipe, shared, &json!({ "name": "Ben's" }))
            .unwrap();
        assert!(matches!(as_ben.people(), Err(Error::NotAllowed)));
        assert!(
            as_ben
                .collections()
                .iter()
                .all(|c| c.id == shared || c.owner == Some(ben.id))
        );
        drop(as_ben);

        // The old organization sheet no longer opens anything; the new one does.
        drop(ana);
        let old = organization_sheet.words().join(" ");
        assert!(matches!(
            Vault::recover_organization(dir.path(), &old, ana_id, "anas new password"),
            Err(Error::WrongRecoveryKey)
        ));
        let (mut ana, _) =
            Vault::recover_organization(dir.path(), &new_sheet.words().join(" "), ana_id, "anas new password").unwrap();
        assert_eq!(names(&ana, Kind::Recipe), ["Ben's", "Shino"]);

        // And now he can be removed.
        ana.remove_person(ben.id).unwrap();
        assert!(matches!(
            Vault::unlock_as(dir.path(), Some(ben.id), BENS),
            Err(Error::NoSuchPerson)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_change_of_organization_key_that_stopped_is_finished_at_the_next_unlock() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, mut ana, _) = team();
        let ana_id = ana.me().id;
        let ben = ana.add_person("Ben", ONE_TIME, &[]).unwrap();
        ana.make_admin(ben.id).unwrap();
        // The collections change, and then the key file cannot be written.
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let failed = ana.take_admin_away(ben.id);
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(failed.is_err());
        // Still open, with the new key, so what is saved now is sealed as the collections are.
        ana.save(Kind::Recipe, None, &json!({ "name": "Tenmoku" })).unwrap();
        drop(ana);

        let mut ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
        assert!(ana.me().admin);
        assert_eq!(names(&ana, Kind::Recipe), ["Shino", "Tenmoku"]);
        assert!(
            !Vault::people_in(dir.path())
                .unwrap()
                .iter()
                .find(|p| p.id == ben.id)
                .unwrap()
                .admin
        );
        // The sheet that was not shown is replaced.
        let sheet = ana.new_organization_recovery_key().unwrap();
        drop(ana);
        Vault::recover_organization(dir.path(), &sheet.words().join(" "), ana_id, "anas new password").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn after_a_change_of_organization_key_stopped_the_next_one_builds_on_it() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, mut ana, old_sheet) = team();
        let ana_id = ana.me().id;
        let ben = ana.add_person("Ben", ONE_TIME, &[]).unwrap();
        let cara = ana.add_person("Cara", ONE_TIME, &[]).unwrap();
        ana.make_admin(ben.id).unwrap();
        ana.make_admin(cara.id).unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let failed = ana.take_admin_away(ben.id);
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(failed.is_err());

        // In the same session: Ben's change goes into the key file before Cara's starts, so he
        // does not get the newest organization key back.
        ana.take_admin_away(cara.id).unwrap();
        let admins: Vec<Uuid> = ana.people().unwrap().iter().filter(|p| p.admin).map(|p| p.id).collect();
        assert_eq!(admins, [ana_id]);
        // And a new sheet made now opens the organization the key file names.
        let sheet = ana.new_organization_recovery_key().unwrap();
        drop(ana);
        assert!(matches!(
            Vault::recover_organization(dir.path(), &old_sheet.words().join(" "), ana_id, "anas new password"),
            Err(Error::WrongRecoveryKey)
        ));
        let (ana, _) =
            Vault::recover_organization(dir.path(), &sheet.words().join(" "), ana_id, "anas new password").unwrap();
        assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
    }

    #[cfg(unix)]
    #[test]
    fn the_old_organization_sheet_does_not_open_a_change_that_stopped() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, mut ana, old_sheet) = team();
        let ana_id = ana.me().id;
        let ben = ana.add_person("Ben", ONE_TIME, &[]).unwrap();
        ana.make_admin(ben.id).unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
        assert!(ana.take_admin_away(ben.id).is_err());
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        drop(ana);
        // Nobody has unlocked since: recovering finishes the change, and the old sheet is refused.
        assert!(matches!(
            Vault::recover_organization(dir.path(), &old_sheet.words().join(" "), ana_id, "anas new password"),
            Err(Error::WrongRecoveryKey)
        ));
        let ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
        assert!(
            !Vault::people_in(dir.path())
                .unwrap()
                .iter()
                .find(|p| p.id == ben.id)
                .unwrap()
                .admin
        );
        assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
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
        assert!(matches!(ana.make_admin(Uuid::new_v4()), Err(Error::NoSuchPerson)));
    }

    #[test]
    fn a_batch_operator_made_admin_opens_the_collection() {
        let (dir, mut ana, _) = team();
        let shared = shared(&ana);
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Operator)]).unwrap();
        ana.make_admin(ben.id).unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        as_ben.set_own_password(BENS).unwrap();
        assert_eq!(
            *as_ben.readable(&shared).unwrap().key,
            *ana.readable(&shared).unwrap().key
        );
        assert_eq!(names(&as_ben, Kind::Recipe), ["Shino"]);
        as_ben.set_role(ben.id, shared, Some(Role::Chemist)).unwrap();
        assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
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

    type Stored = (String, Vec<u8>, Option<Vec<u8>>, i64);

    /// The stored rows of a collection, as bytes, to see that a change of key leaves them alone.
    fn stored(vault: &Vault, collection: Uuid) -> Vec<Stored> {
        let mut statement = vault
            .conn
            .prepare(
                "SELECT id, ciphertext, summary, epoch FROM revisions WHERE collection_id = ?1
                 UNION ALL SELECT id, ciphertext, NULL, epoch FROM attachments WHERE collection_id = ?1 ORDER BY 1",
            )
            .unwrap();
        statement
            .query_map(params![collection.to_string()], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    #[test]
    fn taking_a_role_away_starts_a_new_key_epoch_and_leaves_what_is_stored() {
        let (dir, mut ana, _) = team();
        let ana_id = ana.me().id;
        let shared = shared(&ana);
        let shino = ana.heads(Kind::Recipe).unwrap()[0].clone();
        ana.save_in(Kind::Batch, shared, &json!({ "name": "Shino sheet" }))
            .unwrap();
        let firing = ana
            .save_in(Kind::Firing, shared, &json!({ "name": "Cone 10" }))
            .unwrap();
        let photo = ana
            .add_attachment(Kind::Firing, firing.record_id, "image/jpeg", b"tile")
            .unwrap();
        let reader = ana
            .create_role(
                "Sales",
                &[Kind::Firing],
                Capabilities {
                    chemistry: false,
                    ..Capabilities::BUILT_IN
                },
            )
            .unwrap();
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Formulator)]).unwrap();
        let cleo = ana.add_person("Cleo", ONE_TIME, &[(shared, Role::Operator)]).unwrap();
        let dee = ana
            .add_person("Dee", ONE_TIME, &[(shared, Role::Custom(reader.id))])
            .unwrap();
        for person in [ben.id, cleo.id, dee.id] {
            Vault::unlock_as(dir.path(), Some(person), ONE_TIME)
                .unwrap()
                .set_own_password(BENS)
                .unwrap();
        }
        let bens_key = Vault::unlock_as(dir.path(), Some(ben.id), BENS)
            .unwrap()
            .readable(&shared)
            .unwrap()
            .key
            .clone();
        let before = stored(&ana, shared);

        ana.set_role(ben.id, shared, None).unwrap();
        // Nothing stored changed: only the collection's key did, at epoch 2.
        assert_eq!(stored(&ana, shared), before);
        let open = ana.readable(&shared).unwrap();
        assert_eq!(open.epoch, 2);
        assert_ne!(*open.key, *bens_key);
        assert_eq!(**open.key_at(1).unwrap(), *bens_key);
        assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);

        // What is saved now goes under the new key, which Ben's old one does not open.
        let tenmoku = ana
            .save_in(Kind::Recipe, shared, &json!({ "name": "Tenmoku" }))
            .unwrap();
        let (epoch, nonce, ciphertext): (i64, Vec<u8>, Vec<u8>) = ana
            .conn
            .query_row(
                "SELECT epoch, nonce, ciphertext FROM revisions WHERE id = ?1",
                params![tenmoku.revision_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(epoch, 2);
        let aad = super::super::revision_aad(
            &tenmoku.revision_id,
            &tenmoku.record_id,
            "recipe",
            &shared,
            1,
            None,
            false,
            None,
        );
        assert!(crypto::decrypt(&bens_key, &crypto::Sealed { nonce, ciphertext }, &aad).is_none());
        let shino_row: (Vec<u8>, Vec<u8>) = ana
            .conn
            .query_row(
                "SELECT nonce, ciphertext FROM revisions WHERE id = ?1",
                params![shino.revision_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let aad = super::super::revision_aad(
            &shino.revision_id,
            &shino.record_id,
            "recipe",
            &shared,
            1,
            None,
            false,
            None,
        );
        let sealed = crypto::Sealed {
            nonce: shino_row.0,
            ciphertext: shino_row.1,
        };
        assert!(crypto::decrypt(&bens_key, &sealed, &aad).is_some());

        // Those who stay read both epochs, each with the key they hold, after unlocking again.
        drop(ana);
        let ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
        assert_eq!(names(&ana, Kind::Recipe), ["Shino", "Tenmoku"]);
        let as_cleo = Vault::unlock_as(dir.path(), Some(cleo.id), BENS).unwrap();
        assert_eq!(as_cleo.readable(&shared).unwrap().epoch, 2);
        assert_eq!(names(&as_cleo, Kind::Batch), ["Shino sheet"]);
        assert!(names(&as_cleo, Kind::Recipe).is_empty());
        let as_dee = Vault::unlock_as(dir.path(), Some(dee.id), BENS).unwrap();
        assert_eq!(names(&as_dee, Kind::Firing), ["Cone 10"]);
        assert_eq!(names(&as_dee, Kind::Recipe), ["Shino", "Tenmoku"]);
        assert_eq!(&as_dee.attachment(photo.id).unwrap().1[..], b"tile");
        let as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
        assert!(names(&as_ben, Kind::Recipe).is_empty());
    }

    #[test]
    fn a_grant_from_an_earlier_epoch_is_refused() {
        let (dir, mut ana, _) = team();
        let shared = shared(&ana);
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
        let cleo = ana.add_person("Cleo", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
        Vault::unlock_as(dir.path(), Some(cleo.id), ONE_TIME)
            .unwrap()
            .set_own_password(BENS)
            .unwrap();
        // Cleo's grant at epoch 1, kept to put back.
        let (enc, ciphertext): (Vec<u8>, Vec<u8>) = ana
            .conn
            .query_row(
                "SELECT enc, ciphertext FROM grants WHERE user_id = ?1 AND collection_id = ?2",
                params![cleo.id.to_string(), shared.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        ana.set_role(ben.id, shared, None).unwrap();
        // Labelled as the current epoch, the old key does not open: the epoch is sealed with it.
        ana.conn
            .execute(
                "UPDATE grants SET enc = ?1, ciphertext = ?2 WHERE user_id = ?3 AND collection_id = ?4",
                params![enc, ciphertext, cleo.id.to_string(), shared.to_string()],
            )
            .unwrap();
        assert!(matches!(
            Vault::unlock_as(dir.path(), Some(cleo.id), BENS),
            Err(Error::Corrupt(_))
        ));
    }

    #[test]
    fn a_draft_saved_before_a_change_of_key_still_opens() {
        let (dir, mut ana, _) = team();
        let ana_id = ana.me().id;
        let ben = ana.add_person("Ben", ONE_TIME, &[]).unwrap();
        ana.make_admin(ben.id).unwrap();
        ana.save_draft(&json!({ "editing": "Celadon 2" })).unwrap();
        ana.take_admin_away(ben.id).unwrap();
        assert!(ana.collections.iter().all(|c| c.epoch == 2));
        assert_eq!(ana.draft().unwrap().unwrap()["editing"], "Celadon 2");
        drop(ana);
        let mut ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
        assert_eq!(ana.draft().unwrap().unwrap()["editing"], "Celadon 2");
        // A new draft goes under the current key.
        ana.save_draft(&json!({ "editing": "Celadon 3" })).unwrap();
        assert_eq!(ana.draft().unwrap().unwrap()["editing"], "Celadon 3");
    }
}
