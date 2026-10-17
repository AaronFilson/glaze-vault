//! Reading recipes without their chemistry (docs/adr/0004-roles-and-collections.md): each recipe
//! revision also keeps a summary, its content without its lines and notes, under the collection's
//! summary key (super::summary_key), and firings and their photos are kept under that key too. A
//! role that reads without chemistry is given the summary key alone, so what its grant opens does
//! not lead to the recipes' chemistry, the materials or the batch sheets.
//!
//! This is the one place the core looks inside what it keeps: it takes out the named fields.

use super::{Held, Kind, Vault, attachments, parse_id, revision_aad, summary_key};
use crate::crypto::{self, Key, Sealed};
use crate::error::{Error, Result};
use rusqlite::params;

/// The meta row that says firings are under the summary key and every recipe has a summary.
pub(super) const META: &str = "summaries";

/// What a recipe's summary leaves out: its materials and amounts, and its notes, which often say
/// what was changed and why.
const CHEMISTRY: [&str; 2] = ["lines", "notes"];

/// A recipe's content without its chemistry.
fn summarize(content: &serde_json::Value) -> serde_json::Value {
    match content {
        serde_json::Value::Object(fields) => serde_json::Value::Object(
            fields
                .iter()
                .filter(|(name, _)| !CHEMISTRY.contains(&name.as_str()))
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
        ),
        _ => serde_json::Value::Object(Default::default()),
    }
}

/// A summary is bound to its revision as the revision is, and cannot pass as its full content.
fn summary_aad(revision_aad: &[u8]) -> Vec<u8> {
    [revision_aad, b" summary"].concat()
}

/// Seals a recipe's summary, under the revision's own AAD.
pub(super) fn seal(key: &Key, content: &serde_json::Value, aad: &[u8]) -> Result<Sealed> {
    let plaintext = zeroize::Zeroizing::new(serde_json::to_vec(&summarize(content))?);
    Ok(crypto::encrypt(key, &plaintext, &summary_aad(aad)))
}

pub(super) fn open(key: &Key, sealed: &Sealed, aad: &[u8]) -> Option<serde_json::Value> {
    let plaintext = crypto::decrypt(key, sealed, &summary_aad(aad))?;
    serde_json::from_slice(&plaintext).ok()
}

