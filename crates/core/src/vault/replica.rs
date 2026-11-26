//! A replica (docs/adr/0020-sync-core.md): a vault on a computer that syncs with the LAN host. It
//! has its own database key and key file, with the entries of the people who sign in at it, and
//! holds what they may read. It applies what it pulls without opening it, checking each signature
//! again, and pushes what was saved on it, which the host numbers. Everything else works as on one
//! computer.

use super::events::{self, Body, SignedBy};
use super::host::{MODE, put_entry};
use super::items;
use super::signatures::Trust;
use super::{DATABASE_FILE, KEYRING_FILE, Vault, now_ms, parse_id, revision_aad, set_aside_orphan_database, summaries};
use crate::access::Directory;
use crate::crypto::{self, Sealed};
use crate::error::{Error, Result};
use crate::keyring::{self, Keyring, Organization, PersonEntry};
use crate::signing::{self, As};
use crate::store;
use crate::sync::{Batch, DeviceKey, EntryItem, Item, JoinPackage, Level, PushResult, Refusal, Scope, Welcome};
use rusqlite::{Connection, OptionalExtension, params};
use std::fs;
use std::path::Path;
use uuid::Uuid;

/// In `meta`, once this replica requires its host's key to be certified (ADR 34).
pub(super) const HOST_CERTIFICATE: &str = "host_certificate";

impl Vault {
    /// Makes this computer a replica of the vault a host serves, in `dir`, from what the host gave
    /// for it (HostStore::join_package) and its own key. It holds nothing until it first syncs;
    /// its people sign in with the passwords they have.
    pub fn join(dir: &Path, package: &JoinPackage, device: &DeviceKey) -> Result<()> {
        Vault::join_at(dir, package, device, None, None)
    }

    /// Joins as `join` does, keeping where the host was reached, to sync with it there, and the
    /// secret this computer and the host share from pairing, for extension codes (ADR 24).
    pub fn join_at(
        dir: &Path,
        package: &JoinPackage,
        device: &DeviceKey,
        address: Option<&str>,
        offline_secret: Option<&[u8]>,
    ) -> Result<()> {
        if Vault::exists(dir) {
            return Err(Error::VaultExists);
        }
        if package.device.device != device.id || package.device.signing_key != device.public() {
            return Err(Error::Corrupt("the certificate is for another computer".into()));
        }
        fs::create_dir_all(dir)?;
        set_aside_orphan_database(dir)?;
        let vault_id = package.vault;
        let database_key = crypto::random_key();
        let mut users = Vec::new();
        for item in &package.entries {
            let entry = item
                .parsed()
                .ok_or_else(|| Error::Corrupt(format!("the key file entry of {} does not read", item.person)))?;
            let sealed = crypto::seal_key(
                &entry.public_key,
                &database_key,
                &keyring::database_key_info(&vault_id, &entry.id),
            );
            users.push(entry.with_database_key(sealed));
        }
        let keyring = Keyring {
            format: keyring::TEAM_FORMAT,
            vault_id,
            users,
            organization: Some(Organization {
                public_key: package.organization.public_key.clone(),
                private_key_by_recovery: package.organization.private_key_by_recovery.clone(),
                database_key: crypto::seal_key(
                    &package.organization.public_key,
                    &database_key,
                    &keyring::organization_database_key_info(&vault_id),
                ),
            }),
        };

        let conn = store::open(&dir.join(DATABASE_FILE), &database_key)?;
        let tx = conn.unchecked_transaction()?;
        let certificate = serde_json::to_string(&package.device)?;
        for (name, value) in [
            ("vault_id", vault_id.to_string()),
            ("default_collection", package.default_collection.to_string()),
            (summaries::META, "1".to_owned()),
            ("directory", "1".to_owned()),
            (MODE, "replica".to_owned()),
            ("device", device.id.to_string()),
            ("device_key", hex::encode(*device.seed)),
            ("device_certificate", certificate),
            ("host_key", hex::encode(&package.host_key)),
            (HOST_CERTIFICATE, "required".to_owned()),
        ] {
            tx.execute("INSERT INTO meta (name, value) VALUES (?1, ?2)", params![name, value])?;
        }
        if let Some(address) = address {
            tx.execute(
                "INSERT INTO meta (name, value) VALUES ('host_address', ?1)",
                params![address],
            )?;
        }
        if let Some(secret) = offline_secret {
            tx.execute(
                "INSERT INTO meta (name, value) VALUES (?1, ?2)",
                params![super::offline::SECRET, hex::encode(secret)],
            )?;
        }
        for entry in &package.entries {
            put_entry(&tx, entry, false)?;
        }
        tx.commit()?;
        keyring.write(&dir.join(KEYRING_FILE))
    }

