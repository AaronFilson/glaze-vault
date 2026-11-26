//! Saving, reading, deleting, erasing and fork-resolving revisions of records.

use super::{
    Body, Change, Fork, Held, Kind, MAX_BATCH, MAX_RECORD_BYTES, Revision, Vault, atomically, audit, events,
    log_change, now_ms, parse_id, revision_aad, summaries, supersedes_list,
};
use crate::crypto;
use crate::error::{Error, Result};
use crate::signing;
use crate::store;
use rusqlite::{OptionalExtension, params};
use uuid::Uuid;
use zeroize::Zeroizing;

impl Vault {
    /// Saves a record. With no parent it starts a new one; with one, it adds the next revision
    /// after it. Revisions are never changed, only added (docs/adr/0005-lan-host-and-replicas.md).
    /// Saving after a revision that deletes a record restores it.
    pub fn save(&mut self, kind: Kind, parent: Option<Uuid>, content: &serde_json::Value) -> Result<Revision> {
        self.add_revision(kind, parent, None, content, false, &[])
    }

    /// Saves a new record into a collection, rather than the vault's first.
    pub fn save_in(&mut self, kind: Kind, collection: Uuid, content: &serde_json::Value) -> Result<Revision> {
        self.add_revision(kind, None, Some(collection), content, false, &[])
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
            .map(|(parent, content)| self.add_revision(kind, *parent, collection, content, false, &[]))
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
        let revision = self.head(kind, newest)?;
        if revision.deleted {
            return Err(Error::NotFound);
        }
        self.add_revision(kind, Some(newest), None, &revision.content, true, &[])
    }

