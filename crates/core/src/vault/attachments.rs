//! A record's attachments (docs/adr/0014-firing-log-and-photos.md): photos of test tiles and other
//! files, encrypted with the key of the record's collection, as its revisions are, and kept in
//! their own table so a revision only names them. An attachment is never changed: a record stops
//! naming it in a new revision, and erasing the record removes it.

use super::{Kind, Vault, now_ms, parse_id};
use crate::crypto;
use crate::error::{Error, Result};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use uuid::Uuid;
use zeroize::Zeroizing;

/// The largest attachment kept: a photo from a phone, already made smaller by the app.
pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

/// What is known about an attachment without opening it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: Uuid,
    pub record_id: Uuid,
    pub media_type: String,
    pub size: usize,
    pub created_at: i64,
}

impl Vault {
    /// Adds a file to a record that exists, in its collection, if this person may change it there.
    pub fn add_attachment(
        &mut self,
        kind: Kind,
        record_id: Uuid,
        media_type: &str,
        bytes: &[u8],
    ) -> Result<Attachment> {
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(Error::TooLarge);
        }
        if !valid_media_type(media_type) {
            return Err(Error::Corrupt(format!("{media_type} is not a media type")));
        }
        let collection_id: String = self
            .conn
            .query_row(
                "SELECT collection_id FROM revisions WHERE record_id = ?1 AND kind = ?2 LIMIT 1",
                params![record_id.to_string(), kind.as_str()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        let collection_id = parse_id(&collection_id)?;
        let key = self.editable(&collection_id)?.key_for(kind).ok_or(Error::NotAllowed)?;
        let attachment = Attachment {
            id: Uuid::new_v4(),
            record_id,
            media_type: media_type.to_owned(),
            size: bytes.len(),
            created_at: now_ms(),
        };
        let sealed = crypto::encrypt(
            &key,
            bytes,
            &aad(&attachment.id, &record_id, kind.as_str(), &collection_id, media_type),
        );
        self.conn.execute(
            "INSERT INTO attachments (id, record_id, kind, collection_id, media_type, size, author_id, created_at, nonce, ciphertext)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                attachment.id.to_string(),
                record_id.to_string(),
                kind.as_str(),
                collection_id.to_string(),
                media_type,
                attachment.size as i64,
                self.user_id.to_string(),
                attachment.created_at,
                sealed.nonce,
                sealed.ciphertext,
            ],
        )?;
        Ok(attachment)
    }

    /// An attachment and its bytes, if this person can open its record. One they cannot is not
    /// shown to exist.
    pub fn attachment(&self, id: Uuid) -> Result<(Attachment, Zeroizing<Vec<u8>>)> {
        type Row = (String, String, String, String, i64, i64, Vec<u8>, Vec<u8>);
        let row: Option<Row> = self
            .conn
            .query_row(
                "SELECT record_id, kind, collection_id, media_type, size, created_at, nonce, ciphertext
                 FROM attachments WHERE id = ?1",
                params![id.to_string()],
                |row| {
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
                },
            )
            .optional()?;
        let (record_id, kind, collection_id, media_type, size, created_at, nonce, ciphertext) =
            row.ok_or(Error::NotFound)?;
        let (record_id, collection_id) = (parse_id(&record_id)?, parse_id(&collection_id)?);
        let kind = Kind::parse(&kind).ok_or_else(|| Error::Corrupt(format!("unknown kind {kind}")))?;
        let key = self
            .collections
            .iter()
            .find(|c| c.id == collection_id)
            .and_then(|c| c.key_for(kind))
            .ok_or(Error::NotFound)?;
        let bytes = crypto::decrypt(
            &key,
            &crypto::Sealed { nonce, ciphertext },
            &aad(&id, &record_id, kind.as_str(), &collection_id, &media_type),
        )
        .ok_or_else(|| Error::Corrupt(format!("attachment {id} does not decrypt")))?;
        Ok((
            Attachment {
                id,
                record_id,
                media_type,
                size: size as usize,
                created_at,
            },
            bytes,
        ))
    }
}