    /// This computer's own key, which it shows the host over TLS.
    pub fn device_key(&self) -> Result<DeviceKey> {
        let seed = self.meta("device_key")?.ok_or(Error::NotAllowed)?;
        let seed: [u8; 32] = hex::decode(seed)
            .ok()
            .and_then(|seed| seed.try_into().ok())
            .ok_or_else(|| Error::Corrupt("the computer's key is not valid".into()))?;
        Ok(DeviceKey {
            id: self.device()?,
            seed: zeroize::Zeroizing::new(seed),
        })
    }

    /// The host's key, pinned when this computer joined.
    pub fn host_key(&self) -> Result<Vec<u8>> {
        let key = self.meta("host_key")?.ok_or(Error::NotAllowed)?;
        hex::decode(key).map_err(|_| Error::Corrupt("the host's key is not valid".into()))
    }

    pub fn is_replica(&self) -> bool {
        self.meta(MODE).ok().flatten().as_deref() == Some("replica")
    }

    /// This computer's id, which the host knows it by.
    pub fn device(&self) -> Result<Uuid> {
        parse_id(&self.meta("device")?.ok_or(Error::NotAllowed)?)
    }

    /// Where this replica is in each scope, and what it was told its people hold in each, for its
    /// hello.
    #[allow(clippy::type_complexity)]
    pub fn sync_state(&self) -> Result<(Vec<(Scope, i64)>, Vec<(Scope, Vec<Level>)>)> {
        let rows = self
            .conn
            .prepare("SELECT scope, cursor, held FROM sync_state ORDER BY scope")?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut cursors = Vec::new();
        let mut levels = Vec::new();
        for (key, cursor, held) in rows {
            let scope = Scope::from_key(&key).ok_or_else(|| Error::Corrupt(format!("bad scope {key}")))?;
            cursors.push((scope, cursor));
            if let Some(held) = held {
                levels.push((scope, held.split(',').filter_map(Level::parse).collect()));
            }
        }
        Ok((cursors, levels))
    }