    /// Erases a deleted record: every revision of it is removed from the vault, and cannot be
    /// brought back. Backups made before still hold it. The vault remembers that it was erased,
    /// and by whom, though nothing of what it held (ADR 17). Returns how many revisions there were.
    pub fn erase(&mut self, kind: Kind, record_id: Uuid) -> Result<usize> {
        self.writable()?;
        let deleted = self.deleted(kind)?;
        let Some(record) = deleted.iter().find(|r| r.record_id == record_id) else {
            return Err(Error::NotDeleted);
        };
        let collection = record.collection_id;
        // On a replica the host checks that every newest revision deletes the record, so it must
        // have them (ADR 20).
        if self.is_replica() {
            let waiting: i64 = self.conn.query_row(
                "SELECT count(*) FROM changes WHERE host_seq IS NULL AND item_id IN (
                    SELECT id FROM revisions WHERE record_id = ?1 AND kind = ?2
                    UNION ALL SELECT id FROM attachments WHERE record_id = ?1 AND kind = ?2)",
                params![record_id.to_string(), kind.as_str()],
                |row| row.get(0),
            )?;
            if waiting > 0 {
                return Err(Error::NotSynced);
            }
        }
        let erased: i64 = self.conn.query_row(
            "SELECT count(*) FROM revisions WHERE record_id = ?1 AND kind = ?2",
            params![record_id.to_string(), kind.as_str()],
            |row| row.get(0),
        )?;
        // The event removes the record's revisions and attachments, takes them out of the change
        // log, and leaves its tombstone.
        events::record(
            &self.conn,
            &self.signer,
            Body::Erased {
                record: record_id,
                kind,
                collection,
            },
        )?;
        // secure_delete has zeroed the freed pages; this empties the write-ahead log of them too.
        self.conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(erased as usize)
    }

    /// Ends a fork (ADR 17): saves a revision after `keep`, one of the record's newest, with its
    /// content, that supersedes `others`, the rest of them.
    pub fn resolve_fork(&mut self, kind: Kind, keep: Uuid, others: &[Uuid]) -> Result<Revision> {
        let kept = self.head(kind, keep)?;
        let listed = self
            .newest(kind)?
            .into_iter()
            .find(|r| r.record_id == kept.record_id)
            .ok_or(Error::NotFound)?;
        let mut heads: Vec<Uuid> = listed.forks.iter().map(|f| f.revision_id).collect();
        heads.push(listed.revision_id);
        heads.retain(|id| *id != keep);
        let (mut heads, mut others) = (heads, others.to_vec());
        heads.sort();
        others.sort();
        others.dedup();
        if heads.is_empty() || heads != others {
            return Err(Error::ForkChanged);
        }
        self.add_revision(kind, Some(keep), None, &kept.content, kept.deleted, &others)
    }

    /// One of a record's newest revisions, by its id.
    pub(super) fn head(&self, kind: Kind, id: Uuid) -> Result<Revision> {
        if self.superseded(kind)?.contains(&id) {
            return Err(Error::NotFound);
        }
        self.read_revisions(
            "WHERE r.kind = ?1 AND r.id = ?2 AND NOT EXISTS (SELECT 1 FROM revisions c WHERE c.parent_id = r.id)",
            params![kind.as_str(), id.to_string()],
            kind,
        )?
        .pop()
        .ok_or(Error::NotFound)
    }

    /// The revisions of a kind that a fork's resolution set aside.
    pub(super) fn superseded(&self, kind: Kind) -> Result<Vec<Uuid>> {
        let mut statement = self
            .conn
            .prepare("SELECT supersedes FROM revisions WHERE kind = ?1 AND supersedes IS NOT NULL")?;
        let lists = statement
            .query_map(params![kind.as_str()], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        lists
            .iter()
            .flat_map(|list| list.split(','))
            .filter(|id| !id.is_empty())
            .map(parse_id)
            .collect()
    }

    /// Adds a revision after `parent`, in its collection, or starts a record in `collection` (or
    /// the vault's first), if this person may change records there.
    pub(super) fn add_revision(
        &mut self,
        kind: Kind,
        parent: Option<Uuid>,
        collection: Option<Uuid>,
        content: &serde_json::Value,
        deleted: bool,
        supersedes: &[Uuid],
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
        self.writable()?;
        if let Some(by) = self.checked_out_by(record_id) {
            return Err(Error::CheckedOut(by));
        }
        let collection = self.editable(&collection_id, kind)?;
        let epoch = collection.epoch;
        let collection_key = self.key_for(collection, kind, epoch)?.ok_or(Error::NotAllowed)?;
        // A recipe also keeps its summary, for roles that read without chemistry.
        let summary_key = match kind {
            Kind::Recipe => Some(self.summary_key_for(collection, epoch)?.ok_or(Error::NotAllowed)?),
            _ => None,
        };
        let supersedes = (!supersedes.is_empty()).then(|| supersedes_list(supersedes));
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
            supersedes.as_deref(),
        );
        let sealed = crypto::encrypt(&collection_key, &plaintext, &aad);
        let summary = summary_key
            .map(|key| summaries::seal(&key, content, &aad))
            .transpose()?;
        let (summary_nonce, summary) = summary.map(|s| (s.nonce, s.ciphertext)).unzip();
        let content_hash = store::content_hash(&sealed.nonce, &sealed.ciphertext);
        let signed = self.sign_as_author(|role, signer| {
            let facts = signing::RevisionFacts {
                vault: &self.keyring.vault_id,
                id: &revision_id,
                record: &record_id,
                kind: kind.as_str(),
                collection: &collection_id,
                epoch,
                number,
                parent: parent.as_ref(),
                deleted,
                supersedes: supersedes.as_deref(),
                author: &self.user_id,
                at: saved_at,
                content_hash: &content_hash,
                summary: summary_nonce.as_deref().zip(summary.as_deref()),
            };
            signing::revision_payload(&facts, role, signer)
        });
        let author = self.user_id.to_string();
        let action = if deleted { "deleted" } else { "saved" };
        let entry = audit::Entry::of(action, kind, record_id, collection_id);
        let entry = if supersedes.is_some() {
            entry.detail("resolved a fork")
        } else {
            entry
        };
        atomically(&self.conn, |conn| {
            conn.execute(
            "INSERT INTO revisions (id, record_id, kind, parent_id, number, collection_id, author_id, created_at, nonce, ciphertext, deleted, summary_nonce, summary, epoch, supersedes, signature, signer_id, signed_as, content_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            params![
                revision_id.to_string(),
                record_id.to_string(),
                kind.as_str(),
                parent.map(|id| id.to_string()),
                number,
                collection_id.to_string(),
                author,
                saved_at,
                sealed.nonce,
                sealed.ciphertext,
                deleted,
                summary_nonce,
                summary,
                epoch,
                supersedes,
                signed.signature,
                signed.signer.to_string(),
                signed.role.code(),
                content_hash,
            ],
            )?;
            log_change(conn, Change::Revision, &revision_id, &collection_id, kind)?;
            audit::note(conn, &self.signer, entry)
        })?;
        // Saved on one branch of a fork, the record is still forked.
        let forks = match parent {
            Some(_) => self.forks_of(kind, &record_id, &revision_id)?,
            None => Vec::new(),
        };
        Ok(Revision {
            record_id,
            revision_id,
            number,
            saved_at,
            content: content.clone(),
            deleted,
            collection_id,
            forks,
            author: self.user_id,
            signed: None,
        })
    }

    /// A record's newest revisions other than `except`, from what is known of them without
    /// opening them.
    pub(super) fn forks_of(&self, kind: Kind, record_id: &Uuid, except: &Uuid) -> Result<Vec<Fork>> {
        let superseded = self.superseded(kind)?;
        let mut statement = self.conn.prepare(
            "SELECT r.id, r.created_at, r.deleted FROM revisions r
             WHERE r.kind = ?1 AND r.record_id = ?2 AND r.id != ?3
             AND NOT EXISTS (SELECT 1 FROM revisions c WHERE c.parent_id = r.id)
             ORDER BY r.created_at DESC, r.rowid DESC",
        )?;
        let rows = statement
            .query_map(
                params![kind.as_str(), record_id.to_string(), except.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, bool>(2)?)),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut forks = Vec::new();
        for (id, saved_at, deleted) in rows {
            let revision_id = parse_id(&id)?;
            if !superseded.contains(&revision_id) {
                forks.push(Fork {
                    revision_id,
                    saved_at,
                    deleted,
                });
            }
        }
        Ok(forks)
    }

    /// The newest revision of every record of a kind, newest first, leaving out deleted records.
    pub fn heads(&self, kind: Kind) -> Result<Vec<Revision>> {
        Ok(self.newest(kind)?.into_iter().filter(|r| !r.deleted).collect())
    }

    /// The deleted records of a kind, newest first: each one's revision that deleted it.
    pub fn deleted(&self, kind: Kind) -> Result<Vec<Revision>> {
        Ok(self.newest(kind)?.into_iter().filter(|r| r.deleted).collect())
    }

    /// The newest revision of every record of a kind, deleted or not, newest first, with the
    /// record's other newest revisions if it forked.
    pub(super) fn newest(&self, kind: Kind) -> Result<Vec<Revision>> {
        let superseded = self.superseded(kind)?;
        let revisions = self.read_revisions(
            "WHERE r.kind = ?1 AND NOT EXISTS (SELECT 1 FROM revisions c WHERE c.parent_id = r.id)
             ORDER BY r.created_at DESC, r.rowid DESC",
            params![kind.as_str()],
            kind,
        )?;
        let order = self.change_order(kind)?;
        let place = |id: &Uuid| order.get(id).copied().unwrap_or((true, i64::MAX));
        let mut revisions = revisions;
        revisions.sort_by_key(|r| std::cmp::Reverse(place(&r.revision_id)));
        let mut heads: Vec<Revision> = Vec::new();
        for revision in revisions {
            if superseded.contains(&revision.revision_id) {
                continue;
            }
            let Some(head) = heads.iter_mut().find(|head| head.record_id == revision.record_id) else {
                heads.push(revision);
                continue;
            };
            if head.deleted && !revision.deleted {
                let mut shown = std::mem::replace(head, revision);
                head.forks = std::mem::take(&mut shown.forks);
                head.forks.push(Fork::of(&shown));
            } else {
                head.forks.push(Fork::of(&revision));
            }
        }
        for head in &mut heads {
            head.forks
                .sort_by_key(|fork| std::cmp::Reverse(place(&fork.revision_id)));
        }
        heads.sort_by_key(|head| std::cmp::Reverse(head.saved_at));
        Ok(heads)
    }

    /// Where each revision of a kind came in the change log: the host's number once it has one,
    /// else this store's own, after every number of the host's.
    pub(super) fn change_order(&self, kind: Kind) -> Result<std::collections::HashMap<Uuid, (bool, i64)>> {
        let rows = self
            .conn
            .prepare("SELECT item_id, host_seq, seq FROM changes WHERE item = 'revision' AND kind = ?1")?
            .query_map(params![kind.as_str()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let replica = self.is_replica();
        rows.into_iter()
            .map(|(id, host_seq, seq)| {
                let place = match host_seq {
                    Some(host_seq) if replica => (false, host_seq),
                    _ => (true, seq),
                };
                Ok((parse_id(&id)?, place))
            })
            .collect()
    }

    /// Every saved revision of one record, newest first. Revisions that deleted it are left out.
    pub fn history(&self, kind: Kind, record_id: Uuid) -> Result<Vec<Revision>> {
        let revisions = self.read_revisions(
            "WHERE r.kind = ?1 AND r.record_id = ?2 AND r.deleted = 0 ORDER BY r.number DESC, r.created_at DESC, r.rowid DESC",
            params![kind.as_str(), record_id.to_string()],
            kind,
        )?;
        if revisions.is_empty() {
            return Err(Error::NotFound);
        }
        // Who signed each, checked against the certificates the vault holds.
        let trust = self.trust()?;
        let mut revisions = revisions;
        for revision in &mut revisions {
            revision.signed = self.revision_signed(&trust, &revision.revision_id)?;
        }
        Ok(revisions)
    }

    /// Reads and decrypts the revisions that `where_clause` picks, in the collections this person
    /// can open. The clause is fixed SQL, never built from input: values go in `values`.
    pub(super) fn read_revisions(
        &self,
        where_clause: &'static str,
        values: impl rusqlite::Params,
        kind: Kind,
    ) -> Result<Vec<Revision>> {
        type Row = (
            String,
            String,
            Option<String>,
            i64,
            String,
            i64,
            Vec<u8>,
            Vec<u8>,
            bool,
            Option<Vec<u8>>,
            Option<Vec<u8>>,
            i64,
            Option<String>,
            String,
        );
        let mut statement = self.conn.prepare(&format!(
            "SELECT r.id, r.record_id, r.parent_id, r.number, r.collection_id, r.created_at, r.nonce, r.ciphertext,
                    r.deleted, r.summary_nonce, r.summary, r.epoch, r.supersedes, r.author_id
             FROM revisions r {where_clause}"
        ))?;
        let rows = statement.query_map(values, |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
                row.get(13)?,
            ))
        })?;
        let mut revisions = Vec::new();
        for row in rows {
            let (
                id,
                record_id,
                parent_id,
                number,
                collection_id,
                saved_at,
                nonce,
                ciphertext,
                deleted,
                summary_nonce,
                summary,
                epoch,
                supersedes,
                author,
            ): Row = row?;
            let (revision_id, record_id, collection_id) =
                (parse_id(&id)?, parse_id(&record_id)?, parse_id(&collection_id)?);
            let parent = parent_id.as_deref().map(parse_id).transpose()?;
            let Some(collection) = self.collections.iter().find(|c| c.id == collection_id) else {
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
                supersedes.as_deref(),
            );
            let content = if kind == Kind::Recipe && collection.held == Held::Summary {
                let (Some(nonce), Some(ciphertext)) = (summary_nonce, summary) else {
                    continue;
                };
                summaries::open(collection.key_at(epoch)?, &crypto::Sealed { nonce, ciphertext }, &aad)
                    .ok_or_else(|| Error::Corrupt(format!("the summary of revision {revision_id} does not decrypt")))?
            } else {
                let Some(key) = self.key_for(collection, kind, epoch)? else {
                    continue;
                };
                let plaintext = crypto::decrypt(&key, &crypto::Sealed { nonce, ciphertext }, &aad)
                    .ok_or_else(|| Error::Corrupt(format!("revision {revision_id} does not decrypt")))?;
                serde_json::from_slice(&plaintext)?
            };
            revisions.push(Revision {
                record_id,
                revision_id,
                number,
                saved_at,
                content,
                deleted,
                collection_id,
                forks: Vec::new(),
                author: parse_id(&author)?,
                signed: None,
            });
        }
        Ok(revisions)
    }
}