/// Binds an attachment's bytes to it, its record and collection, and what kind of file it is.
pub(super) fn aad(id: &Uuid, record_id: &Uuid, kind: &str, collection_id: &Uuid, media_type: &str) -> Vec<u8> {
    format!(
        "glaze-vault v1 attachment {id} record {record_id} kind {kind} collection {collection_id} type {media_type}"
    )
    .into_bytes()
}

/// A media type such as image/jpeg: what the app shows it as, so nothing that could be run.
fn valid_media_type(media_type: &str) -> bool {
    let Some((family, name)) = media_type.split_once('/') else {
        return false;
    };
    ["image", "application"].contains(&family)
        && !name.is_empty()
        && name.len() < 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::Role;
    use serde_json::json;

    const PASSWORD: &str = "cone six oxidation";

    #[test]
    fn a_photo_is_kept_encrypted_and_goes_when_its_record_is_erased() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let firing = vault.save(Kind::Firing, None, &json!({ "cone": "6" })).unwrap();
        let photo = b"\xff\xd8\xff a test tile, glossy blue";
        let added = vault
            .add_attachment(Kind::Firing, firing.record_id, "image/jpeg", photo)
            .unwrap();
        assert_eq!(added.size, photo.len());
        let (found, bytes) = vault.attachment(added.id).unwrap();
        assert_eq!(
            (found.record_id, found.media_type.as_str()),
            (firing.record_id, "image/jpeg")
        );
        assert_eq!(&bytes[..], photo);

        assert!(matches!(
            vault.add_attachment(Kind::Firing, Uuid::new_v4(), "image/jpeg", photo),
            Err(Error::NotFound)
        ));
        assert!(matches!(
            vault.add_attachment(Kind::Firing, firing.record_id, "text/html", photo),
            Err(Error::Corrupt(_))
        ));
        assert!(matches!(
            vault.add_attachment(
                Kind::Firing,
                firing.record_id,
                "image/png",
                &vec![0; MAX_ATTACHMENT_BYTES + 1]
            ),
            Err(Error::TooLarge)
        ));

        // Moved to another attachment's row, the ciphertext does not open.
        let other = vault
            .add_attachment(Kind::Firing, firing.record_id, "image/png", b"another")
            .unwrap();
        vault
            .conn
            .execute(
                "UPDATE attachments SET ciphertext = (SELECT ciphertext FROM attachments WHERE id = ?1),
                 nonce = (SELECT nonce FROM attachments WHERE id = ?1) WHERE id = ?2",
                params![added.id.to_string(), other.id.to_string()],
            )
            .unwrap();
        assert!(matches!(vault.attachment(other.id), Err(Error::Corrupt(_))));

        let deleted = vault.delete(Kind::Firing, firing.revision_id).unwrap();
        vault.erase(Kind::Firing, deleted.record_id).unwrap();
        assert!(matches!(vault.attachment(added.id), Err(Error::NotFound)));
    }

    #[test]
    fn attachments_follow_their_collections_key() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ana, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        ana.grow_into_team("Ana").unwrap();
        let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        let firing = ana.save_in(Kind::Firing, shared, &json!({ "cone": "10" })).unwrap();
        let photo = ana
            .add_attachment(Kind::Firing, firing.record_id, "image/jpeg", b"tile")
            .unwrap();
        let ben = ana
            .add_person("Ben", "pass this on", &[(shared, Role::Chemist)])
            .unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), "pass this on").unwrap();
        as_ben.set_own_password("bens own password").unwrap();
        assert_eq!(&as_ben.attachment(photo.id).unwrap().1[..], b"tile");
        // A chemist reads but does not add.
        assert!(matches!(
            as_ben.add_attachment(Kind::Firing, firing.record_id, "image/jpeg", b"mine"),
            Err(Error::NotAllowed)
        ));
        drop(as_ben);

        // Taking Ben's role away gives the collection a new key, and the photo moves to it.
        ana.set_role(ben.id, shared, None).unwrap();
        assert_eq!(&ana.attachment(photo.id).unwrap().1[..], b"tile");
        let as_ben = Vault::unlock_as(dir.path(), Some(ben.id), "bens own password").unwrap();
        assert!(matches!(as_ben.attachment(photo.id), Err(Error::NotFound)));
    }
}
