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
        let public_key = self.public_key_of(person)?;
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
                    grant_set(&vault_id, &person, &public_key, &collection, &key, epoch, role, held),
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

    /// After a computer was lost or stolen (plan section 3.11), for an admin: every collection
    /// any of its people could read gets a new key, so what is saved from now on is out of reach
    /// of the keys on it, and each of its people but this admin gets new keys and a one-time
    /// password, which is returned to pass on, since their private keys are on it under their
    /// passwords.
    pub fn secure_after_lost(&mut self, people: &[Uuid]) -> Result<Vec<(Uuid, String)>> {
        self.admin()?;
        let any_admin = people.iter().any(|p| self.directory.is_admin(*p));
        let mut collections: Vec<Uuid> = if any_admin {
            self.directory.collections.iter().map(|c| c.id).collect()
        } else {
            self.directory
                .grants
                .iter()
                .filter(|g| people.contains(&g.person))
                .map(|g| g.collection)
                .collect()
        };
        collections.sort();
        collections.dedup();
        let tx = self.conn.unchecked_transaction()?;
        for collection in &collections {
            self.new_epoch_in(&tx, collection)?;
        }
        tx.commit()?;
        self.load_collections()?;
        let mut passwords = Vec::new();
        let reset: Vec<Uuid> = people
            .iter()
            .copied()
            .filter(|p| *p != self.user_id && self.directory.person(*p).is_some())
            .collect();
        for person in &reset {
            let password = one_time_password();
            self.reset_person(*person, &password)?;
            passwords.push((*person, password));
        }
        Ok(passwords)
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

    /// A person's public key, to seal keys to, from the directory, which knows everyone: on a
    /// replica the key file has only the people who sign in at it (ADR 20).
    fn public_key_of(&self, person: Uuid) -> Result<Vec<u8>> {
        if person == self.user_id {
            return Ok(self.keys.public.clone());
        }
        let key: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT public_key FROM people WHERE id = ?1 AND removed_at IS NULL",
                params![person.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        key.filter(|key| !key.is_empty()).ok_or(Error::NoSuchPerson)
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
                let open = self.readable(&grant.collection)?;
                events::record(
                    tx,
                    &self.signer,
                    grant_set(
                        &vault_id,
                        &grant.person,
                        &self.public_key_of(grant.person)?,
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
            events::record(
                tx,
                &self.signer,
                grant_set(
                    &vault_id,
                    &grant.person,
                    &self.public_key_of(grant.person)?,
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
    let collections = organization_collections(tx, keyring, organization, false)?;
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
    // On a replica the key file may not have their entry (ADR 20): the directory has their name,
    // and the new entry is kept only until it reaches the host.
    let old = keyring.user(&person).ok().cloned();
    let (name, admin, elsewhere) = match &old {
        Some(old) => (old.name.clone(), old.organization_key.is_some(), old.elsewhere),
        None => {
            let member = directory.person(person).ok_or(Error::NoSuchPerson)?;
            (member.name.clone(), member.admin, true)
        }
    };
    let mut user = new_user(&vault_id, person, name, keys, password, database_key);
    user.must_set_password = one_time;
    user.elsewhere = elsewhere;
    if admin {
        user.organization_key = Some(seal_organization_key(&vault_id, &user, organization));
    }
    match old {
        Some(_) => *super::user_mut(keyring, &person) = user,
        None => keyring.users.push(user),
    }
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

/// Every collection, opened with the organization's key, for an admin. On a replica that is still
/// catching up, a collection whose newest key has not all arrived is left closed until it has.
pub(super) fn organization_collections(
    conn: &Connection,
    keyring: &Keyring,
    organization: &KeyPair,
    catching_up: bool,
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
    let mut collections = Vec::new();
    for (id, name, owner, enc, ciphertext, epoch, current) in rows {
        let id = parse_id(&id)?;
        if epoch != current {
            if catching_up {
                continue;
            }
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
        let older = match older_keys(conn, &keyring.vault_id, &id, Held::Collection, epoch, &key) {
            Err(_) if catching_up => continue,
            older => older?,
        };
        collections.push(OpenCollection {
            id,
            name,
            owner: owner.as_deref().map(parse_id).transpose()?,
            role: Role::Admin,
            held: Held::Collection,
            epoch,
            key,
            older,
        });
    }
    Ok(collections)
}

pub(super) fn people(keyring: &Keyring) -> Vec<Person> {
    let mut people: Vec<Person> = keyring.users.iter().filter(|u| !u.elsewhere).map(person).collect();
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
        elsewhere: false,
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

pub(super) const PENDING_ORGANIZATION: &str = "pending_organization";

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

/// A one-time password to read out: three groups of four letters, about 56 bits.
fn one_time_password() -> String {
    const LETTERS: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let bytes: [u8; 12] = crypto::random();
    let letters: String = bytes
        .iter()
        .map(|b| LETTERS[*b as usize % LETTERS.len()] as char)
        .collect();
    format!("{}-{}-{}", &letters[..4], &letters[4..8], &letters[8..])
}

#[cfg(test)]
#[path = "team_tests.rs"]
mod tests;
