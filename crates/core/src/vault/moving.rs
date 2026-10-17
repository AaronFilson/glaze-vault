//! Moving records to another collection (docs/adr/0012-teams-on-one-computer.md): every revision
//! and attachment of each is encrypted again under the new collection's key, bound to it, so the
//! people who could open the old one and not the new one cannot open them any more. A recipe
//! moves with its firings and batch sheets, which the page names, since the core does not look
//! inside what it keeps.

use super::{Kind, MAX_BATCH, Vault, attachments, parse_id, revision_aad};
use crate::crypto;
use crate::error::{Error, Result};
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
            let old = self.editable(&from, kind)?.key_for(kind).ok_or(Error::NotAllowed)?;
            let new = self.editable(&to, kind)?.key_for(kind).ok_or(Error::NotAllowed)?;

            let mut statement = tx.prepare(
                "SELECT id, number, parent_id, deleted, nonce, ciphertext FROM revisions
                 WHERE record_id = ?1 AND kind = ?2",
            )?;
            let revisions = statement
                .query_map(params![record_id.to_string(), kind.as_str()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, bool>(3)?,
                        row.get::<_, Vec<u8>>(4)?,
                        row.get::<_, Vec<u8>>(5)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            for (id, number, parent, deleted, nonce, ciphertext) in revisions {
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
                    )
                };
                let plaintext = crypto::decrypt(&old, &crypto::Sealed { nonce, ciphertext }, &aad(&from))
                    .ok_or_else(|| Error::Corrupt(format!("revision {id} does not decrypt")))?;
                let sealed = crypto::encrypt(&new, &plaintext, &aad(&to));
                tx.execute(
                    "UPDATE revisions SET collection_id = ?1, nonce = ?2, ciphertext = ?3 WHERE id = ?4",
                    params![to.to_string(), sealed.nonce, sealed.ciphertext, id],
                )?;
            }

            // Attachments, one at a time: there may be many photos.
            let mut statement =
                tx.prepare("SELECT id, media_type FROM attachments WHERE record_id = ?1 AND kind = ?2")?;
            let found = statement
                .query_map(params![record_id.to_string(), kind.as_str()], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            for (id, media_type) in found {
                let attachment_id = parse_id(&id)?;
                let aad = |collection: &Uuid| {
                    attachments::aad(&attachment_id, &record_id, kind.as_str(), collection, &media_type)
                };
                let (nonce, ciphertext): (Vec<u8>, Vec<u8>) = tx.query_row(
                    "SELECT nonce, ciphertext FROM attachments WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let plaintext = crypto::decrypt(&old, &crypto::Sealed { nonce, ciphertext }, &aad(&from))
                    .ok_or_else(|| Error::Corrupt(format!("attachment {id} does not decrypt")))?;
                let sealed = crypto::encrypt(&new, &plaintext, &aad(&to));
                tx.execute(
                    "UPDATE attachments SET collection_id = ?1, nonce = ?2, ciphertext = ?3 WHERE id = ?4",
                    params![to.to_string(), sealed.nonce, sealed.ciphertext, id],
                )?;
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
}