impl Vault {
    /// Changes a vault from before summaries over, all or none: firings and their photos go under
    /// each collection's summary key, and every recipe revision gets its summary. Only someone
    /// who holds every collection's key can: the person of a one-person vault, or an admin. Until
    /// then nobody can be given a role that reads without chemistry, since only admins give roles.
    pub(super) fn change_to_summaries(&mut self) -> Result<()> {
        if self.summaries || self.user().must_set_password {
            return Ok(());
        }
        let total: i64 = self
            .conn
            .query_row("SELECT count(*) FROM collections", [], |row| row.get(0))?;
        let all_held =
            self.collections.len() as i64 == total && self.collections.iter().all(|c| c.held == Held::Collection);
        if !all_held || (self.is_team() && self.organization.is_none()) {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        for collection in &self.collections {
            let key = collection.full_key()?;
            let summary = summary_key(key, &collection.id);
            let id = collection.id.to_string();

            type Row = (String, String, String, i64, Option<String>, bool, Vec<u8>, Vec<u8>);
            let mut statement = tx.prepare(
                "SELECT id, record_id, kind, number, parent_id, deleted, nonce, ciphertext FROM revisions
                 WHERE collection_id = ?1 AND (kind = 'firing' OR (kind = 'recipe' AND summary IS NULL))",
            )?;
            let rows = statement
                .query_map(params![id], |row| {
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
            for (revision, record, kind, number, parent, deleted, nonce, ciphertext) in rows {
                let parent = parent.as_deref().map(parse_id).transpose()?;
                let aad = revision_aad(
                    &parse_id(&revision)?,
                    &parse_id(&record)?,
                    &kind,
                    &collection.id,
                    number,
                    parent.as_ref(),
                    deleted,
                );
                let plaintext = zeroize::Zeroizing::new(
                    crypto::decrypt(key, &Sealed { nonce, ciphertext }, &aad)
                        .ok_or_else(|| Error::Corrupt(format!("revision {revision} does not decrypt")))?,
                );
                if kind == Kind::Firing.as_str() {
                    let sealed = crypto::encrypt(&summary, &plaintext, &aad);
                    tx.execute(
                        "UPDATE revisions SET nonce = ?1, ciphertext = ?2 WHERE id = ?3",
                        params![sealed.nonce, sealed.ciphertext, revision],
                    )?;
                } else {
                    let sealed = seal(&summary, &serde_json::from_slice(&plaintext)?, &aad)?;
                    tx.execute(
                        "UPDATE revisions SET summary_nonce = ?1, summary = ?2 WHERE id = ?3",
                        params![sealed.nonce, sealed.ciphertext, revision],
                    )?;
                }
            }

            // Photos, one at a time: there may be many.
            let mut statement = tx.prepare(
                "SELECT id, record_id, media_type FROM attachments WHERE collection_id = ?1 AND kind = 'firing'",
            )?;
            let photos = statement
                .query_map(params![id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            for (photo, record, media_type) in photos {
                let aad = attachments::aad(
                    &parse_id(&photo)?,
                    &parse_id(&record)?,
                    "firing",
                    &collection.id,
                    &media_type,
                );
                let (nonce, ciphertext): (Vec<u8>, Vec<u8>) = tx.query_row(
                    "SELECT nonce, ciphertext FROM attachments WHERE id = ?1",
                    params![photo],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let plaintext = zeroize::Zeroizing::new(
                    crypto::decrypt(key, &Sealed { nonce, ciphertext }, &aad)
                        .ok_or_else(|| Error::Corrupt(format!("attachment {photo} does not decrypt")))?,
                );
                let sealed = crypto::encrypt(&summary, &plaintext, &aad);
                tx.execute(
                    "UPDATE attachments SET nonce = ?1, ciphertext = ?2 WHERE id = ?3",
                    params![sealed.nonce, sealed.ciphertext, photo],
                )?;
            }
        }
        tx.execute("INSERT INTO meta (name, value) VALUES (?1, '1')", params![META])?;
        tx.commit()?;
        self.summaries = true;
        Ok(())
    }
}

/// Seals a recipe revision's summary again under another key, as when its collection's key
/// changes or it moves: `old` and `new` are summary keys, and the AADs its revision's.
pub(super) fn reseal(old: &Key, new: &Key, sealed: &Sealed, old_aad: &[u8], new_aad: &[u8]) -> Result<Sealed> {
    let plaintext = crypto::decrypt(old, sealed, &summary_aad(old_aad))
        .ok_or_else(|| Error::Corrupt("a recipe summary does not decrypt".into()))?;
    let plaintext = zeroize::Zeroizing::new(plaintext);
    Ok(crypto::encrypt(new, &plaintext, &summary_aad(new_aad)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::Role;
    use crate::vault::Capabilities;
    use serde_json::json;
    use uuid::Uuid;

    const PASSWORD: &str = "cone six oxidation";
    const ONE_TIME: &str = "pass this on";
    const BENS: &str = "bens own password";
    const SALES: Capabilities = Capabilities {
        export: true,
        print: true,
        chemistry: false,
        manage: false,
    };

    fn team() -> (tempfile::TempDir, Vault, Uuid) {
        let dir = tempfile::tempdir().unwrap();
        let (mut ana, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        ana.grow_into_team("Ana").unwrap();
        let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        (dir, ana, shared)
    }

    fn signed_in(dir: &tempfile::TempDir, person: Uuid) -> Vault {
        let mut vault = Vault::unlock_as(dir.path(), Some(person), ONE_TIME).unwrap();
        vault.set_own_password(BENS).unwrap();
        vault
    }

    #[test]
    fn a_role_without_chemistry_reads_names_firings_and_photos_and_nothing_else() {
        let (dir, mut ana, shared) = team();
        let recipe = ana
            .save_in(
                Kind::Recipe,
                shared,
                &json!({ "name": "Shino", "cone": "10", "lines": [{ "material": "Nepheline Syenite", "amount": "50" }], "notes": "secret" }),
            )
            .unwrap();
        ana.save_in(Kind::Material, shared, &json!({ "name": "Grolleg" }))
            .unwrap();
        ana.save_in(Kind::Batch, shared, &json!({ "recipe": recipe.record_id }))
            .unwrap();
        let firing = ana
            .save_in(Kind::Firing, shared, &json!({ "recipe": recipe.record_id }))
            .unwrap();
        let photo = ana
            .add_attachment(Kind::Firing, firing.record_id, "image/jpeg", b"tile")
            .unwrap();
        assert!(matches!(
            ana.create_role("Sales", &[Kind::Recipe], SALES),
            Err(Error::ChemistryNeeded)
        ));
        let sales = ana.create_role("Sales", &[Kind::Firing], SALES).unwrap();
        let ben = ana
            .add_person("Ben", ONE_TIME, &[(shared, Role::Custom(sales.id))])
            .unwrap();
        drop(ana);

        let mut as_ben = signed_in(&dir, ben.id);
        let heads = as_ben.heads(Kind::Recipe).unwrap();
        assert_eq!(heads.len(), 1);
        assert_eq!(heads[0].content, json!({ "name": "Shino", "cone": "10" }));
        assert!(as_ben.heads(Kind::Material).unwrap().is_empty());
        assert!(as_ben.heads(Kind::Batch).unwrap().is_empty());
        assert_eq!(as_ben.heads(Kind::Firing).unwrap().len(), 1);
        assert_eq!(&as_ben.attachment(photo.id).unwrap().1[..], b"tile");
        as_ben
            .save_in(Kind::Firing, shared, &json!({ "recipe": recipe.record_id }))
            .unwrap();
        assert!(matches!(
            as_ben.save(Kind::Recipe, Some(recipe.revision_id), &json!({ "name": "Mine" })),
            Err(Error::NotAllowed)
        ));
        let collection = as_ben.collections().into_iter().find(|c| c.id == shared).unwrap();
        assert!(!collection.may.chemistry);
        assert_eq!(collection.changes, [Kind::Firing]);

        // What Ben's grant holds opens the summaries, and not the recipes themselves.
        let held = as_ben.readable(&shared).unwrap();
        assert_eq!(held.held, Held::Summary);
        let (nonce, ciphertext): (Vec<u8>, Vec<u8>) = as_ben
            .conn
            .query_row(
                "SELECT nonce, ciphertext FROM revisions WHERE id = ?1",
                params![recipe.revision_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let aad = revision_aad(
            &recipe.revision_id,
            &recipe.record_id,
            "recipe",
            &shared,
            1,
            None,
            false,
        );
        assert!(crypto::decrypt(&held.key, &Sealed { nonce, ciphertext }, &aad).is_none());
    }

    #[test]
    fn a_vault_from_before_summaries_is_changed_over_by_an_admin() {
        let (dir, mut ana, shared) = team();
        // Saved as a vault from before summaries would: firings under the collection's key, and
        // recipes with no summary.
        ana.conn
            .execute("DELETE FROM meta WHERE name = ?1", params![META])
            .unwrap();
        ana.summaries = false;
        let recipe = ana
            .save_in(Kind::Recipe, shared, &json!({ "name": "Tenmoku", "lines": [] }))
            .unwrap();
        let firing = ana
            .save_in(Kind::Firing, shared, &json!({ "recipe": recipe.record_id }))
            .unwrap();
        let photo = ana
            .add_attachment(Kind::Firing, firing.record_id, "image/jpeg", b"tile")
            .unwrap();
        ana.conn
            .execute("UPDATE revisions SET summary_nonce = NULL, summary = NULL", [])
            .unwrap();
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
        drop(ana);

        // Ben opens it before any admin has: nothing changes, and he reads it as before.
        let as_ben = signed_in(&dir, ben.id);
        assert!(!as_ben.summaries);
        assert_eq!(as_ben.heads(Kind::Firing).unwrap().len(), 1);
        drop(as_ben);

        let ana_id = Vault::people_in(dir.path())
            .unwrap()
            .into_iter()
            .find(|p| p.name == "Ana")
            .unwrap()
            .id;
        let mut ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
        assert!(ana.summaries);
        assert_eq!(&ana.attachment(photo.id).unwrap().1[..], b"tile");
        assert_eq!(ana.heads(Kind::Firing).unwrap().len(), 1);

        let sales = ana.create_role("Sales", &[], SALES).unwrap();
        ana.set_role(ben.id, shared, Some(Role::Custom(sales.id))).unwrap();
        drop(ana);
        let as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
        assert_eq!(
            as_ben.heads(Kind::Recipe).unwrap()[0].content,
            json!({ "name": "Tenmoku" })
        );
        assert_eq!(&as_ben.attachment(photo.id).unwrap().1[..], b"tile");
    }

    #[test]
    fn a_role_that_stops_reading_chemistry_gives_its_collections_new_keys() {
        let (dir, mut ana, shared) = team();
        let recipe = ana
            .save_in(Kind::Recipe, shared, &json!({ "name": "Celadon", "lines": [1] }))
            .unwrap();
        let tasters = ana
            .create_role("Tasters", &[Kind::Firing], Capabilities::BUILT_IN)
            .unwrap();
        let ben = ana
            .add_person("Ben", ONE_TIME, &[(shared, Role::Custom(tasters.id))])
            .unwrap();
        let as_ben = signed_in(&dir, ben.id);
        let kept = as_ben.readable(&shared).unwrap().key.clone();
        assert_eq!(as_ben.heads(Kind::Recipe).unwrap()[0].content["lines"], json!([1]));
        drop(as_ben);

        ana.change_role(tasters.id, "Tasters", &[Kind::Firing], SALES).unwrap();
        assert_ne!(*ana.readable(&shared).unwrap().key, *kept);
        let as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
        assert_eq!(
            as_ben.heads(Kind::Recipe).unwrap()[0].content,
            json!({ "name": "Celadon" })
        );
        drop(as_ben);

        // And back: the grant holds the collection's key again.
        ana.change_role(tasters.id, "Tasters", &[Kind::Firing], Capabilities::BUILT_IN)
            .unwrap();
        let as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
        assert_eq!(as_ben.heads(Kind::Recipe).unwrap()[0].content["lines"], json!([1]));
        assert_eq!(as_ben.history(Kind::Recipe, recipe.record_id).unwrap().len(), 1);
    }
}
