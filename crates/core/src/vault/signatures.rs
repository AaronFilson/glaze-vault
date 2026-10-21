//! Signatures and certificates in the vault (docs/adr/0019-signatures-and-audit-log.md): signing
//! what is saved, certifying people's signing keys, vouching for what was saved before signing,
//! and checking a revision's signature for its history.
//!
//! A certificate is trusted when it was issued while its issuer was the organization's signing
//! key, or, for a key that certifies itself, while the vault had no organization. On one computer
//! these checks find changes made around the app; the LAN host will enforce them as things arrive.

use super::events::{self, Body, SignedBy};
use super::{Vault, now_ms, parse_id};
use crate::access::Directory;
use crate::crypto::KeyPair;
use crate::error::Result;
use crate::signing::{self, As, AttachmentFacts, RevisionFacts, Signer};
use rusqlite::{Connection, params};
use serde::Serialize;
use uuid::Uuid;

/// Who signed a revision, in what capacity, and whether it checks.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signed {
    pub by: Uuid,
    #[serde(rename = "as")]
    pub signed_as: SignedAs,
    pub check: SignatureCheck,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SignedAs {
    /// The person who saved it.
    Author,
    /// Someone who vouched for it after it was saved, before revisions were signed.
    Attester,
    /// Someone who moved it to another collection, which encrypts it again.
    Mover,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SignatureCheck {
    /// The signature is good, by a key certified as the signer's.
    Good,
    /// The signature is good, by a key no admin has certified yet; or the key is not known.
    Unconfirmed,
    /// The signature does not match what it signs: something was changed around the app.
    Bad,
}

impl From<As> for SignedAs {
    fn from(role: As) -> SignedAs {
        match role {
            As::Author => SignedAs::Author,
            As::Attester => SignedAs::Attester,
            As::Mover => SignedAs::Mover,
        }
    }
}

/// A revision as it is stored, for what its signature covers.
pub(super) struct RevisionRow {
    pub id: Uuid,
    pub record: Uuid,
    pub kind: String,
    pub collection: Uuid,
    pub epoch: i64,
    pub number: i64,
    pub parent: Option<Uuid>,
    pub deleted: bool,
    pub supersedes: Option<String>,
    pub author: Uuid,
    pub at: i64,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub summary: Option<(Vec<u8>, Vec<u8>)>,
    pub signed: Option<SignedBy>,
}

const REVISION_COLUMNS: &str = "id, record_id, kind, collection_id, epoch, number, parent_id, deleted, supersedes, \
     author_id, created_at, nonce, ciphertext, summary_nonce, summary, signature, signer_id, signed_as";

impl RevisionRow {
    fn read(row: &rusqlite::Row) -> rusqlite::Result<RevisionRow> {
        let id = |text: String| Uuid::parse_str(&text).unwrap_or_default();
        let summary = match (row.get::<_, Option<Vec<u8>>>(13)?, row.get::<_, Option<Vec<u8>>>(14)?) {
            (Some(nonce), Some(summary)) => Some((nonce, summary)),
            _ => None,
        };
        Ok(RevisionRow {
            id: id(row.get(0)?),
            record: id(row.get(1)?),
            kind: row.get(2)?,
            collection: id(row.get(3)?),
            epoch: row.get(4)?,
            number: row.get(5)?,
            parent: row.get::<_, Option<String>>(6)?.map(id),
            deleted: row.get(7)?,
            supersedes: row.get(8)?,
            author: id(row.get(9)?),
            at: row.get(10)?,
            nonce: row.get(11)?,
            ciphertext: row.get(12)?,
            summary,
            signed: signed_by(row.get(15)?, row.get(16)?, row.get(17)?),
        })
    }

    pub fn facts<'a>(&'a self, vault: &'a Uuid) -> RevisionFacts<'a> {
        RevisionFacts {
            vault,
            id: &self.id,
            record: &self.record,
            kind: &self.kind,
            collection: &self.collection,
            epoch: self.epoch,
            number: self.number,
            parent: self.parent.as_ref(),
            deleted: self.deleted,
            supersedes: self.supersedes.as_deref(),
            author: &self.author,
            at: self.at,
            nonce: &self.nonce,
            ciphertext: &self.ciphertext,
            summary: self.summary.as_ref().map(|(n, s)| (n.as_slice(), s.as_slice())),
        }
    }
}

/// An attachment as it is stored, for what its signature covers.
struct AttachmentRow {
    id: Uuid,
    record: Uuid,
    kind: String,
    collection: Uuid,
    epoch: i64,
    media_type: String,
    size: i64,
    author: Uuid,
    at: i64,
    sha256: Vec<u8>,
}

const ATTACHMENT_COLUMNS: &str =
    "id, record_id, kind, collection_id, epoch, media_type, size, author_id, created_at, sha256";

impl AttachmentRow {
    fn read(row: &rusqlite::Row) -> rusqlite::Result<AttachmentRow> {
        let id = |text: String| Uuid::parse_str(&text).unwrap_or_default();
        Ok(AttachmentRow {
            id: id(row.get(0)?),
            record: id(row.get(1)?),
            kind: row.get(2)?,
            collection: id(row.get(3)?),
            epoch: row.get(4)?,
            media_type: row.get(5)?,
            size: row.get(6)?,
            author: id(row.get(7)?),
            at: row.get(8)?,
            sha256: row.get::<_, Option<Vec<u8>>>(9)?.unwrap_or_default(),
        })
    }

    fn facts<'a>(&'a self, vault: &'a Uuid) -> AttachmentFacts<'a> {
        AttachmentFacts {
            vault,
            id: &self.id,
            record: &self.record,
            kind: &self.kind,
            collection: &self.collection,
            epoch: self.epoch,
            media_type: &self.media_type,
            size: self.size,
            author: &self.author,
            at: self.at,
            sha256: &self.sha256,
        }
    }
}

fn signed_by(signature: Option<Vec<u8>>, signer: Option<String>, role: Option<String>) -> Option<SignedBy> {
    Some(SignedBy {
        signature: signature?,
        signer: Uuid::parse_str(&signer?).ok()?,
        role: As::parse(&role?)?,
    })
}

/// Signs a revision or attachment's facts as `role`.
pub(super) fn sign(signer: &Signer, role: As, payload: impl FnOnce(As, &Uuid) -> Vec<u8>) -> SignedBy {
    SignedBy {
        signature: signer.sign(&payload(role, &signer.person)),
        signer: signer.person,
        role,
    }
}

/// A certificate the organization issues for a person's keys.
pub(super) fn organization_certificate(
    vault: &Uuid,
    organization: &KeyPair,
    person: Uuid,
    signing_key: &[u8],
    encryption_key: &[u8],
) -> Body {
    let issuer = signing::organization_key(organization);
    let issued_at = now_ms();
    let payload = signing::certificate_payload(vault, &person, signing_key, encryption_key, issued_at);
    Body::CertificateIssued {
        certificate: Uuid::new_v4(),
        person,
        signing_key: signing_key.to_vec(),
        encryption_key: encryption_key.to_vec(),
        issued_at,
        issuer_key: signing::public(&issuer),
        signature: signing::sign(&issuer, &payload),
        proof: None,
    }
}

/// A certificate a person issues for their own keys; in a team's vault, with proof against the
/// organization's encryption key that they hold the secret its encryption key belongs to.
pub(super) fn own_certificate(vault: &Uuid, keys: &KeyPair, person: Uuid, organization: Option<&[u8]>) -> Body {
    let key = signing::person_key(keys);
    let public = signing::public(&key);
    let issued_at = now_ms();
    let payload = signing::certificate_payload(vault, &person, &public, &keys.public, issued_at);
    Body::CertificateIssued {
        certificate: Uuid::new_v4(),
        person,
        signing_key: public.clone(),
        encryption_key: keys.public.clone(),
        issued_at,
        issuer_key: public,
        signature: signing::sign(&key, &payload),
        proof: organization.and_then(|organization| signing::key_proof(&keys.secret, organization, &payload)),
    }
}

/// Lists the organization's signing key as the one certificates are trusted by, if it is not
/// listed yet. That retires any key listed before it.
pub(super) fn add_organization_key(conn: &Connection, signer: &Signer, organization: &KeyPair) -> Result<()> {
    let key = signing::organization_key(organization);
    let public = signing::public(&key);
    if Directory::load(conn)?.organization_keys.contains(&public) {
        return Ok(());
    }
    let payload = signing::organization_key_payload(&signer.vault, &public, &organization.public);
    events::record(
        conn,
        signer,
        Body::OrganizationKeyAdded {
            signing_key: public,
            encryption_key: organization.public.clone(),
            signature: signing::sign(&key, &payload),
        },
    )
}

/// A certificate as it is stored.
struct Certificate {
    person: Uuid,
    signing_key: Vec<u8>,
    encryption_key: Vec<u8>,
    issued_at: i64,
    issuer_key: Vec<u8>,
    signature: Vec<u8>,
    proof: Option<Vec<u8>>,
    revoked: bool,
}

/// The certificates and organization keys a store holds: what signatures are checked against.
pub(super) struct Trust {
    vault: Uuid,
    certificates: Vec<Certificate>,
    /// Each organization signing key, and when it was the organization's.
    organization_keys: Vec<(Vec<u8>, i64, Option<i64>)>,
}

impl Trust {
    pub fn load(conn: &Connection, vault: Uuid) -> Result<Trust> {
        type Row = (String, Vec<u8>, Vec<u8>, i64, Vec<u8>, Vec<u8>, Option<Vec<u8>>, bool);
        let rows = conn
            .prepare(
                "SELECT person_id, signing_key, encryption_key, issued_at, issuer_key, signature, proof,
                        revoked_at IS NOT NULL
                 FROM certificates ORDER BY issued_at, rowid",
            )?
            .query_map([], |row| {
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
        let certificates = rows
            .into_iter()
            .map(
                |(person, signing_key, encryption_key, issued_at, issuer_key, signature, proof, revoked)| {
                    Ok(Certificate {
                        person: parse_id(&person)?,
                        signing_key,
                        encryption_key,
                        issued_at,
                        issuer_key,
                        signature,
                        proof,
                        revoked,
                    })
                },
            )
            .collect::<Result<_>>()?;
        let organization_keys = conn
            .prepare("SELECT signing_key, added_at, retired_at FROM organization_keys ORDER BY added_at")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Trust {
            vault,
            certificates,
            organization_keys,
        })
    }

    fn payload(&self, certificate: &Certificate) -> Vec<u8> {
        signing::certificate_payload(
            &self.vault,
            &certificate.person,
            &certificate.signing_key,
            &certificate.encryption_key,
            certificate.issued_at,
        )
    }

    /// Whether a certificate was issued by whoever could vouch for keys when it was issued.
    fn trusted(&self, certificate: &Certificate) -> bool {
        if !signing::verify(
            &certificate.issuer_key,
            &self.payload(certificate),
            &certificate.signature,
        ) {
            return false;
        }
        let at = certificate.issued_at;
        let current =
            |(_, added, retired): &&(Vec<u8>, i64, Option<i64>)| *added <= at && retired.is_none_or(|r| at < r);
        match self.organization_keys.iter().find(current) {
            Some((key, _, _)) => *key == certificate.issuer_key,
            None => certificate.issuer_key == certificate.signing_key,
        }
    }

    /// Some(true) when a trusted certificate says `key` is `person`'s; Some(false) when only
    /// others do, such as one they made themselves that no admin has certified yet.
    fn certified(&self, person: Uuid, key: &[u8]) -> Option<bool> {
        let theirs: Vec<&Certificate> = self
            .certificates
            .iter()
            .filter(|c| c.person == person && c.signing_key == key)
            .collect();
        if theirs.is_empty() {
            return None;
        }
        Some(theirs.iter().any(|c| self.trusted(c)))
    }

    /// Checks a signature over `payload` against the signer's certified keys.
    pub fn check(&self, signed: &SignedBy, payload: &[u8]) -> Signed {
        let mut keys: Vec<&Vec<u8>> = self
            .certificates
            .iter()
            .filter(|c| c.person == signed.signer)
            .map(|c| &c.signing_key)
            .collect();
        keys.dedup();
        let check = match keys.iter().find(|key| signing::verify(key, payload, &signed.signature)) {
            Some(key) if self.certified(signed.signer, key) == Some(true) => SignatureCheck::Good,
            Some(_) => SignatureCheck::Unconfirmed,
            None if keys.is_empty() => SignatureCheck::Unconfirmed,
            None => SignatureCheck::Bad,
        };
        Signed {
            by: signed.signer,
            signed_as: signed.role.into(),
            check,
        }
    }
}

impl Vault {
    /// Signs a revision or attachment this person saves.
    pub(super) fn sign_as_author(&self, payload: impl FnOnce(As, &Uuid) -> Vec<u8>) -> SignedBy {
        sign(&self.signer, As::Author, payload)
    }

    /// Who signed a revision, and whether it checks, for its history.
    pub(super) fn revision_signed(&self, trust: &Trust, id: &Uuid) -> Result<Option<Signed>> {
        let row = self.conn.query_row(
            &format!("SELECT {REVISION_COLUMNS} FROM revisions WHERE id = ?1"),
            params![id.to_string()],
            RevisionRow::read,
        )?;
        Ok(row.signed.as_ref().map(|signed| {
            let payload = signing::revision_payload(&row.facts(&self.keyring.vault_id), signed.role, &signed.signer);
            trust.check(signed, &payload)
        }))
    }

    pub(super) fn trust(&self) -> Result<Trust> {
        Trust::load(&self.conn, self.keyring.vault_id)
    }

    /// At unlock: makes sure this person's signing key is certified, or on its way. An admin's
    /// key the organization certifies; anyone else in a team's vault makes a certificate with
    /// proof, for an admin to certify at their next unlock; in a one-person vault its person's
    /// certifies itself.
    pub(super) fn certify_myself(&mut self) -> Result<()> {
        if self.user().must_set_password {
            return Ok(());
        }
        let trust = self.trust()?;
        let mine = signing::public(&self.signer.key);
        if trust.certified(self.user_id, &mine) == Some(true) {
            return Ok(());
        }
        let vault_id = self.keyring.vault_id;
        let tx = self.conn.unchecked_transaction()?;
        match (self.is_team(), self.admin()) {
            (true, Ok(organization)) => {
                add_organization_key(&tx, &self.signer, organization)?;
                let body = organization_certificate(&vault_id, organization, self.user_id, &mine, &self.keys.public);
                events::record(&tx, &self.signer, body)?;
            }
            (true, Err(_)) => {
                let organization = self.organization_public_key()?;
                let proven = trust.certificates.iter().any(|c| {
                    c.person == self.user_id
                        && c.signing_key == mine
                        && c.issuer_key == mine
                        && c.proof.as_deref()
                            == signing::key_proof(&self.keys.secret, &organization, &trust.payload(c)).as_deref()
                });
                if !proven {
                    let body = own_certificate(&vault_id, &self.keys, self.user_id, Some(&organization));
                    events::record(&tx, &self.signer, body)?;
                }
            }
            (false, _) => {
                events::record(
                    &tx,
                    &self.signer,
                    own_certificate(&vault_id, &self.keys, self.user_id, None),
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// At an unlock by an admin, or a one-person vault's person: certifies the keys others have
    /// proven are theirs, and vouches for each revision, attachment and event saved before
    /// signing. Tried again at the next unlock if it fails.
    pub(super) fn attest(&mut self) -> Result<()> {
        let organization = match (self.is_team(), self.admin()) {
            (true, Ok(organization)) => Some(organization),
            (true, Err(_)) => return Ok(()),
            (false, _) => None,
        };
        let vault_id = self.keyring.vault_id;
        let tx = self.conn.unchecked_transaction()?;
        if let Some(organization) = organization {
            add_organization_key(&tx, &self.signer, organization)?;
            let trust = Trust::load(&tx, vault_id)?;
            let directory = Directory::load(&tx)?;
            let people: Vec<(Uuid, Vec<u8>)> = tx
                .prepare("SELECT id, public_key FROM people WHERE removed_at IS NULL")?
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<(String, Vec<u8>)>>>()?
                .into_iter()
                .map(|(id, key)| Ok((parse_id(&id)?, key)))
                .collect::<Result<_>>()?;
            let mut certified: Vec<Vec<u8>> = Vec::new();
            for certificate in &trust.certificates {
                let current = people
                    .iter()
                    .any(|(id, key)| *id == certificate.person && *key == certificate.encryption_key);
                let proven = certificate.issuer_key == certificate.signing_key
                    && certificate.proof.as_deref()
                        == signing::key_proof(
                            &organization.secret,
                            &certificate.encryption_key,
                            &trust.payload(certificate),
                        )
                        .as_deref();
                if certificate.revoked
                    || !current
                    || !proven
                    || directory.person(certificate.person).is_none()
                    || trust.certified(certificate.person, &certificate.signing_key) == Some(true)
                    || certified.contains(&certificate.signing_key)
                    || !trust.trusted_own(certificate)
                {
                    continue;
                }
                let body = organization_certificate(
                    &vault_id,
                    organization,
                    certificate.person,
                    &certificate.signing_key,
                    &certificate.encryption_key,
                );
                events::record(&tx, &self.signer, body)?;
                certified.push(certificate.signing_key.clone());
            }
        }
        self.vouch(&tx)?;
        tx.commit()?;
        Ok(())
    }

    /// Signs, as this person vouching for them, the revisions, attachments and events saved
    /// before signing. What they hold is not opened: only its hashes are signed.
    fn vouch(&self, tx: &Connection) -> Result<()> {
        let vault_id = self.keyring.vault_id;
        let me = self.user_id.to_string();
        let attester = As::Attester.code();
        let rows = tx
            .prepare(&format!(
                "SELECT {REVISION_COLUMNS} FROM revisions WHERE signature IS NULL"
            ))?
            .query_map([], RevisionRow::read)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for row in rows {
            let signed = sign(&self.signer, As::Attester, |role, signer| {
                signing::revision_payload(&row.facts(&vault_id), role, signer)
            });
            tx.execute(
                "UPDATE revisions SET signature = ?1, signer_id = ?2, signed_as = ?3 WHERE id = ?4",
                params![signed.signature, me, attester, row.id.to_string()],
            )?;
        }

        let attached = tx
            .prepare(&format!(
                "SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE signature IS NULL"
            ))?
            .query_map([], AttachmentRow::read)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for row in attached {
            let signed = sign(&self.signer, As::Attester, |role, signer| {
                signing::attachment_payload(&row.facts(&vault_id), role, signer)
            });
            tx.execute(
                "UPDATE attachments SET signature = ?1, signer_id = ?2, signed_as = ?3 WHERE id = ?4",
                params![signed.signature, me, attester, row.id.to_string()],
            )?;
        }

        type Unsigned = (String, String, Option<String>, Option<String>, i64, String);
        let unsigned = tx
            .prepare("SELECT id, type, actor_id, collection_id, created_at, body FROM events WHERE signature IS NULL")?
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<Unsigned>>>()?;
        for (id, kind, actor, collection, at, body) in unsigned {
            let (event, actor, collection) = (
                parse_id(&id)?,
                actor.as_deref().map(parse_id).transpose()?,
                collection.as_deref().map(parse_id).transpose()?,
            );
            let signed = sign(&self.signer, As::Attester, |role, signer| {
                signing::event_payload(
                    &vault_id,
                    &event,
                    &kind,
                    actor.as_ref(),
                    collection.as_ref(),
                    at,
                    &body,
                    role,
                    signer,
                )
            });
            tx.execute(
                "UPDATE events SET signature = ?1, signer_id = ?2, signed_as = ?3 WHERE id = ?4",
                params![signed.signature, me, attester, id],
            )?;
        }
        Ok(())
    }
}

impl Vault {
    /// Signs again, as the person moving it, a revision encrypted again for another collection.
    pub(super) fn sign_moved_revision(&self, tx: &Connection, id: &Uuid) -> Result<()> {
        let row = tx.query_row(
            &format!("SELECT {REVISION_COLUMNS} FROM revisions WHERE id = ?1"),
            params![id.to_string()],
            RevisionRow::read,
        )?;
        let signed = sign(&self.signer, As::Mover, |role, signer| {
            signing::revision_payload(&row.facts(&self.keyring.vault_id), role, signer)
        });
        tx.execute(
            "UPDATE revisions SET signature = ?1, signer_id = ?2, signed_as = ?3 WHERE id = ?4",
            params![
                signed.signature,
                signed.signer.to_string(),
                signed.role.code(),
                id.to_string()
            ],
        )?;
        Ok(())
    }

    /// Signs again, as the person moving it, an attachment encrypted again for another collection.
    pub(super) fn sign_moved_attachment(&self, tx: &Connection, id: &Uuid) -> Result<()> {
        let row = tx.query_row(
            &format!("SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?1"),
            params![id.to_string()],
            AttachmentRow::read,
        )?;
        let signed = sign(&self.signer, As::Mover, |role, signer| {
            signing::attachment_payload(&row.facts(&self.keyring.vault_id), role, signer)
        });
        tx.execute(
            "UPDATE attachments SET signature = ?1, signer_id = ?2, signed_as = ?3 WHERE id = ?4",
            params![
                signed.signature,
                signed.signer.to_string(),
                signed.role.code(),
                id.to_string()
            ],
        )?;
        Ok(())
    }
}

impl Trust {
    /// Whether a certificate someone made for themselves is signed by the key it names.
    fn trusted_own(&self, certificate: &Certificate) -> bool {
        certificate.issuer_key == certificate.signing_key
            && signing::verify(
                &certificate.issuer_key,
                &self.payload(certificate),
                &certificate.signature,
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::Role;
    use crate::vault::{Kind, Revision};
    use serde_json::json;

    const PASSWORD: &str = "cone six oxidation";
    const ONE_TIME: &str = "pass this on";
    const BENS: &str = "bens own password";

    fn signed(revision: &Revision) -> (Uuid, SignedAs, SignatureCheck) {
        let signed = revision.signed.as_ref().expect("signed");
        (signed.by, signed.signed_as, signed.check)
    }

    fn team() -> (tempfile::TempDir, Vault, Uuid) {
        let dir = tempfile::tempdir().unwrap();
        let (mut ana, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        ana.grow_into_team("Ana").unwrap();
        let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        (dir, ana, shared)
    }

    /// Ben, a formulator on Shared, with his own password.
    fn add_ben(dir: &std::path::Path, ana: &mut Vault, shared: Uuid) -> Uuid {
        let ben = ana
            .add_person("Ben", ONE_TIME, &[(shared, Role::Formulator)])
            .unwrap()
            .id;
        Vault::unlock_as(dir, Some(ben), ONE_TIME)
            .unwrap()
            .set_own_password(BENS)
            .unwrap();
        ben
    }

    #[test]
    fn a_history_says_who_saved_each_revision_and_that_it_checks() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let me = vault.me().id;
        let first = vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
        let second = vault
            .save(Kind::Recipe, Some(first.revision_id), &json!({ "name": "Shino 2" }))
            .unwrap();
        assert_eq!(second.author, me);
        assert!(second.signed.is_none());
        let history = vault.history(Kind::Recipe, first.record_id).unwrap();
        assert!(
            history
                .iter()
                .all(|r| signed(r) == (me, SignedAs::Author, SignatureCheck::Good))
        );

        // Who saved it, or when, changed around the app, no longer checks.
        vault
            .conn
            .execute(
                "UPDATE revisions SET created_at = created_at + 1 WHERE id = ?1",
                params![first.revision_id.to_string()],
            )
            .unwrap();
        let history = vault.history(Kind::Recipe, first.record_id).unwrap();
        assert_eq!(signed(&history[1]).2, SignatureCheck::Bad);
        assert_eq!(signed(&history[0]).2, SignatureCheck::Good);
    }

    #[test]
    fn the_organization_certifies_the_keys_of_people_an_admin_adds() {
        let (dir, mut ana, shared) = team();
        let ben = add_ben(dir.path(), &mut ana, shared);
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben), BENS).unwrap();
        let saved = as_ben
            .save_in(Kind::Recipe, shared, &json!({ "name": "Ben's" }))
            .unwrap();
        drop(as_ben);
        let history = ana.history(Kind::Recipe, saved.record_id).unwrap();
        assert_eq!(signed(&history[0]), (ben, SignedAs::Author, SignatureCheck::Good));
        // Growing into a team certified Ana's key too, so what she saved alone still checks.
        let directory = Directory::load(&ana.conn).unwrap();
        assert_eq!(directory.organization_keys.len(), 1);
    }

    #[test]
    fn someone_from_before_signing_proves_their_key_and_an_admin_certifies_it() {
        let (dir, mut ana, shared) = team();
        let ana_id = ana.me().id;
        let ben = add_ben(dir.path(), &mut ana, shared);
        // As if Ben were added before keys were certified.
        ana.conn
            .execute(
                "DELETE FROM certificates WHERE person_id = ?1",
                params![ben.to_string()],
            )
            .unwrap();
        drop(ana);

        // Ben's unlock makes a certificate of his own, with proof; what he saves is signed, but
        // no admin has certified his key yet.
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben), BENS).unwrap();
        let saved = as_ben
            .save_in(Kind::Recipe, shared, &json!({ "name": "Ben's" }))
            .unwrap();
        let history = as_ben.history(Kind::Recipe, saved.record_id).unwrap();
        assert_eq!(signed(&history[0]).2, SignatureCheck::Unconfirmed);
        drop(as_ben);

        // Someone else with the database could put a key under Ben's name, signed by itself, but
        // cannot make the proof, so Ana's unlock does not certify it.
        let stranger = KeyPair::generate();
        let ana_view = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
        let organization = ana_view.organization_public_key().unwrap();
        let vault_id = ana_view.keyring.vault_id;
        let forged = match own_certificate(&vault_id, &stranger, ben, Some(&organization)) {
            Body::CertificateIssued {
                signing_key,
                issued_at,
                signature,
                proof,
                ..
            } => (signing_key, issued_at, signature, proof),
            _ => unreachable!(),
        };
        // Its encryption key is Ben's, as it would have to be; the proof cannot match it.
        let bens_key: Vec<u8> = ana_view
            .conn
            .query_row(
                "SELECT public_key FROM people WHERE id = ?1",
                params![ben.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        ana_view
            .conn
            .execute(
                "INSERT INTO certificates (id, person_id, signing_key, encryption_key, issued_at, issuer_key, signature, proof)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?3, ?6, ?7)",
                params![Uuid::new_v4().to_string(), ben.to_string(), forged.0, bens_key, forged.1, forged.2, forged.3],
            )
            .unwrap();
        drop(ana_view);

        let ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
        let history = ana.history(Kind::Recipe, saved.record_id).unwrap();
        assert_eq!(signed(&history[0]), (ben, SignedAs::Author, SignatureCheck::Good));
        let trust = ana.trust().unwrap();
        assert_eq!(trust.certified(ben, &forged.0), Some(false));
    }

    #[test]
    fn what_was_saved_before_signing_is_vouched_for_at_the_next_unlock() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let me = vault.me().id;
        let saved = vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
        vault
            .add_attachment(Kind::Recipe, saved.record_id, "image/png", b"tile")
            .unwrap();
        vault
            .conn
            .execute_batch(
                "UPDATE revisions SET signature = NULL, signer_id = NULL, signed_as = NULL;
                 UPDATE attachments SET signature = NULL, signer_id = NULL, signed_as = NULL;
                 UPDATE events SET signature = NULL, signer_id = NULL, signed_as = NULL;",
            )
            .unwrap();
        drop(vault);

        let vault = Vault::unlock(dir.path(), PASSWORD).unwrap();
        let history = vault.history(Kind::Recipe, saved.record_id).unwrap();
        assert_eq!(signed(&history[0]), (me, SignedAs::Attester, SignatureCheck::Good));
        for table in ["revisions", "attachments", "events"] {
            let unsigned: i64 = vault
                .conn
                .query_row(
                    &format!("SELECT count(*) FROM {table} WHERE signature IS NULL"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(unsigned, 0, "{table}");
        }
    }

    #[test]
    fn a_moved_revision_is_signed_by_whoever_moved_it() {
        let (dir, mut ana, shared) = team();
        let ana_id = ana.me().id;
        let production = ana.create_collection("Production").unwrap().id;
        let ben = add_ben(dir.path(), &mut ana, shared);
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben), BENS).unwrap();
        let saved = as_ben
            .save_in(Kind::Firing, shared, &json!({ "name": "Cone 10" }))
            .unwrap();
        let photo = as_ben
            .add_attachment(Kind::Firing, saved.record_id, "image/jpeg", b"tile")
            .unwrap();
        drop(as_ben);
        ana.move_records(&[(Kind::Firing, saved.record_id)], production)
            .unwrap();
        let history = ana.history(Kind::Firing, saved.record_id).unwrap();
        assert_eq!(history[0].author, ben);
        assert_eq!(signed(&history[0]), (ana_id, SignedAs::Mover, SignatureCheck::Good));
        let (signer, role): (String, String) = ana
            .conn
            .query_row(
                "SELECT signer_id, signed_as FROM attachments WHERE id = ?1",
                params![photo.id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((signer, role.as_str()), (ana_id.to_string(), "mover"));
    }

    #[test]
    fn a_new_organization_key_retires_the_old_one() {
        let (dir, mut ana, shared) = team();
        let ana_id = ana.me().id;
        let saved = ana.save_in(Kind::Recipe, shared, &json!({ "name": "Shino" })).unwrap();
        let ben = add_ben(dir.path(), &mut ana, shared);
        ana.make_admin(ben).unwrap();
        drop(ana);
        let mut ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
        let old_organization = KeyPair::from_secret(ana.organization.as_ref().unwrap().secret.clone()).unwrap();
        ana.take_admin_away(ben).unwrap();
        let retired: i64 = ana
            .conn
            .query_row(
                "SELECT count(*) FROM organization_keys WHERE retired_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retired, 1);
        // What the old key certified before stays good.
        let history = ana.history(Kind::Recipe, saved.record_id).unwrap();
        assert_eq!(signed(&history[0]).2, SignatureCheck::Good);

        // Ben kept the old organization key. A certificate he makes with it now is not trusted,
        // nor allowed as an event.
        let stranger = KeyPair::generate();
        let key = signing::public(&signing::person_key(&stranger));
        let vault_id = ana.keyring.vault_id;
        let forged = organization_certificate(&vault_id, &old_organization, ana_id, &key, &stranger.public);
        let as_ben = Signer::new(vault_id, ben, &stranger);
        assert!(events::record(&ana.conn, &as_ben, forged.clone()).is_err());
        let Body::CertificateIssued {
            issued_at,
            issuer_key,
            signature,
            ..
        } = forged
        else {
            unreachable!()
        };
        ana.conn
            .execute(
                "INSERT INTO certificates (id, person_id, signing_key, encryption_key, issued_at, issuer_key, signature)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![Uuid::new_v4().to_string(), ana_id.to_string(), key, stranger.public, issued_at, issuer_key, signature],
            )
            .unwrap();
        assert_eq!(ana.trust().unwrap().certified(ana_id, &key), Some(false));
    }
}