    /// Acts on the host's answer to hello: scopes whose keys changed start again from nothing,
    /// and scopes its people no longer read are dropped, with all this replica held of them.
    pub fn apply_welcome(&mut self, welcome: &Welcome) -> Result<()> {
        if welcome.revoked {
            return Err(Error::Revoked);
        }
        let tx = self.conn.unchecked_transaction()?;
        // The host was restored from a backup (plan section 3.9): pull everything again, and send
        // again what this computer's people saved, which it may have lost. Others' computers send
        // theirs; what was erased here stays erased.
        if !welcome.generation.is_nil() {
            let known: Option<String> = tx
                .query_row("SELECT value FROM meta WHERE name = 'host_generation'", [], |row| {
                    row.get(0)
                })
                .optional()?;
            let generation = welcome.generation.to_string();
            if known.as_deref().is_some_and(|known| known != generation) {
                tx.execute("UPDATE sync_state SET cursor = 0", [])?;
                tx.execute("DELETE FROM refused", [])?;
                let people: Vec<String> = self.keyring.users.iter().map(|u| u.id.to_string()).collect();
                let people = serde_json::to_string(&people)?;
                tx.execute(
                    "UPDATE changes SET host_seq = NULL WHERE
                        (item = 'revision' AND item_id IN
                            (SELECT id FROM revisions WHERE author_id IN (SELECT value FROM json_each(?1))))
                     OR (item = 'attachment' AND item_id IN
                            (SELECT id FROM attachments WHERE length(ciphertext) > 0
                             AND author_id IN (SELECT value FROM json_each(?1))))
                     OR (item = 'event' AND item_id IN
                            (SELECT id FROM events WHERE actor_id IN (SELECT value FROM json_each(?1))))",
                    params![people],
                )?;
            }
            tx.execute(
                "INSERT INTO meta (name, value) VALUES ('host_generation', ?1)
                 ON CONFLICT (name) DO UPDATE SET value = excluded.value",
                params![generation],
            )?;
        }
        for scope in welcome.reset.iter().chain(&welcome.dropped) {
            if let Scope::Collection(collection) = scope {
                let collection = collection.to_string();
                // Pulled again from the start; what was saved here and has not reached the host
                // stays, to be sealed again and sent, unless this computer may no longer read it.
                // With the revisions those build on, which the pull brings again anyway.
                let keep = if welcome.reset.contains(scope) {
                    "AND id NOT IN (WITH RECURSIVE kept(id) AS (
                         SELECT item_id FROM changes WHERE collection_id = ?1 AND host_seq IS NULL
                         UNION SELECT r.parent_id FROM revisions r JOIN kept ON r.id = kept.id
                         WHERE r.parent_id IS NOT NULL)
                     SELECT id FROM kept)"
                } else {
                    ""
                };
                for table in ["attachments", "revisions"] {
                    tx.execute(
                        &format!("DELETE FROM {table} WHERE collection_id = ?1 {keep}"),
                        params![collection],
                    )?;
                }
                let keep_changes = if keep.is_empty() {
                    ""
                } else {
                    "AND host_seq IS NOT NULL"
                };
                tx.execute(
                    &format!("DELETE FROM changes WHERE collection_id = ?1 {keep_changes}"),
                    params![collection],
                )?;
                tx.execute("DELETE FROM sync_state WHERE scope = ?1", params![collection])?;
            }
        }
        for (scope, held) in &welcome.levels {
            let held = held.iter().map(|l| l.code()).collect::<Vec<_>>().join(",");
            tx.execute(
                "INSERT INTO sync_state (scope, cursor, held) VALUES (?1, 0, ?2)
                 ON CONFLICT (scope) DO UPDATE SET held = excluded.held",
                params![scope.key(), held],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Applies what was pulled, in order, all or none: each item's signature checked again, and
    /// what this replica pushed itself only given the host's number. Then the cursors move on.
    pub fn apply_batch(&mut self, batch: &Batch) -> Result<()> {
        let vault = self.keyring.vault_id;
        let database_key = self.database_key()?;
        let mut keyring = self.keyring.clone();
        let tx = self.conn.unchecked_transaction()?;
        let mut trust = Trust::load(&tx, vault)?;
        for pulled in &batch.items {
            let seq = pulled.seq;
            match &pulled.item {
                // A record this replica erased, which the host has not taken the erasure of yet,
                // stays erased: if the host refuses it, the collection is pulled again from the
                // start (apply_push_result).
                Item::Revision(r) if erased_here(&tx, &r.record)? => {}
                Item::Attachment(a) if erased_here(&tx, &a.record)? => {}
                Item::Revision(r) => {
                    if !items::exists(&tx, "revisions", &r.id)? {
                        items::verify_revision(&trust, &vault, r)?;
                        items::store_revision(&tx, r)?;
                        items::log(&tx, "revision", &r.id, &r.collection, r.kind, Some(seq))?;
                    }
                }
                Item::Attachment(a) => {
                    if !items::exists(&tx, "attachments", &a.id)? {
                        items::verify_attachment(&trust, &vault, a)?;
                        items::store_attachment(&tx, a)?;
                        items::log(&tx, "attachment", &a.id, &a.collection, a.kind, Some(seq))?;
                    }
                }
                Item::Event(e) => {
                    if !items::exists(&tx, "events", &e.id)? {
                        let event = items::event_of(e).map_err(|refusal| Error::Corrupt(format!("{refusal:?}")))?;
                        items::verify_event(&trust, &vault, &event)?;
                        events::apply(&tx, &event)?;
                        if matches!(
                            event.body,
                            Body::CertificateIssued { .. } | Body::OrganizationKeyAdded { .. }
                        ) {
                            trust = Trust::load(&tx, vault)?;
                        }
                    }
                }
                Item::Entry(entry) => take_entry(&tx, &trust, &mut keyring, &database_key, entry)?,
            }
            // Its own items come back with the host's number; whatever this replica logged for
            // an item, it is no longer waiting to be pushed.
            tx.execute(
                "UPDATE changes SET host_seq = ?1 WHERE item_id = ?2 AND host_seq IS NULL",
                params![seq, pulled.item.id().to_string()],
            )?;
        }
        for (scope, cursor) in &batch.cursors {
            tx.execute(
                "INSERT INTO sync_state (scope, cursor) VALUES (?1, ?2)
                 ON CONFLICT (scope) DO UPDATE SET cursor = excluded.cursor",
                params![scope.key(), cursor],
            )?;
        }
        // Once caught up, the host must be one the organization vouches for (ADR 34). A computer
        // that joined before hosts were certified trusts its pin until a certificate comes, and
        // requires one from then on. Nothing pulled is kept from a host that fails.
        if !batch.more {
            let pinned = self.host_key()?;
            if self.host_certified(&pinned)? {
                tx.execute(
                    "INSERT INTO meta (name, value) VALUES (?1, 'required')
                     ON CONFLICT (name) DO UPDATE SET value = excluded.value",
                    params![HOST_CERTIFICATE],
                )?;
            } else if self.meta(HOST_CERTIFICATE)?.is_some() {
                return Err(Error::HostNotCertified);
            }
        }
        tx.commit()?;
        if keyring.users.len() != self.keyring.users.len()
            || serde_json::to_string(&keyring.users)? != serde_json::to_string(&self.keyring.users)?
        {
            keyring.write(&self.dir.join(KEYRING_FILE))?;
            self.keyring = keyring;
        }
        self.load_collections()
    }

    /// What this replica has to push, in the order it was saved, up to about `max_bytes`: its own
    /// revisions, attachments and events, and the key file entries changed here. What this
    /// person saved under a key the collection has since replaced is sealed again first.
    pub fn pending(&mut self, max_bytes: usize) -> Result<Vec<Item>> {
        self.reseal_pending()?;
        let rows = self
            .conn
            .prepare(
                "SELECT item, item_id FROM changes WHERE host_seq IS NULL AND item IN ('revision', 'attachment', 'event')
                 AND item_id NOT IN (SELECT item_id FROM refused) ORDER BY seq",
            )?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut pending: Vec<Item> = Vec::new();
        let mut size = 0;
        for (item, id) in rows {
            if pending.iter().any(|p| p.id().to_string() == id) {
                continue;
            }
            let item = match item.as_str() {
                "revision" => Item::Revision(items::revision_item(&self.conn, &id, false)?),
                "attachment" => Item::Attachment(items::attachment_item(&self.conn, &id)?),
                _ => Item::Event(items::event_item(&self.conn, &id)?),
            };
            size += item.size();
            pending.push(item);
            if size >= max_bytes {
                return Ok(pending);
            }
        }
        pending.extend(self.changed_entries()?.into_iter().map(Item::Entry));
        Ok(pending)
    }

    /// Whether changes to people, roles or collections made here wait for the host: a sync sends
    /// them only while this computer holds the directory.
    pub fn directory_waiting(&self) -> Result<bool> {
        let bodies = self
            .conn
            .prepare(
                "SELECT e.body FROM changes c JOIN events e ON e.id = c.item_id
                 WHERE c.host_seq IS NULL AND c.item = 'event' AND c.item_id NOT IN (SELECT item_id FROM refused)",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(bodies
            .iter()
            .filter_map(|b| serde_json::from_str::<Body>(b).ok())
            .any(|b| b.needs_directory()))
    }

    /// The key file entries changed on this computer since the host last had them, signed by this
    /// person: their own, or anyone's for an admin.
    fn changed_entries(&self) -> Result<Vec<EntryItem>> {
        let admin = self.admin().is_ok();
        let mut changed = Vec::new();
        for user in &self.keyring.users {
            if user.id != self.user_id && !admin {
                continue;
            }
            let entry = serde_json::to_string(&PersonEntry::of(user))?;
            let known: Option<String> = self
                .conn
                .query_row(
                    "SELECT entry FROM key_entries WHERE person_id = ?1",
                    params![user.id.to_string()],
                    |row| row.get(0),
                )
                .optional()?;
            if known.as_deref() == Some(entry.as_str()) {
                continue;
            }
            let at = now_ms();
            let signature = self
                .signer
                .sign(&signing::entry_payload(&self.keyring.vault_id, &user.id, at, &entry));
            changed.push(EntryItem {
                person: user.id,
                entry,
                at,
                signer: self.user_id,
                signature,
            });
        }
        Ok(changed)
    }

    /// Acts on what the host took and what it would not. What it took is no longer waiting. Of
    /// what it would not: anything of a record erased since goes; an erasure of a record changed
    /// since is undone, and the collection pulled again from the start to bring the record back;
    /// something under a key since replaced is sealed again before the next push; anything else
    /// stays here, set aside, to show.
    pub fn apply_push_result(&mut self, result: &PushResult, pushed: &[Item]) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let mut gone_elsewhere = Vec::new();
        for (id, seq) in &result.accepted {
            tx.execute(
                "UPDATE changes SET host_seq = ?1 WHERE item_id = ?2 AND host_seq IS NULL",
                params![seq, id.to_string()],
            )?;
            if let Some(Item::Entry(entry)) = pushed.iter().find(|item| item.id() == *id) {
                put_entry(&tx, entry, false)?;
                gone_elsewhere.push(entry.person);
            }
        }
        for (id, refusal) in &result.refused {
            let id_text = id.to_string();
            match refusal {
                // Sealed again, its bytes sent, or the directory held, before the next push.
                Refusal::StaleEpoch { .. } | Refusal::BytesMissing | Refusal::DirectoryNotHeld => {}
                Refusal::Erased => {
                    tx.execute("DELETE FROM changes WHERE item_id = ?1", params![id_text])?;
                    tx.execute("DELETE FROM attachments WHERE id = ?1", params![id_text])?;
                    tx.execute(
                        "DELETE FROM revisions WHERE id = ?1 AND NOT EXISTS
                         (SELECT 1 FROM revisions c WHERE c.parent_id = revisions.id)",
                        params![id_text],
                    )?;
                }
                Refusal::ChangedElsewhere => {
                    let body: Option<String> = tx
                        .query_row("SELECT body FROM events WHERE id = ?1", params![id_text], |row| {
                            row.get(0)
                        })
                        .optional()?;
                    if let Some(Body::Erased { record, collection, .. }) =
                        body.as_deref().and_then(|b| serde_json::from_str(b).ok())
                    {
                        tx.execute("DELETE FROM changes WHERE item_id = ?1", params![id_text])?;
                        tx.execute("DELETE FROM events WHERE id = ?1", params![id_text])?;
                        tx.execute("DELETE FROM erased WHERE record_id = ?1", params![record.to_string()])?;
                        tx.execute(
                            "UPDATE sync_state SET cursor = 0 WHERE scope = ?1",
                            params![collection.to_string()],
                        )?;
                    }
                }
                _ => {
                    tx.execute(
                        "INSERT OR REPLACE INTO refused (item_id, refusal, at) VALUES (?1, ?2, ?3)",
                        params![id_text, refusal.code(), now_ms()],
                    )?;
                }
            }
        }
        tx.commit()?;
        // An entry reset here for someone who signs in elsewhere has gone on to their computers.
        if self
            .keyring
            .users
            .iter()
            .any(|u| u.elsewhere && gone_elsewhere.contains(&u.id))
        {
            let mut keyring = self.keyring.clone();
            keyring
                .users
                .retain(|u| !(u.elsewhere && gone_elsewhere.contains(&u.id)));
            keyring.write(&self.dir.join(KEYRING_FILE))?;
            self.keyring = keyring;
        }
        self.load_collections()
    }

    /// What the host would not take, by item, for the screens to show.
    pub fn refused(&self) -> Result<Vec<(Uuid, Refusal)>> {
        self.conn
            .prepare("SELECT item_id, refusal FROM refused ORDER BY at")?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|(id, refusal)| Ok((parse_id(&id)?, serde_json::from_str(&refusal)?)))
            .collect()
    }

    /// Seals again, under its collection's newest key, what this person saved here and the host
    /// does not have yet, if the collection got a newer key meanwhile (plan section 3.4). Waiting,
    /// it may still change.
    fn reseal_pending(&mut self) -> Result<()> {
        let me = self.user_id.to_string();
        let stale = |table: &str| -> Result<Vec<String>> {
            Ok(self
                .conn
                .prepare(&format!(
                    "SELECT t.id FROM {table} t JOIN changes c ON c.item_id = t.id
                     JOIN collections k ON k.id = t.collection_id
                     WHERE c.host_seq IS NULL AND t.epoch < k.epoch AND t.author_id = ?1"
                ))?
                .query_map(params![me], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        };
        let (revisions, attachments) = (stale("revisions")?, stale("attachments")?);
        if revisions.is_empty() && attachments.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        for id in revisions {
            self.reseal_revision(&tx, &id)?;
        }
        for id in attachments {
            self.reseal_attachment(&tx, &id)?;
        }
        tx.commit()?;
        Ok(())
    }

    fn reseal_revision(&self, tx: &Connection, id: &str) -> Result<()> {
        let item = items::revision_item(tx, id, false)?;
        let open = self.readable(&item.collection)?;
        let epoch = open.epoch;
        let aad = revision_aad(
            &item.id,
            &item.record,
            item.kind.as_str(),
            &item.collection,
            item.number,
            item.parent.as_ref(),
            item.deleted,
            item.supersedes.as_deref(),
        );
        let old = self.key_for(open, item.kind, item.epoch)?.ok_or(Error::NotAllowed)?;
        let new = self.key_for(open, item.kind, epoch)?.ok_or(Error::NotAllowed)?;
        let plain = crypto::decrypt(
            &old,
            &Sealed {
                nonce: item.nonce,
                ciphertext: item.ciphertext,
            },
            &aad,
        )
        .ok_or_else(|| Error::Corrupt(format!("revision {id} does not decrypt")))?;
        let sealed = crypto::encrypt(&new, &plain, &aad);
        tx.execute(
            "UPDATE revisions SET nonce = ?1, ciphertext = ?2, content_hash = ?3, epoch = ?4 WHERE id = ?5",
            params![
                &sealed.nonce,
                &sealed.ciphertext,
                store::content_hash(&sealed.nonce, &sealed.ciphertext),
                epoch,
                id
            ],
        )?;
        if let Some(summary) = item.summary {
            let (old, new) = (
                self.summary_key_for(open, item.epoch)?.ok_or(Error::NotAllowed)?,
                self.summary_key_for(open, epoch)?.ok_or(Error::NotAllowed)?,
            );
            let sealed = summaries::reseal(
                &old,
                &new,
                &Sealed {
                    nonce: summary.nonce,
                    ciphertext: summary.summary,
                },
                &aad,
                &aad,
            )?;
            tx.execute(
                "UPDATE revisions SET summary_nonce = ?1, summary = ?2 WHERE id = ?3",
                params![sealed.nonce, sealed.ciphertext, id],
            )?;
        }
        self.sign_stored_revision(tx, &item.id, As::Author)
    }

    fn reseal_attachment(&self, tx: &Connection, id: &str) -> Result<()> {
        let item = items::attachment_item(tx, id)?;
        let open = self.readable(&item.collection)?;
        let epoch = open.epoch;
        let aad = super::attachments::aad(
            &item.id,
            &item.record,
            item.kind.as_str(),
            &item.collection,
            &item.media_type,
        );
        let old = self.key_for(open, item.kind, item.epoch)?.ok_or(Error::NotAllowed)?;
        let new = self.key_for(open, item.kind, epoch)?.ok_or(Error::NotAllowed)?;
        let plain = crypto::decrypt(
            &old,
            &Sealed {
                nonce: item.nonce,
                ciphertext: item.ciphertext,
            },
            &aad,
        )
        .ok_or_else(|| Error::Corrupt(format!("attachment {id} does not decrypt")))?;
        let sealed = crypto::encrypt(&new, &plain, &aad);
        tx.execute(
            "UPDATE attachments SET nonce = ?1, ciphertext = ?2, sha256 = ?3, epoch = ?4 WHERE id = ?5",
            params![
                &sealed.nonce,
                &sealed.ciphertext,
                store::attachment_hash(&sealed.nonce, &sealed.ciphertext),
                epoch,
                id
            ],
        )?;
        self.sign_stored_attachment(tx, &item.id, As::Author)
    }
}

/// How long what the host said of checkouts holds, unless a sync says it again: past that, this
/// computer is taken to be offline, and saves as it would without a host (plan section 3.5).
const CHECKOUTS_HOLD_MS: i64 = 2 * 60 * 1000;

impl Vault {
    /// The attachments pulled without their bytes, newest first, with how much of each has come.
    pub fn missing_bytes(&self) -> Result<Vec<(Uuid, u64)>> {
        let mut ids = self
            .conn
            .prepare("SELECT id FROM attachments WHERE length(ciphertext) = 0 ORDER BY created_at DESC")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // Those someone opened first; with photos on demand, only those.
        let wanted = self.wanted_photos()?;
        ids.sort_by_key(|id| !wanted.contains(id));
        if self.photos_on_demand()? {
            ids.retain(|id| wanted.contains(id));
        }
        ids.iter()
            .map(|id| {
                let id = parse_id(id)?;
                Ok((id, items::staged_length(&self.conn, &id)?.0))
            })
            .collect()
    }

    /// Whether this computer fetches photos only when someone opens them (the plan's question 9),
    /// rather than all of them: for a laptop short of room. Off by default on a computer; on by
    /// default on a phone or tablet, so years of test tiles do not fill it (ADR 32).
    pub fn photos_on_demand(&self) -> Result<bool> {
        Ok(match self.meta(PHOTOS_ON_DEMAND)?.as_deref() {
            Some(set) => set == "1",
            None => PHOTOS_ON_DEMAND_UNSET,
        })
    }

    pub fn set_photos_on_demand(&mut self, on: bool) -> Result<()> {
        self.set_meta(PHOTOS_ON_DEMAND, if on { "1" } else { "0" })
    }

    fn wanted_photos(&self) -> Result<Vec<String>> {
        Ok(self
            .meta(PHOTOS_WANTED)?
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default())
    }

    /// Fetches this photo at the next sync, before any other: someone opened it.
    pub fn want_photo(&mut self, id: Uuid) -> Result<()> {
        let missing: Vec<String> = self
            .conn
            .prepare("SELECT id FROM attachments WHERE length(ciphertext) = 0")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut wanted = self.wanted_photos()?;
        wanted.retain(|w| missing.contains(w));
        let id = id.to_string();
        if missing.contains(&id) && !wanted.contains(&id) {
            wanted.push(id);
        }
        self.set_meta(PHOTOS_WANTED, &serde_json::to_string(&wanted)?)
    }

    /// Keeps a piece of an attachment's bytes from the host. Once they have all come they are
    /// checked against the hash its signature covers, and kept with it. Whether it is whole now.
    pub fn take_chunk(&mut self, chunk: &crate::sync::Chunk) -> Result<bool> {
        let row: Option<(Vec<u8>, Vec<u8>, i64)> = self
            .conn
            .query_row(
                "SELECT nonce, sha256, length(ciphertext) FROM attachments WHERE id = ?1",
                params![chunk.id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((nonce, sha256, length)) = row else {
            items::unstage(&self.conn, &chunk.id)?;
            return Ok(false);
        };
        if length > 0 {
            return Ok(true);
        }
        let (had, _) = items::staged_length(&self.conn, &chunk.id)?;
        if chunk.offset != had || had + chunk.bytes.len() as u64 > chunk.total {
            return Err(Error::Corrupt("a piece of a photo came out of order".into()));
        }
        let tx = self.conn.unchecked_transaction()?;
        items::stage(&tx, &chunk.id, None, chunk.offset, &chunk.bytes)?;
        let whole = had + chunk.bytes.len() as u64 == chunk.total;
        if whole {
            if items::staged_hash(&tx, &chunk.id, &nonce)? != sha256 {
                items::unstage(&tx, &chunk.id)?;
                tx.commit()?;
                return Err(Error::BadSignature);
            }
            items::unstage_into(&tx, &chunk.id)?;
        }
        tx.commit()?;
        Ok(whole)
    }

    /// An attachment's ciphertext, to send to the host in pieces.
    pub fn attachment_bytes(&self, id: Uuid) -> Result<Vec<u8>> {
        Ok(self.conn.query_row(
            "SELECT ciphertext FROM attachments WHERE id = ?1",
            params![id.to_string()],
            |row| row.get(0),
        )?)
    }

    /// How many things saved here wait to reach the host, leaving out what it would not take.
    pub fn waiting(&self) -> Result<usize> {
        let count: i64 = self.conn.query_row(
            "SELECT count(DISTINCT item_id) FROM changes WHERE host_seq IS NULL
             AND item IN ('revision', 'attachment', 'event') AND item_id NOT IN (SELECT item_id FROM refused)",
            [],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    /// The organization's signing key, which the host advertises a tag of (ADR 21), so this
    /// computer can find its host again when its address changes.
    pub fn organization_signing_key(&self) -> Option<Vec<u8>> {
        self.directory.organization_keys.last().cloned()
    }

    /// What the host just said of who is changing what.
    pub fn set_checkouts(&mut self, checkouts: Vec<crate::sync::Checkout>) {
        self.checkouts = Some((now_ms(), checkouts));
    }

    /// Who is changing what, as the host said in the last little while; nothing if it has not.
    pub fn checkouts(&self) -> Vec<crate::sync::Checkout> {
        match &self.checkouts {
            Some((at, checkouts)) if now_ms() - at < CHECKOUTS_HOLD_MS => checkouts.clone(),
            _ => Vec::new(),
        }
    }

    /// The name of someone in the vault.
    pub fn name_of(&self, person: Uuid) -> Option<String> {
        self.directory.person(person).map(|p| p.name.clone())
    }

    /// The name of whoever else has a record checked out, if someone has.
    pub(super) fn checked_out_by(&self, record: Uuid) -> Option<String> {
        self.checkouts()
            .into_iter()
            .find(|c| c.record == record && c.person != self.user_id)
            .map(|c| {
                self.directory
                    .person(c.person)
                    .map_or_else(|| "Someone".to_owned(), |p| p.name.clone())
            })
    }

    /// Takes this computer out of the vault (plan section 2.3): the replica's files are written
    /// over and removed. What was not synced is lost; the screen says so first.
    pub fn leave(self) -> Result<()> {
        if !self.is_replica() {
            return Err(Error::NotAllowed);
        }
        let dir = self.dir.clone();
        drop(self);
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.is_file() {
                let length = fs::metadata(&path)?.len();
                let mut file = fs::OpenOptions::new().write(true).open(&path)?;
                let zeros = vec![0u8; 64 * 1024];
                let mut left = length;
                while left > 0 {
                    let n = left.min(zeros.len() as u64) as usize;
                    std::io::Write::write_all(&mut file, &zeros[..n])?;
                    left -= n as u64;
                }
                file.sync_all()?;
            }
        }
        fs::remove_dir_all(&dir)?;
        Ok(())
    }
}

/// Whether a record has a tombstone here.
fn erased_here(conn: &Connection, record: &Uuid) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM erased WHERE record_id = ?1",
            params![record.to_string()],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Takes a person's newer key file entry into this replica's key file, sealing its own database
/// key to them if they are new here. It must be signed by the person or an admin, as the host
/// checks, so a host that was tampered with cannot send an old or made-up entry.
fn take_entry(
    conn: &Connection,
    trust: &Trust,
    keyring: &mut Keyring,
    database_key: &crypto::Key,
    item: &EntryItem,
) -> Result<()> {
    let entry = item
        .parsed()
        .ok_or_else(|| Error::Corrupt(format!("the key file entry of {} does not read", item.person)))?;
    // Only an entry with the keys the directory, whose events are each checked, gives the person:
    // a host that was tampered with cannot put other keys in this computer's key file.
    let public_key: Option<Vec<u8>> = conn
        .query_row(
            "SELECT public_key FROM people WHERE id = ?1",
            params![item.person.to_string()],
            |row| row.get(0),
        )
        .optional()?;
    if entry.id != item.person || public_key.as_ref() != Some(&entry.public_key) {
        return Err(Error::Corrupt(format!(
            "the key file entry of {} does not match the directory",
            item.person
        )));
    }
    let vault_id = keyring.vault_id;
    let signed = SignedBy {
        signature: item.signature.clone(),
        signer: item.signer,
        role: As::Author,
    };
    let payload = signing::entry_payload(&vault_id, &item.person, item.at, &item.entry);
    if item.signer != item.person && !Directory::load(conn)?.is_admin(item.signer)
        || trust.check(&signed, &payload).check == super::SignatureCheck::Bad
    {
        return Err(Error::BadSignature);
    }
    // An entry changed here that has not reached the host yet, such as a password chosen at a
    // first sign-in, stays: it is pushed after this pull, and the host keeps the newer.
    if let Some(user) = keyring.users.iter().find(|u| u.id == entry.id) {
        let known: Option<String> = conn
            .query_row(
                "SELECT entry FROM key_entries WHERE person_id = ?1",
                params![entry.id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        if known.is_some_and(|known| known != serde_json::to_string(&PersonEntry::of(user)).unwrap_or_default()) {
            return Ok(());
        }
    }
    let sealed = match keyring.users.iter().find(|u| u.id == entry.id) {
        Some(user) if user.public_key == entry.public_key => user.database_key.clone(),
        _ => crypto::seal_key(
            &entry.public_key,
            database_key,
            &keyring::database_key_info(&vault_id, &entry.id),
        ),
    };
    let user = entry.with_database_key(sealed);
    match keyring.users.iter_mut().find(|u| u.id == user.id) {
        Some(existing) => *existing = user,
        None => keyring.users.push(user),
    }
    put_entry(conn, item, false)
}

/// Where a replica keeps whether it fetches photos only when opened, and which were (meta).
const PHOTOS_ON_DEMAND: &str = "photos_on_demand";
/// What photos on demand is until someone chooses: on for phones and tablets.
const PHOTOS_ON_DEMAND_UNSET: bool = cfg!(any(target_os = "ios", target_os = "android"));
const PHOTOS_WANTED: &str = "photos_wanted";

#[cfg(test)]
#[path = "replica_tests.rs"]
pub(crate) mod tests;
