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
    /// rather than all of them, which is the default: for a laptop short of room.
    pub fn photos_on_demand(&self) -> Result<bool> {
        Ok(self.meta(PHOTOS_ON_DEMAND)?.as_deref() == Some("1"))
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
            let ciphertext = items::staged(&tx, &chunk.id)?;
            items::unstage(&tx, &chunk.id)?;
            if store::attachment_hash(&nonce, &ciphertext) != sha256 {
                tx.commit()?;
                return Err(Error::BadSignature);
            }
            tx.execute(
                "UPDATE attachments SET ciphertext = ?1 WHERE id = ?2",
                params![ciphertext, chunk.id.to_string()],
            )?;
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
const PHOTOS_WANTED: &str = "photos_wanted";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::Role;
    use crate::vault::items::CHUNK_BYTES;
    use crate::vault::{Capabilities, HostStore, Kind};
    use serde_json::json;
    use tempfile::TempDir;

    const PASSWORD: &str = "cone six oxidation";
    const ONE_TIME: &str = "pass this on";
    const OWN: &str = "their own password";

    /// One round of syncing, as crates/sync's session runs it: hello, pull until done, push.
    pub(crate) fn sync(vault: &mut Vault, host: &mut HostStore) -> PushResult {
        let device = vault.device().unwrap();
        let (_, levels) = vault.sync_state().unwrap();
        let welcome = host.hello(device, &levels).unwrap();
        vault.apply_welcome(&welcome).unwrap();
        loop {
            let (cursors, _) = vault.sync_state().unwrap();
            let batch = host.pull(device, &cursors, 64 * 1024).unwrap();
            vault.apply_batch(&batch).unwrap();
            if !batch.more {
                break;
            }
        }
        for (id, mut offset) in vault.missing_bytes().unwrap() {
            while let Some(chunk) = host.chunk(device, id, offset).unwrap() {
                offset += chunk.bytes.len() as u64;
                if vault.take_chunk(&chunk).unwrap() {
                    break;
                }
            }
        }
        let pending = vault.pending(usize::MAX).unwrap();
        let result = host.accept(device, pending.clone()).unwrap();
        vault.apply_push_result(&result, &pending).unwrap();
        result
    }

    struct Team {
        _dirs: Vec<TempDir>,
        host: HostStore,
        shared: Uuid,
        production: Uuid,
        ana: Uuid,
        ben: Uuid,
        cleo: Uuid,
        dee: Uuid,
        recipe: Uuid,
        sheet: Uuid,
        firing: Uuid,
        /// Each person's computer, unlocked and synced once.
        computers: Vec<Vault>,
    }

    /// Ana (admin), Ben (formulator), Cleo (batch operator) and Dee (reads without chemistry) on
    /// Shared; Production is Ana's only. A recipe, its batch sheet, and a firing with a photo, made
    /// before the vault was hosted; then each of them on a computer of their own.
    fn team() -> Team {
        let (vault_dir, host_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (mut ana, _) = Vault::create(vault_dir.path(), PASSWORD).unwrap();
        ana.grow_into_team("Ana").unwrap();
        let ana_id = ana.me().id;
        let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        let production = ana.create_collection("Production").unwrap().id;
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
        let mut people = Vec::new();
        for (name, role) in [
            ("Ben", Role::Formulator),
            ("Cleo", Role::Operator),
            ("Dee", Role::Custom(reader.id)),
        ] {
            people.push(ana.add_person(name, ONE_TIME, &[(shared, role)]).unwrap().id);
        }
        for person in &people {
            Vault::unlock_as(vault_dir.path(), Some(*person), ONE_TIME)
                .unwrap()
                .set_own_password(OWN)
                .unwrap();
        }
        ana.load_collections().unwrap();
        let recipe = ana
            .save_in(
                Kind::Recipe,
                shared,
                &json!({ "name": "Shino", "lines": [], "notes": "secret" }),
            )
            .unwrap()
            .record_id;
        let sheet = ana
            .save_in(Kind::Batch, shared, &json!({ "name": "Shino sheet" }))
            .unwrap()
            .record_id;
        let firing = ana
            .save_in(Kind::Firing, shared, &json!({ "name": "Cone 10" }))
            .unwrap()
            .record_id;
        ana.add_attachment(Kind::Firing, firing, "image/jpeg", b"tile").unwrap();
        let mut host = ana.prepare_host(host_dir.path()).unwrap();

        let mut dirs = vec![vault_dir, host_dir];
        let mut computers = Vec::new();
        for (person, password) in [(ana_id, PASSWORD), (people[0], OWN), (people[1], OWN), (people[2], OWN)] {
            let dir = tempfile::tempdir().unwrap();
            let device = DeviceKey::generate();
            let certificate = ana
                .certify_device(device.id, "laptop", &device.public(), &[person])
                .unwrap();
            host.add_device(&certificate).unwrap();
            Vault::join(dir.path(), &host.join_package(device.id).unwrap(), &device).unwrap();
            let mut computer = Vault::unlock_as(dir.path(), Some(person), password).unwrap();
            sync(&mut computer, &mut host);
            computers.push(computer);
            dirs.push(dir);
        }
        Team {
            _dirs: dirs,
            host,
            shared,
            production,
            ana: ana_id,
            ben: people[0],
            cleo: people[1],
            dee: people[2],
            recipe,
            sheet,
            firing,
            computers,
        }
    }

    fn names(vault: &Vault, kind: Kind) -> Vec<String> {
        let mut names: Vec<String> = vault
            .heads(kind)
            .unwrap()
            .iter()
            .map(|r| r.content["name"].as_str().unwrap_or_default().to_owned())
            .collect();
        names.sort();
        names
    }

    fn count(vault: &Vault, sql: &str) -> i64 {
        vault.conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn each_computer_gets_what_its_people_read_and_never_more() {
        let t = team();
        let [ana, ben, cleo, dee] = &t.computers[..] else {
            unreachable!()
        };
        assert!(ana.is_replica());
        assert_eq!(names(ana, Kind::Recipe), ["Shino"]);
        assert_eq!(names(ben, Kind::Recipe), ["Shino"]);
        assert_eq!(ben.heads(Kind::Recipe).unwrap()[0].content["notes"], "secret");
        assert_eq!(names(ben, Kind::Firing), ["Cone 10"]);
        // Cleo's computer has batch sheets, and nothing else of the collection.
        assert_eq!(names(cleo, Kind::Batch), ["Shino sheet"]);
        assert_eq!(count(cleo, "SELECT count(*) FROM revisions WHERE kind != 'batch'"), 0);
        assert_eq!(count(cleo, "SELECT count(*) FROM attachments"), 0);
        // Dee's has recipes' summaries without their content, and firings with photos.
        assert_eq!(names(dee, Kind::Recipe), ["Shino"]);
        assert!(dee.heads(Kind::Recipe).unwrap()[0].content.get("notes").is_none());
        assert_eq!(
            count(
                dee,
                "SELECT count(*) FROM revisions WHERE kind = 'recipe' AND length(ciphertext) > 0"
            ),
            0
        );
        assert_eq!(
            count(
                dee,
                "SELECT count(*) FROM revisions WHERE kind IN ('batch', 'material')"
            ),
            0
        );
        assert_eq!(names(dee, Kind::Firing), ["Cone 10"]);
        let photo = dee
            .conn
            .query_row("SELECT id FROM attachments", [], |row| row.get::<_, String>(0))
            .unwrap();
        assert_eq!(&dee.attachment(parse_id(&photo).unwrap()).unwrap().1[..], b"tile");
        // Nobody but Ana's computer has Production, or the grants of others.
        for computer in [ben, cleo, dee] {
            assert!(computer.collections().iter().all(|c| c.id != t.production));
            assert_eq!(
                count(computer, "SELECT count(DISTINCT user_id) FROM grants"),
                1,
                "only their own person's grants"
            );
        }
        assert!(ana.collections().iter().any(|c| c.id == t.production));
        assert_eq!(names(cleo, Kind::Mix), Vec::<String>::new());
        let _ = (t.ana, t.cleo, t.dee, t.sheet, t.firing);
    }

    /// The newest revision of a recipe, on a computer.
    fn head(vault: &Vault, record: Uuid) -> crate::vault::Revision {
        vault
            .heads(Kind::Recipe)
            .unwrap()
            .into_iter()
            .find(|r| r.record_id == record)
            .unwrap()
    }

    #[test]
    fn a_save_on_one_computer_reaches_the_others_signed() {
        let mut t = team();
        let shino = head(&t.computers[1], t.recipe);
        let saved = t.computers[1]
            .save(
                Kind::Recipe,
                Some(shino.revision_id),
                &json!({ "name": "Shino 2", "lines": [], "notes": "" }),
            )
            .unwrap();
        let result = sync(&mut t.computers[1], &mut t.host);
        assert_eq!(result.accepted.len(), 1);
        assert!(result.refused.is_empty());
        // Nothing waits to be pushed now.
        assert!(t.computers[1].pending(usize::MAX).unwrap().is_empty());
        sync(&mut t.computers[0], &mut t.host);
        assert_eq!(names(&t.computers[0], Kind::Recipe), ["Shino 2"]);
        let history = t.computers[0].history(Kind::Recipe, t.recipe).unwrap();
        assert_eq!(history[0].revision_id, saved.revision_id);
        let signed = history[0].signed.as_ref().unwrap();
        assert_eq!((signed.by, signed.check), (t.ben, crate::vault::SignatureCheck::Good));
        // Dee gets its summary.
        sync(&mut t.computers[3], &mut t.host);
        assert_eq!(names(&t.computers[3], Kind::Recipe), ["Shino 2"]);
    }

    #[test]
    fn edits_made_apart_fork_and_one_is_chosen() {
        let mut t = team();
        let shino = head(&t.computers[0], t.recipe).revision_id;
        let anas = t.computers[0]
            .save(
                Kind::Recipe,
                Some(shino),
                &json!({ "name": "Ana's Shino", "lines": [], "notes": "" }),
            )
            .unwrap();
        t.computers[1]
            .save(
                Kind::Recipe,
                Some(shino),
                &json!({ "name": "Ben's Shino", "lines": [], "notes": "" }),
            )
            .unwrap();
        sync(&mut t.computers[0], &mut t.host);
        sync(&mut t.computers[1], &mut t.host);
        sync(&mut t.computers[0], &mut t.host);
        let forked = head(&t.computers[0], t.recipe);
        assert_eq!(forked.forks.len(), 1);
        assert_eq!(head(&t.computers[1], t.recipe).forks.len(), 1);
        let others: Vec<Uuid> = std::iter::once(forked.revision_id)
            .chain(forked.forks.iter().map(|f| f.revision_id))
            .filter(|id| *id != anas.revision_id)
            .collect();
        t.computers[0]
            .resolve_fork(Kind::Recipe, anas.revision_id, &others)
            .unwrap();
        sync(&mut t.computers[0], &mut t.host);
        sync(&mut t.computers[1], &mut t.host);
        let resolved = head(&t.computers[1], t.recipe);
        assert!(resolved.forks.is_empty());
        assert_eq!(resolved.content["name"], "Ana's Shino");
    }

    #[test]
    fn an_erasure_spreads_and_a_computer_that_was_away_cannot_bring_the_record_back() {
        let mut t = team();
        let shino = head(&t.computers[0], t.recipe).revision_id;
        // Ben, away, saves a revision; Ana deletes and erases the record meanwhile. The delete must
        // reach the host before the erasure.
        let deleted = t.computers[0].delete(Kind::Recipe, shino).unwrap();
        assert!(matches!(
            t.computers[0].erase(Kind::Recipe, deleted.record_id),
            Err(Error::NotSynced)
        ));
        sync(&mut t.computers[0], &mut t.host);
        t.computers[0].erase(Kind::Recipe, deleted.record_id).unwrap();
        let result = sync(&mut t.computers[0], &mut t.host);
        assert!(result.refused.is_empty(), "{:?}", result.refused);
        t.computers[1]
            .save(
                Kind::Recipe,
                Some(shino),
                &json!({ "name": "Ben's", "lines": [], "notes": "" }),
            )
            .unwrap();
        let unsent = t.computers[1].pending(usize::MAX).unwrap();
        // Ben's computer learns of the erasure as it pulls, and drops the record, his revision
        // with it; the host would have refused that revision anyway.
        let result = sync(&mut t.computers[1], &mut t.host);
        assert!(result.accepted.is_empty() && result.refused.is_empty());
        let bens = t.computers[1].device().unwrap();
        assert_eq!(t.host.accept(bens, unsent).unwrap().refused[0].1, Refusal::Erased);
        assert!(names(&t.computers[1], Kind::Recipe).is_empty());
        assert_eq!(
            count(&t.computers[1], "SELECT count(*) FROM revisions WHERE kind = 'recipe'"),
            0
        );
        assert!(t.computers[1].pending(usize::MAX).unwrap().is_empty());
    }

    #[test]
    fn an_erasure_of_a_record_changed_elsewhere_is_undone() {
        let mut t = team();
        let shino = head(&t.computers[0], t.recipe).revision_id;
        let deleted = t.computers[0].delete(Kind::Recipe, shino).unwrap();
        sync(&mut t.computers[0], &mut t.host);
        // Ben, who had not seen the delete, saves a revision, after Ana's sync and before she
        // erases what she has.
        t.computers[1]
            .save(
                Kind::Recipe,
                Some(shino),
                &json!({ "name": "Ben's", "lines": [], "notes": "" }),
            )
            .unwrap();
        sync(&mut t.computers[1], &mut t.host);
        t.computers[0].erase(Kind::Recipe, deleted.record_id).unwrap();
        let result = sync(&mut t.computers[0], &mut t.host);
        assert!(result.refused.iter().any(|(_, r)| *r == Refusal::ChangedElsewhere));
        // The next sync brings the record back, Ben's revision listed with her delete as a fork.
        sync(&mut t.computers[0], &mut t.host);
        let back = head(&t.computers[0], t.recipe);
        assert_eq!(back.content["name"], "Ben's");
        assert_eq!(back.forks.len(), 1);
        assert!(back.forks[0].deleted);
    }

    #[test]
    fn a_record_moved_where_someone_cannot_read_leaves_their_computer() {
        let mut t = team();
        t.computers[0]
            .move_records(&[(Kind::Recipe, t.recipe)], t.production)
            .unwrap();
        let result = sync(&mut t.computers[0], &mut t.host);
        assert!(result.refused.is_empty(), "{:?}", result.refused);
        sync(&mut t.computers[1], &mut t.host);
        assert!(names(&t.computers[1], Kind::Recipe).is_empty());
        assert_eq!(
            count(&t.computers[1], "SELECT count(*) FROM revisions WHERE kind = 'recipe'"),
            0
        );
        sync(&mut t.computers[3], &mut t.host);
        assert!(names(&t.computers[3], Kind::Recipe).is_empty());
        // Ana still has it, in Production, as the host does.
        sync(&mut t.computers[0], &mut t.host);
        assert_eq!(head(&t.computers[0], t.recipe).collection_id, t.production);
    }

    #[test]
    fn what_was_saved_away_under_an_old_key_is_sealed_again_before_it_is_pushed() {
        let mut t = team();
        let shino = head(&t.computers[1], t.recipe).revision_id;
        // Ben saves while away; meanwhile Ana takes Dee's role away, which gives Shared a new key.
        t.computers[1]
            .save(
                Kind::Recipe,
                Some(shino),
                &json!({ "name": "Ben's", "lines": [], "notes": "" }),
            )
            .unwrap();
        t.computers[0].set_role(t.dee, t.shared, None).unwrap();
        let result = sync(&mut t.computers[0], &mut t.host);
        assert!(result.refused.is_empty(), "{:?}", result.refused);
        let result = sync(&mut t.computers[1], &mut t.host);
        assert!(result.refused.is_empty(), "{:?}", result.refused);
        assert_eq!(
            count(
                &t.computers[1],
                "SELECT max(epoch) FROM revisions WHERE kind = 'recipe'"
            ),
            2
        );
        sync(&mut t.computers[0], &mut t.host);
        assert_eq!(names(&t.computers[0], Kind::Recipe), ["Ben's"]);
        // Dee's computer drops the collection.
        sync(&mut t.computers[3], &mut t.host);
        assert!(names(&t.computers[3], Kind::Recipe).is_empty());
        assert_eq!(count(&t.computers[3], "SELECT count(*) FROM revisions"), 0);
    }

    #[test]
    fn a_new_password_reaches_the_persons_other_computer() {
        let mut t = team();
        let (dir, device) = (tempfile::tempdir().unwrap(), DeviceKey::generate());
        let ana_vault = t._dirs[0].path().to_owned();
        let ana = Vault::unlock_as(&ana_vault, Some(t.ana), PASSWORD).unwrap();
        let certificate = ana
            .certify_device(device.id, "second laptop", &device.public(), &[t.ben])
            .unwrap();
        t.host.add_device(&certificate).unwrap();
        Vault::join(dir.path(), &t.host.join_package(device.id).unwrap(), &device).unwrap();

        t.computers[1].change_password(OWN, "bens newer password").unwrap();
        let result = sync(&mut t.computers[1], &mut t.host);
        assert!(result.accepted.iter().any(|(id, _)| *id == t.ben));
        // The second computer still opens with the old one until it syncs; then with the new.
        let mut second = Vault::unlock_as(dir.path(), Some(t.ben), OWN).unwrap();
        sync(&mut second, &mut t.host);
        drop(second);
        assert!(matches!(
            Vault::unlock_as(dir.path(), Some(t.ben), OWN),
            Err(Error::WrongPassword)
        ));
        let second = Vault::unlock_as(dir.path(), Some(t.ben), "bens newer password").unwrap();
        assert_eq!(names(&second, Kind::Recipe), ["Shino"]);
    }

    #[test]
    fn the_host_refuses_what_a_computer_may_not_push() {
        let mut t = team();
        let shino = head(&t.computers[1], t.recipe).revision_id;
        t.computers[1]
            .save(
                Kind::Recipe,
                Some(shino),
                &json!({ "name": "Ben's", "lines": [], "notes": "" }),
            )
            .unwrap();
        let pending = t.computers[1].pending(usize::MAX).unwrap();
        // Cleo's computer passing on Ben's revision: Ben does not sign in there.
        let cleos = t.computers[2].device().unwrap();
        let result = t.host.accept(cleos, pending.clone()).unwrap();
        assert_eq!(result.refused[0].1, Refusal::NotAllowed);
        // Changed on the way.
        let mut changed = pending.clone();
        if let Item::Revision(r) = &mut changed[0] {
            r.ciphertext[0] ^= 1;
        }
        let bens = t.computers[1].device().unwrap();
        assert_eq!(
            t.host.accept(bens, changed).unwrap().refused[0].1,
            Refusal::BadSignature
        );
        // A computer the host does not know.
        assert!(matches!(
            t.host.accept(Uuid::new_v4(), pending.clone()),
            Err(Error::Revoked)
        ));
        // As it was, it is taken, and taken again the same when pushed twice.
        let first = t.host.accept(bens, pending.clone()).unwrap();
        let again = t.host.accept(bens, pending).unwrap();
        assert_eq!(first.accepted, again.accepted);
    }

    #[test]
    fn events_made_together_are_taken_together_or_not_at_all() {
        let mut t = team();
        // Ana takes Dee's role away: the grant removed, a new key, and everyone's grants sealed
        // again. Ben's computer passes it on, which it may not, so none of it is taken.
        t.computers[0].set_role(t.dee, t.shared, None).unwrap();
        let pending = t.computers[0].pending(usize::MAX).unwrap();
        assert!(pending.len() > 3);
        let mut forged = pending.clone();
        let bens = t.computers[1].device().unwrap();
        let result = t.host.accept(bens, std::mem::take(&mut forged)).unwrap();
        assert!(result.accepted.is_empty());
        assert_eq!(result.refused.len(), pending.len());
        assert_eq!(result.refused[0].1, Refusal::NotAllowed);
        // From Ana's own computer, all of it is.
        let result = sync(&mut t.computers[0], &mut t.host);
        assert!(result.refused.is_empty(), "{:?}", result.refused);
        assert_eq!(result.accepted.len(), pending.len());
    }

    #[test]
    fn an_admin_changes_the_directory_from_their_computer() {
        let mut t = team();
        let glazes = t.computers[0].create_collection("Glazes").unwrap().id;
        t.computers[0].set_role(t.ben, glazes, Some(Role::Chemist)).unwrap();
        let result = sync(&mut t.computers[0], &mut t.host);
        assert!(result.refused.is_empty(), "{:?}", result.refused);
        sync(&mut t.computers[1], &mut t.host);
        let collections = t.computers[1].collections();
        let glazes = collections.iter().find(|c| c.id == glazes).unwrap();
        assert_eq!((glazes.name.as_str(), glazes.role), ("Glazes", Role::Chemist));
        // Cleo's computer knows nothing of it.
        sync(&mut t.computers[2], &mut t.host);
        assert!(t.computers[2].collections().iter().all(|c| c.name != "Glazes"));
        assert_eq!(
            count(
                &t.computers[2],
                "SELECT count(*) FROM collections WHERE name = 'Glazes'"
            ),
            0
        );
    }

    #[test]
    fn a_directory_change_waits_until_its_computer_holds_the_directory() {
        let mut t = team();
        t.host.guard_directory();
        t.computers[0].create_collection("Glazes").unwrap();
        assert!(t.computers[0].directory_waiting().unwrap());
        // Another computer holds it: the collection waits, not set aside.
        let device = t.computers[1].device().unwrap();
        t.host.set_directory_holder(Some(device));
        let result = sync(&mut t.computers[0], &mut t.host);
        assert!(
            result.refused.iter().all(|(_, why)| *why == Refusal::DirectoryNotHeld),
            "{:?}",
            result.refused
        );
        assert!(t.computers[0].directory_waiting().unwrap());
        let ana = t.computers[0].device().unwrap();
        t.host.set_directory_holder(Some(ana));
        let result = sync(&mut t.computers[0], &mut t.host);
        assert!(result.refused.is_empty(), "{:?}", result.refused);
        assert!(!t.computers[0].directory_waiting().unwrap());
        assert_eq!(t.computers[0].waiting().unwrap(), 0);
    }

    #[test]
    fn both_computers_list_the_version_the_host_took_last_first() {
        let mut t = team();
        let shino = head(&t.computers[0], t.recipe).revision_id;
        // Ben saves first by the clock, but reaches the host last.
        t.computers[1]
            .save(
                Kind::Recipe,
                Some(shino),
                &json!({ "name": "Ben's", "lines": [], "notes": "" }),
            )
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        t.computers[0]
            .save(
                Kind::Recipe,
                Some(shino),
                &json!({ "name": "Ana's", "lines": [], "notes": "" }),
            )
            .unwrap();
        sync(&mut t.computers[0], &mut t.host);
        sync(&mut t.computers[1], &mut t.host);
        sync(&mut t.computers[0], &mut t.host);
        assert_eq!(head(&t.computers[0], t.recipe).content["name"], "Ben's");
        assert_eq!(head(&t.computers[1], t.recipe).content["name"], "Ben's");
    }

    #[test]
    fn a_collection_pulled_again_keeps_what_was_saved_here_and_not_sent() {
        let mut t = team();
        let shino = head(&t.computers[1], t.recipe).revision_id;
        let saved = t.computers[1]
            .save(
                Kind::Recipe,
                Some(shino),
                &json!({ "name": "Offline", "lines": [], "notes": "" }),
            )
            .unwrap();
        // As when the host says what Ben holds there changed.
        let device = t.computers[1].device().unwrap();
        let (_, levels) = t.computers[1].sync_state().unwrap();
        let mut welcome = t.host.hello(device, &levels).unwrap();
        welcome.reset.push(Scope::Collection(t.shared));
        t.computers[1].apply_welcome(&welcome).unwrap();
        assert_eq!(t.computers[1].waiting().unwrap(), 1);
        let result = sync(&mut t.computers[1], &mut t.host);
        assert!(
            result.accepted.iter().any(|(id, _)| *id == saved.revision_id),
            "{result:?}"
        );
        assert_eq!(head(&t.computers[1], t.recipe).content["name"], "Offline");
    }

    #[test]
    fn with_photos_on_demand_a_computer_fetches_only_those_opened() {
        let mut t = team();
        t.computers[0].set_photos_on_demand(true).unwrap();
        let first = t.computers[1]
            .add_attachment(Kind::Firing, t.firing, "image/jpeg", b"first")
            .unwrap();
        let second = t.computers[1]
            .add_attachment(Kind::Firing, t.firing, "image/jpeg", b"second")
            .unwrap();
        sync(&mut t.computers[1], &mut t.host);
        sync(&mut t.computers[0], &mut t.host);
        assert!(matches!(t.computers[0].attachment(first.id), Err(Error::NotFetched)));
        assert!(matches!(t.computers[0].attachment(second.id), Err(Error::NotFetched)));
        assert!(t.computers[0].missing_bytes().unwrap().is_empty());

        t.computers[0].want_photo(first.id).unwrap();
        assert_eq!(t.computers[0].missing_bytes().unwrap(), vec![(first.id, 0)]);
        sync(&mut t.computers[0], &mut t.host);
        assert_eq!(&t.computers[0].attachment(first.id).unwrap().1[..], b"first");
        assert!(matches!(t.computers[0].attachment(second.id), Err(Error::NotFetched)));

        // All of them again, the one opened first.
        t.computers[0].set_photos_on_demand(false).unwrap();
        t.computers[0].want_photo(second.id).unwrap();
        assert_eq!(t.computers[0].missing_bytes().unwrap()[0].0, second.id);
    }

    #[test]
    fn a_photo_comes_in_pieces_after_its_firing() {
        let mut t = team();
        let big: Vec<u8> = (0..(2 * CHUNK_BYTES + 1000)).map(|i| (i % 251) as u8).collect();
        let photo = t.computers[1]
            .add_attachment(Kind::Firing, t.firing, "image/jpeg", &big)
            .unwrap();
        // Sent whole, as the core's helper does, and pulled by Ana's computer without its bytes.
        sync(&mut t.computers[1], &mut t.host);
        let device = t.computers[0].device().unwrap();
        let (_, levels) = t.computers[0].sync_state().unwrap();
        t.computers[0]
            .apply_welcome(&t.host.hello(device, &levels).unwrap())
            .unwrap();
        let (cursors, _) = t.computers[0].sync_state().unwrap();
        let batch = t.host.pull(device, &cursors, usize::MAX).unwrap();
        t.computers[0].apply_batch(&batch).unwrap();
        assert!(matches!(t.computers[0].attachment(photo.id), Err(Error::NotFetched)));
        let missing = t.computers[0].missing_bytes().unwrap();
        assert_eq!(missing, vec![(photo.id, 0)]);

        // A piece out of order is refused; then it comes, a piece at a time.
        let first = t.host.chunk(device, photo.id, 0).unwrap().unwrap();
        assert_eq!(first.bytes.len(), CHUNK_BYTES);
        let mut skipped = t.host.chunk(device, photo.id, CHUNK_BYTES as u64).unwrap().unwrap();
        assert!(t.computers[0].take_chunk(&skipped).is_err());
        assert!(!t.computers[0].take_chunk(&first).unwrap());
        assert_eq!(
            t.computers[0].missing_bytes().unwrap(),
            vec![(photo.id, CHUNK_BYTES as u64)]
        );
        assert!(!t.computers[0].take_chunk(&skipped).unwrap());
        skipped = t.host.chunk(device, photo.id, 2 * CHUNK_BYTES as u64).unwrap().unwrap();
        assert!(t.computers[0].take_chunk(&skipped).unwrap());
        assert_eq!(*t.computers[0].attachment(photo.id).unwrap().1, big);
        assert!(t.computers[0].missing_bytes().unwrap().is_empty());

        // Cleo's computer, which has no firings, is sent none of it.
        let cleo = t.computers[2].device().unwrap();
        assert!(t.host.chunk(cleo, photo.id, 0).unwrap().is_none());
    }

    #[test]
    fn an_attachment_sent_in_pieces_is_taken_once_they_have_all_come() {
        let mut t = team();
        let bytes: Vec<u8> = (0..(CHUNK_BYTES + 10)).map(|i| (i % 7) as u8).collect();
        let photo = t.computers[1]
            .add_attachment(Kind::Firing, t.firing, "image/png", &bytes)
            .unwrap();
        let device = t.computers[1].device().unwrap();
        let pending = t.computers[1].pending(usize::MAX).unwrap();
        let stripped: Vec<Item> = pending
            .iter()
            .cloned()
            .map(|item| match item {
                Item::Attachment(mut a) => {
                    a.ciphertext = Vec::new();
                    Item::Attachment(a)
                }
                other => other,
            })
            .collect();
        // Without its bytes it is not taken, but not refused for good either.
        let result = t.host.accept(device, stripped.clone()).unwrap();
        assert_eq!(result.refused, vec![(photo.id, Refusal::BytesMissing)]);
        t.computers[1].apply_push_result(&result, &stripped).unwrap();
        assert_eq!(t.computers[1].waiting().unwrap(), 1);

        let ciphertext = t.computers[1].attachment_bytes(photo.id).unwrap();
        let piece = |offset: usize| crate::sync::Chunk {
            id: photo.id,
            offset: offset as u64,
            total: ciphertext.len() as u64,
            bytes: ciphertext[offset..(offset + CHUNK_BYTES).min(ciphertext.len())].to_vec(),
        };
        assert_eq!(t.host.take_chunk(device, &piece(0)).unwrap(), CHUNK_BYTES as u64);
        // Sent again after a break, the host says how far it got.
        assert_eq!(t.host.take_chunk(device, &piece(0)).unwrap(), CHUNK_BYTES as u64);
        // Another computer cannot add to it.
        let ana = t.computers[0].device().unwrap();
        assert!(t.host.take_chunk(ana, &piece(CHUNK_BYTES)).is_err());
        assert_eq!(
            t.host.take_chunk(device, &piece(CHUNK_BYTES)).unwrap(),
            ciphertext.len() as u64
        );
        let result = t.host.accept(device, stripped.clone()).unwrap();
        assert_eq!(result.accepted.len(), 1);
        t.computers[1].apply_push_result(&result, &stripped).unwrap();
        assert_eq!(t.computers[1].waiting().unwrap(), 0);
        sync(&mut t.computers[0], &mut t.host);
        assert_eq!(*t.computers[0].attachment(photo.id).unwrap().1, bytes);
    }

    #[test]
    fn a_record_checked_out_elsewhere_cannot_be_saved_until_it_is_taken_over() {
        let mut t = team();
        let (ana, ben) = (t.computers[0].device().unwrap(), t.computers[1].device().unwrap());
        // Ben's computer cannot check out for Ana, nor Cleo's change a recipe.
        assert!(t.host.check_out(ben, t.ana, t.recipe, false).is_err());
        let cleo = t.computers[2].device().unwrap();
        assert!(t.host.check_out(cleo, t.cleo, t.recipe, false).is_err());

        let held = t.host.check_out(ana, t.ana, t.recipe, false).unwrap();
        assert_eq!(held.len(), 1);
        // Ben asks, and Ana still has it.
        let seen = t.host.check_out(ben, t.ben, t.recipe, false).unwrap();
        assert_eq!(seen[0].person, t.ana);
        t.computers[1].set_checkouts(seen);
        let shino = head(&t.computers[1], t.recipe).revision_id;
        let content = json!({ "name": "Ben's", "lines": [], "notes": "" });
        match t.computers[1].save(Kind::Recipe, Some(shino), &content) {
            Err(Error::CheckedOut(by)) => assert_eq!(by, "Ana"),
            other => panic!("saved anyway: {:?}", other.map(|r| r.revision_id)),
        }
        // Ana's own computer saves as before; Cleo's sees nothing of the recipe.
        t.computers[0].set_checkouts(t.host.checkouts(ana).unwrap());
        let anas = head(&t.computers[0], t.recipe).revision_id;
        t.computers[0].save(Kind::Recipe, Some(anas), &content).unwrap();
        assert!(t.host.checkouts(cleo).unwrap().is_empty());

        let taken = t.host.check_out(ben, t.ben, t.recipe, true).unwrap();
        assert_eq!(taken[0].person, t.ben);
        t.computers[1].set_checkouts(taken);
        t.computers[1].save(Kind::Recipe, Some(shino), &content).unwrap();
        assert!(t.host.release(ben, t.ben, t.recipe).unwrap().is_empty());
    }

    #[test]
    fn a_resolution_cannot_set_aside_another_records_revision() {
        let mut t = team();
        let recipe = head(&t.computers[1], t.recipe).revision_id;
        let other = t.computers[1]
            .save_in(
                Kind::Recipe,
                t.shared,
                &json!({ "name": "Other", "lines": [], "notes": "" }),
            )
            .unwrap();
        sync(&mut t.computers[1], &mut t.host);
        // As if a computer had saved a resolution that names a revision of another record.
        let resolution = t.computers[1]
            .add_revision(
                Kind::Recipe,
                Some(recipe),
                None,
                &json!({ "name": "Shino", "lines": [], "notes": "" }),
                false,
                &[other.revision_id],
            )
            .unwrap();
        let result = sync(&mut t.computers[1], &mut t.host);
        assert!(matches!(
            result.refused.iter().find(|(id, _)| *id == resolution.revision_id),
            Some((_, Refusal::Invalid { .. }))
        ));
    }

    /// Sets when a computer last synced, as if it were `days` ago.
    fn synced_days_ago(vault: &Vault, days: i64) {
        let at = now_ms() - days * 24 * 60 * 60 * 1000 - 1000;
        vault.set_meta("offline_last_synced", &at.to_string()).unwrap();
    }

    #[test]
    fn a_computer_away_too_long_takes_no_changes_until_an_extension_code() {
        let mut t = team();
        let policy = crate::vault::OfflinePolicy {
            nag_days: 3,
            limit_days: Some(7),
            by_role: Vec::new(),
        };
        // Only an admin sets the rule, and it reaches the other computers.
        assert!(t.computers[1].set_offline_policy(&policy).is_err());
        t.computers[0].set_offline_policy(&policy).unwrap();
        sync(&mut t.computers[0], &mut t.host);
        sync(&mut t.computers[1], &mut t.host);
        let ben = &mut t.computers[1];
        assert_eq!(ben.offline_policy(), policy);

        synced_days_ago(ben, 4);
        let status = ben.offline_status().unwrap();
        assert!(status.nag && !status.read_only);
        synced_days_ago(ben, 8);
        assert!(ben.offline_status().unwrap().read_only);
        let shino = head(ben, t.recipe).revision_id;
        let content = json!({ "name": "Away", "lines": [], "notes": "" });
        assert!(matches!(
            ben.save(Kind::Recipe, Some(shino), &content),
            Err(Error::OfflineTooLong)
        ));
        // Drafts are still kept.
        ben.save_draft(&json!({ "recipe": null })).unwrap();

        // A code from the host, for this computer, with the secret they share from pairing.
        let device = ben.device().unwrap();
        ben.set_meta(super::super::offline::SECRET, &hex::encode(b"shared at pairing"))
            .unwrap();
        t.host.set_offline_secret(device, b"shared at pairing").unwrap();
        let code = t.host.extension_code(device, 5).unwrap();
        let other = t.computers[2].device().unwrap();
        t.host.set_offline_secret(other, b"another secret").unwrap();
        let ben = &mut t.computers[1];
        assert!(matches!(
            ben.extend(&t.host.extension_code(other, 5).unwrap()),
            Err(Error::WrongExtensionCode)
        ));
        assert!(!ben.extend(&code).unwrap().read_only);
        ben.save(Kind::Recipe, Some(shino), &content).unwrap();

        // A clock set back more than a day counts as too long.
        synced_days_ago(ben, 0);
        ben.set_meta("offline_extended_until", "0").unwrap();
        let ahead = now_ms() + 3 * 24 * 60 * 60 * 1000;
        ben.set_meta("offline_latest_seen", &ahead.to_string()).unwrap();
        assert!(ben.offline_status().unwrap().clock_back);
        assert!(ben.offline_status().unwrap().read_only);
    }

    #[test]
    fn a_revoked_computer_is_told_so_and_a_lost_ones_people_get_new_keys() {
        let mut t = team();
        let ben = t.computers[1].device().unwrap();
        let cleo = t.computers[2].device().unwrap();
        let retired = t.host.revoke_device(cleo, false).unwrap();
        assert!(retired.revoked && !retired.lost);
        let (_, levels) = t.computers[2].sync_state().unwrap();
        let welcome = t.host.hello(cleo, &levels).unwrap();
        assert!(matches!(t.computers[2].apply_welcome(&welcome), Err(Error::Revoked)));

        assert!(t.host.revoke_device(ben, true).unwrap().lost);
        let epoch = t.computers[0]
            .collections()
            .iter()
            .find(|c| c.id == t.shared)
            .map(|_| t.computers[0].directory.collection(t.shared).unwrap().epoch)
            .unwrap();
        // Ana's computer has only her own key file entry, and resets Ben all the same.
        let passwords = t.computers[0].secure_after_lost(&[t.ben]).unwrap();
        assert_eq!(passwords.iter().map(|p| p.0).collect::<Vec<_>>(), vec![t.ben]);
        assert!(t.computers[0].directory.collection(t.shared).unwrap().epoch > epoch);
        // Production, which Ben could not read, keeps its key.
        assert_eq!(t.computers[0].directory.collection(t.production).unwrap().epoch, 1);
        // Ben cannot sign in on Ana's computer while his new entry waits there for the host.
        let dir = t.computers[0].dir.clone();
        assert!(Vault::people_in(&dir).unwrap().iter().all(|p| p.id != t.ben));
        assert!(Vault::unlock_as(&dir, Some(t.ben), &passwords[0].1).is_err());
        let result = sync(&mut t.computers[0], &mut t.host);
        assert!(result.refused.is_empty(), "{:?}", result.refused);
        // It reached the host, for his computers, and went from Ana's.
        assert!(t.computers[0].keyring.user(&t.ben).is_err());
        let entry: String = t
            .host
            .conn
            .query_row(
                "SELECT entry FROM key_entries WHERE person_id = ?1",
                params![t.ben.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert!(serde_json::from_str::<PersonEntry>(&entry).unwrap().must_set_password);
    }

    #[test]
    fn a_key_file_entry_from_the_host_must_be_signed_by_its_person_or_an_admin() {
        let t = team();
        let ben = &t.computers[1];
        let entry = items::entry_item(&t.host.conn, &ben.me().id.to_string()).unwrap();
        let take = |item: &EntryItem| {
            let trust = Trust::load(&ben.conn, ben.keyring.vault_id).unwrap();
            let mut keyring = ben.keyring.clone();
            take_entry(&ben.conn, &trust, &mut keyring, &ben.database_key().unwrap(), item)
        };
        take(&entry).unwrap();
        let mut forged = entry.clone();
        forged.signature[0] ^= 1;
        assert!(matches!(take(&forged), Err(Error::BadSignature)));
        // Cleo is neither Ben nor an admin.
        let by_cleo = EntryItem {
            signer: t.computers[2].me().id,
            ..entry
        };
        assert!(matches!(take(&by_cleo), Err(Error::BadSignature)));
    }

    #[test]
    fn a_backup_of_the_host_kept_elsewhere_goes_back_to_it() {
        let mut t = team();
        let kept = tempfile::tempdir().unwrap();
        let file = kept.path().join("host.gvhost");
        let made = t.host.export_backup(&file).unwrap();
        // Ana's computer, with the organization's key, knows it; Ben's does not.
        assert_eq!(t.computers[0].check_host_backup(&file).unwrap(), made);
        assert!(t.computers[1].check_host_backup(&file).is_err());

        let shino = head(&t.computers[1], t.recipe).revision_id;
        let saved = t.computers[1]
            .save(
                Kind::Recipe,
                Some(shino),
                &json!({ "name": "After", "lines": [], "notes": "" }),
            )
            .unwrap();
        sync(&mut t.computers[1], &mut t.host);

        // A file changed anywhere is refused.
        let mut changed = fs::read(&file).unwrap();
        let last = changed.len() - 1;
        changed[last] ^= 1;
        let bad = kept.path().join("changed.gvhost");
        fs::write(&bad, &changed).unwrap();
        assert!(matches!(
            HostStore::import_backup(t.host.dir(), t.host.vault_id(), &bad),
            Err(Error::NotABackup)
        ));
        assert!(t.host.backups().unwrap().is_empty());

        let name = HostStore::import_backup(t.host.dir(), t.host.vault_id(), &file).unwrap();
        assert_eq!(t.host.backups().unwrap()[0].name, name);
        // The daily backups do not prune one sent, though it sorts before them.
        let daily = t.host.dir().join(super::super::BACKUPS);
        for _ in 0..crate::vault::host::BACKUPS_KEPT + 2 {
            t.host.back_up(&daily).unwrap();
        }
        assert!(t.host.backups().unwrap().iter().any(|b| b.name == name));
        assert_eq!(t.host.backups().unwrap().len(), crate::vault::host::BACKUPS_KEPT + 1);
        t.host.ask_restore(&name).unwrap();
        assert!(t.host.ask_restore("../elsewhere").is_err());
        let dir = t.host.dir().to_owned();
        let asked = fs::read_to_string(dir.join(super::super::RESTORE_FILE)).unwrap();
        drop(t.host);
        HostStore::restore(&dir, Path::new(&asked)).unwrap();
        t.host = HostStore::open(&dir).unwrap();
        assert!(!items::exists(&t.host.conn, "revisions", &saved.revision_id).unwrap());
        let result = sync(&mut t.computers[1], &mut t.host);
        assert!(result.accepted.iter().any(|(id, _)| *id == saved.revision_id));
    }

    #[test]
    fn after_the_host_is_restored_each_computer_sends_again_what_its_people_saved() {
        let mut t = team();
        let backups = tempfile::tempdir().unwrap();
        let backup = t.host.back_up(backups.path()).unwrap();
        let shino = head(&t.computers[1], t.recipe).revision_id;
        let saved = t.computers[1]
            .save(
                Kind::Recipe,
                Some(shino),
                &json!({ "name": "After", "lines": [], "notes": "" }),
            )
            .unwrap();
        sync(&mut t.computers[1], &mut t.host);

        // The host goes back to before Ben's save, with a new generation.
        let dir = t.host.dir().to_owned();
        let old = t.host.generation().unwrap();
        drop(t.host);
        HostStore::restore(&dir, &backup).unwrap();
        t.host = HostStore::open(&dir).unwrap();
        assert_ne!(t.host.generation().unwrap(), old);
        assert!(!items::exists(&t.host.conn, "revisions", &saved.revision_id).unwrap());

        let result = sync(&mut t.computers[1], &mut t.host);
        assert!(result.accepted.iter().any(|(id, _)| *id == saved.revision_id));
        sync(&mut t.computers[0], &mut t.host);
        assert_eq!(head(&t.computers[0], t.recipe).content["name"], "After");

        // Backups past the fourteenth go.
        for _ in 0..20 {
            t.host.back_up(backups.path()).unwrap();
        }
        assert_eq!(
            fs::read_dir(backups.path()).unwrap().count(),
            crate::vault::host::BACKUPS_KEPT
        );
    }
}
