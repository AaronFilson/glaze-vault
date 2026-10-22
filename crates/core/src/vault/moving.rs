//! Moving records to another collection (docs/adr/0012-teams-on-one-computer.md): every revision
//! and attachment of each is encrypted again under the new collection's key, bound to it, so the
//! people who could open the old one and not the new one cannot open them any more. A recipe
//! moves with its firings and batch sheets, which the page names, since the core does not look
//! inside what it keeps. Each record's move is an event (ADR 18), checked as the LAN host will.

use super::events::{self, Body};
use super::{Change, Kind, MAX_BATCH, Vault, attachments, log_change, parse_id, revision_aad, summaries};
use crate::crypto;
use crate::error::{Error, Result};
use crate::signing::As;
use crate::store;
use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

impl Vault {
    /// Moves records into `to`, all or none, if this person may change records both where each is
    /// and in `to`. A record already there stays as it is.
    pub fn move_records(&mut self, records: &[(Kind, Uuid)], to: Uuid) -> Result<()> {
        if records.len() > MAX_BATCH {
            return Err(Error::TooLarge);
        }
        let tx = self.conn.unchecked_transaction()?;
        for &(kind, record_id) in records {
            let from: String = tx
                .query_row(
                    "SELECT collection_id FROM revisions WHERE record_id = ?1 AND kind = ?2 LIMIT 1",
                    params![record_id.to_string(), kind.as_str()],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or(Error::NotFound)?;
            let from = parse_id(&from)?;
            if from == to {
                continue;
            }
            let (here, there) = (self.editable(&from, kind)?, self.editable(&to, kind)?);
            // Everything goes under the new collection's current key, whatever epoch it was at.
            let epoch = there.epoch;
            let new = self.key_for(there, kind, epoch)?.ok_or(Error::NotAllowed)?;
            // A recipe's summary moves with it (summaries.rs).
            let new_summary = match kind {
                Kind::Recipe => Some(self.summary_key_for(there, epoch)?.ok_or(Error::NotAllowed)?),
                _ => None,
            };

            type Row = (
                String,
                i64,
                Option<String>,
                bool,
                Vec<u8>,
                Vec<u8>,
                Option<Vec<u8>>,
                Option<Vec<u8>>,
                i64,
                Option<String>,
            );
            let mut statement = tx.prepare(
                "SELECT id, number, parent_id, deleted, nonce, ciphertext, summary_nonce, summary, epoch, supersedes
                 FROM revisions WHERE record_id = ?1 AND kind = ?2 ORDER BY rowid",
            )?;
            let revisions = statement
                .query_map(params![record_id.to_string(), kind.as_str()], |row| {
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
                    ))
                })?
                .collect::<rusqlite::Result<Vec<Row>>>()?;
            drop(statement);
            let mut moved_revisions = Vec::new();
            for (id, number, parent, deleted, nonce, ciphertext, summary_nonce, summary, at, supersedes) in revisions {
                let revision_id = parse_id(&id)?;
                let parent = parent.as_deref().map(parse_id).transpose()?;
                let aad = |collection: &Uuid| {
                    revision_aad(
                        &revision_id,
                        &record_id,
                        kind.as_str(),
                        collection,
                        number,
                        parent.as_ref(),
                        deleted,
                        supersedes.as_deref(),
                    )
                };
                let old = self.key_for(here, kind, at)?.ok_or(Error::NotAllowed)?;
                let plaintext = crypto::decrypt(&old, &crypto::Sealed { nonce, ciphertext }, &aad(&from))
                    .ok_or_else(|| Error::Corrupt(format!("revision {id} does not decrypt")))?;
                let sealed = crypto::encrypt(&new, &plaintext, &aad(&to));
                tx.execute(
                    "UPDATE revisions SET collection_id = ?1, nonce = ?2, ciphertext = ?3, epoch = ?4, content_hash = ?5
                     WHERE id = ?6",
                    params![
                        to.to_string(),
                        &sealed.nonce,
                        &sealed.ciphertext,
                        epoch,
                        store::content_hash(&sealed.nonce, &sealed.ciphertext),
                        id
                    ],
                )?;
                if let (Some(new_summary), Some(nonce), Some(ciphertext)) = (&new_summary, summary_nonce, summary) {
                    let old_summary = self.summary_key_for(here, at)?.ok_or(Error::NotAllowed)?;
                    let sealed = summaries::reseal(
                        &old_summary,
                        new_summary,
                        &crypto::Sealed { nonce, ciphertext },
                        &aad(&from),
                        &aad(&to),
                    )?;
                    tx.execute(
                        "UPDATE revisions SET summary_nonce = ?1, summary = ?2 WHERE id = ?3",
                        params![sealed.nonce, sealed.ciphertext, id],
                    )?;
                }
                self.sign_stored_revision(&tx, &revision_id, As::Mover)?;
                moved_revisions.push(revision_id);
            }

            // Attachments, one at a time: there may be many photos.
            let mut statement = tx.prepare(
                "SELECT id, media_type, epoch FROM attachments WHERE record_id = ?1 AND kind = ?2 ORDER BY rowid",
            )?;
            let found = statement
                .query_map(params![record_id.to_string(), kind.as_str()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            let mut moved_attachments = Vec::new();
            for (id, media_type, at) in found {
                let attachment_id = parse_id(&id)?;
                let aad = |collection: &Uuid| {
                    attachments::aad(&attachment_id, &record_id, kind.as_str(), collection, &media_type)
                };
                let (nonce, ciphertext): (Vec<u8>, Vec<u8>) = tx.query_row(
                    "SELECT nonce, ciphertext FROM attachments WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let old = self.key_for(here, kind, at)?.ok_or(Error::NotAllowed)?;
                let plaintext = crypto::decrypt(&old, &crypto::Sealed { nonce, ciphertext }, &aad(&from))
                    .ok_or_else(|| Error::Corrupt(format!("attachment {id} does not decrypt")))?;
                let sealed = crypto::encrypt(&new, &plaintext, &aad(&to));
                tx.execute(
                    "UPDATE attachments SET collection_id = ?1, nonce = ?2, ciphertext = ?3, epoch = ?4, sha256 = ?5
                     WHERE id = ?6",
                    params![
                        to.to_string(),
                        &sealed.nonce,
                        &sealed.ciphertext,
                        epoch,
                        store::attachment_hash(&sealed.nonce, &sealed.ciphertext),
                        id
                    ],
                )?;
                self.sign_stored_attachment(&tx, &attachment_id, As::Mover)?;
                moved_attachments.push(attachment_id);
            }

            // The move is an event (ADR 18): the record leaves the change log where it was, and its
            // rows, encrypted again for where it went, follow the event.
            events::record(
                &tx,
                &self.signer,
                Body::Moved {
                    record: record_id,
                    kind,
                    from,
                    to,
                },
            )?;
            for revision_id in moved_revisions {
                log_change(&tx, Change::Revision, &revision_id, &to, kind)?;
            }
            for attachment_id in moved_attachments {
                log_change(&tx, Change::Attachment, &attachment_id, &to, kind)?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::Role;
    use crate::vault::Capabilities;
    use serde_json::json;

    const PASSWORD: &str = "cone six oxidation";
    const ONE_TIME: &str = "pass this on";

    #[test]
    fn a_recipe_moves_with_its_firing_and_photo_to_another_collection() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ana, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        ana.grow_into_team("Ana").unwrap();
        let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        let production = ana.create_collection("Production").unwrap().id;
        let first = ana.save_in(Kind::Recipe, shared, &json!({ "name": "Shino" })).unwrap();
        let second = ana
            .save(Kind::Recipe, Some(first.revision_id), &json!({ "name": "Shino 2" }))
            .unwrap();
        let firing = ana
            .save_in(Kind::Firing, shared, &json!({ "recipe": first.record_id }))
            .unwrap();
        let photo = ana
            .add_attachment(Kind::Firing, firing.record_id, "image/jpeg", b"tile")
            .unwrap();
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();

        ana.move_records(
            &[(Kind::Recipe, first.record_id), (Kind::Firing, firing.record_id)],
            production,
        )
        .unwrap();
        let history = ana.history(Kind::Recipe, first.record_id).unwrap();
        assert_eq!(history.len(), 2);
        assert!(history.iter().all(|r| r.collection_id == production));
        assert_eq!(history[0].revision_id, second.revision_id);
        assert_eq!(ana.heads(Kind::Firing).unwrap()[0].collection_id, production);
        assert_eq!(&ana.attachment(photo.id).unwrap().1[..], b"tile");
        // The next revision goes where the record is now.
        let third = ana
            .save(Kind::Recipe, Some(second.revision_id), &json!({ "name": "Shino 3" }))
            .unwrap();
        assert_eq!(third.collection_id, production);

        // Ben could read Shared, not Production: the recipe and its photo are gone for him.
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        as_ben.set_own_password("bens own password").unwrap();
        assert!(as_ben.heads(Kind::Recipe).unwrap().is_empty());
        assert!(matches!(as_ben.attachment(photo.id), Err(Error::NotFound)));
    }

    #[test]
    fn only_someone_who_may_change_both_collections_moves_a_record() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ana, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        ana.grow_into_team("Ana").unwrap();
        let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        let production = ana.create_collection("Production").unwrap().id;
        let recipe = ana
            .save_in(Kind::Recipe, production, &json!({ "name": "Tenmoku" }))
            .unwrap();
        let ben = ana
            .add_person(
                "Ben",
                ONE_TIME,
                &[(shared, Role::Formulator), (production, Role::Chemist)],
            )
            .unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        as_ben.set_own_password("bens own password").unwrap();
        let own = as_ben
            .collections()
            .iter()
            .find(|c| c.owner == Some(ben.id))
            .unwrap()
            .id;
        assert!(matches!(
            as_ben.move_records(&[(Kind::Recipe, recipe.record_id)], shared),
            Err(Error::NotAllowed)
        ));
        let mine = as_ben.save_in(Kind::Recipe, own, &json!({ "name": "Ben's" })).unwrap();
        assert!(matches!(
            as_ben.move_records(&[(Kind::Recipe, mine.record_id)], production),
            Err(Error::NotAllowed)
        ));
        // All or none: one record refused leaves the others where they were.
        assert!(
            as_ben
                .move_records(
                    &[(Kind::Recipe, mine.record_id), (Kind::Recipe, recipe.record_id)],
                    shared
                )
                .is_err()
        );
        assert_eq!(
            as_ben.history(Kind::Recipe, mine.record_id).unwrap()[0].collection_id,
            own
        );
        as_ben.move_records(&[(Kind::Recipe, mine.record_id)], shared).unwrap();
        assert_eq!(
            as_ben.history(Kind::Recipe, mine.record_id).unwrap()[0].collection_id,
            shared
        );
        assert!(matches!(
            as_ben.move_records(&[(Kind::Recipe, Uuid::new_v4())], shared),
            Err(Error::NotFound)
        ));
    }

    #[test]
    fn a_material_moves_for_someone_who_may_change_materials_in_both() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ana, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        ana.grow_into_team("Ana").unwrap();
        let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        let production = ana.create_collection("Production").unwrap().id;
        let material = ana
            .save_in(Kind::Material, shared, &json!({ "name": "Grolleg" }))
            .unwrap();
        let recipes_only = ana
            .create_role("Recipes only", &[Kind::Recipe], Capabilities::BUILT_IN)
            .unwrap();
        let ben = ana
            .add_person(
                "Ben",
                ONE_TIME,
                &[
                    (shared, Role::Custom(recipes_only.id)),
                    (production, Role::Custom(recipes_only.id)),
                ],
            )
            .unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        as_ben.set_own_password("bens own password").unwrap();
        assert!(matches!(
            as_ben.move_records(&[(Kind::Material, material.record_id)], production),
            Err(Error::NotAllowed)
        ));
        drop(as_ben);

        ana.move_records(&[(Kind::Material, material.record_id)], production)
            .unwrap();
        let head = &ana.heads(Kind::Material).unwrap()[0];
        assert_eq!(head.collection_id, production);
        assert_eq!(head.content["name"], "Grolleg");
    }

    #[test]
    fn a_record_saved_under_two_key_epochs_moves_under_the_new_collections_key() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ana, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        ana.grow_into_team("Ana").unwrap();
        let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        let production = ana.create_collection("Production").unwrap().id;
        let first = ana.save_in(Kind::Recipe, shared, &json!({ "name": "Shino" })).unwrap();
        let firing = ana
            .save_in(Kind::Firing, shared, &json!({ "recipe": first.record_id }))
            .unwrap();
        let photo = ana
            .add_attachment(Kind::Firing, firing.record_id, "image/jpeg", b"tile")
            .unwrap();
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
        ana.set_role(ben.id, shared, None).unwrap();
        let second = ana
            .save(Kind::Recipe, Some(first.revision_id), &json!({ "name": "Shino 2" }))
            .unwrap();

        ana.move_records(
            &[(Kind::Recipe, first.record_id), (Kind::Firing, firing.record_id)],
            production,
        )
        .unwrap();
        let epochs: Vec<i64> = ana
            .conn
            .prepare("SELECT epoch FROM revisions WHERE collection_id = ?1 UNION ALL SELECT epoch FROM attachments WHERE collection_id = ?1")
            .unwrap()
            .query_map(params![production.to_string()], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(epochs, [1, 1, 1, 1]);
        let history = ana.history(Kind::Recipe, first.record_id).unwrap();
        assert_eq!(history[0].revision_id, second.revision_id);
        assert_eq!(history.len(), 2);
        assert_eq!(&ana.attachment(photo.id).unwrap().1[..], b"tile");
        // The moved rows go to the end of the change log, under their new collection, each
        // record's after the event that moved it, which is in both collections' parts of the log.
        let moved: Vec<(String, String)> = ana
            .conn
            .prepare("SELECT item, collection_id FROM changes ORDER BY seq DESC LIMIT 8")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let (to, from) = (production.to_string(), shared.to_string());
        let entry = |item: &str, collection: &str| (item.to_owned(), collection.to_owned());
        assert_eq!(
            moved,
            [
                entry("attachment", &to),
                entry("revision", &to),
                entry("event", &to),
                entry("event", &from),
                entry("revision", &to),
                entry("revision", &to),
                entry("event", &to),
                entry("event", &from),
            ]
        );
        let kept = events::kept(&ana.conn);
        let moves: Vec<&Body> = kept
            .iter()
            .filter(|(name, _, _)| name == "moved")
            .map(|(_, _, body)| body)
            .collect();
        assert!(matches!(
            moves[..],
            [Body::Moved { record: r, from: f, to: t, .. }, Body::Moved { record: g, .. }]
                if *r == first.record_id && *f == shared && *t == production && *g == firing.record_id
        ));
    }
}
