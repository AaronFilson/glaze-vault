//! The change log's items as the host and replicas send them (sync.rs): read from the tables,
//! checked, and written back, without any collection key. The host (host.rs) and each replica
//! (replica.rs) share these, so both check the same things.

use super::events::{Event, SignedBy};
use super::signatures::Trust;
use super::{Kind, parse_id};
use crate::error::{Error, Result};
use crate::signing::{self, As, AttachmentFacts, RevisionFacts};
use crate::store;
use crate::sync::{AttachmentItem, EntryItem, EventItem, ItemSignature, Refusal, RevisionItem, SummaryItem};
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

fn signature(signature: Option<Vec<u8>>, signer: Option<String>, role: Option<String>) -> Result<ItemSignature> {
    match (signature, signer, role) {
        (Some(signature), Some(signer), Some(signed_as)) => Ok(ItemSignature {
            signature,
            signer: parse_id(&signer)?,
            signed_as,
        }),
        _ => Err(Error::Corrupt("an item to send is not signed".into())),
    }
}

/// A stored revision as an item. `stripped` leaves out its nonce and ciphertext, for a computer
/// that reads only its summary.
pub(super) fn revision_item(conn: &Connection, id: &str, stripped: bool) -> Result<RevisionItem> {
    type Row = (
        String,
        String,
        String,
        String,
        Option<String>,
        i64,
        bool,
        Option<String>,
        i64,
        String,
        i64,
        Vec<u8>,
        Vec<u8>,
        Option<Vec<u8>>,
        Option<Vec<u8>>,
        Option<Vec<u8>>,
        (Option<Vec<u8>>, Option<String>, Option<String>),
    );
    let row: Row = conn.query_row(
        "SELECT id, record_id, kind, collection_id, parent_id, number, deleted, supersedes, epoch, author_id,
                created_at, nonce, ciphertext, content_hash, summary_nonce, summary, signature, signer_id, signed_as
         FROM revisions WHERE id = ?1",
        params![id],
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
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                row.get(12)?,
                row.get(13)?,
                row.get(14)?,
                row.get(15)?,
                (row.get(16)?, row.get(17)?, row.get(18)?),
            ))
        },
    )?;
    let (
        id,
        record,
        kind,
        collection,
        parent,
        number,
        deleted,
        supersedes,
        epoch,
        author,
        created_at,
        nonce,
        ciphertext,
        content_hash,
        summary_nonce,
        summary,
        signed,
    ) = row;
    Ok(RevisionItem {
        id: parse_id(&id)?,
        record: parse_id(&record)?,
        kind: Kind::parse(&kind).ok_or_else(|| Error::Corrupt(format!("unknown kind {kind}")))?,
        collection: parse_id(&collection)?,
        parent: parent.as_deref().map(parse_id).transpose()?,
        number,
        deleted,
        supersedes,
        epoch,
        author: parse_id(&author)?,
        created_at,
        content_hash: content_hash.unwrap_or_else(|| store::content_hash(&nonce, &ciphertext)),
        nonce: if stripped { Vec::new() } else { nonce },
        ciphertext: if stripped { Vec::new() } else { ciphertext },
        summary: summary_nonce
            .zip(summary)
            .map(|(nonce, summary)| SummaryItem { nonce, summary }),
        signed: signature(signed.0, signed.1, signed.2)?,
    })
}

pub(super) fn attachment_item(conn: &Connection, id: &str) -> Result<AttachmentItem> {
    type Row = (
        String,
        String,
        String,
        String,
        String,
        i64,
        String,
        i64,
        i64,
        Vec<u8>,
        Vec<u8>,
        Option<Vec<u8>>,
        (Option<Vec<u8>>, Option<String>, Option<String>),
    );
    let row: Row = conn.query_row(
        "SELECT id, record_id, kind, collection_id, media_type, size, author_id, created_at, epoch, nonce, ciphertext,
                sha256, signature, signer_id, signed_as
         FROM attachments WHERE id = ?1",
        params![id],
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
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
                row.get(11)?,
                (row.get(12)?, row.get(13)?, row.get(14)?),
            ))
        },
    )?;
    let (id, record, kind, collection, media_type, size, author, created_at, epoch, nonce, ciphertext, sha256, signed) =
        row;
    Ok(AttachmentItem {
        id: parse_id(&id)?,
        record: parse_id(&record)?,
        kind: Kind::parse(&kind).ok_or_else(|| Error::Corrupt(format!("unknown kind {kind}")))?,
        collection: parse_id(&collection)?,
        media_type,
        size,
        author: parse_id(&author)?,
        created_at,
        epoch,
        sha256: sha256.unwrap_or_else(|| store::attachment_hash(&nonce, &ciphertext)),
        nonce,
        ciphertext,
        signed: signature(signed.0, signed.1, signed.2)?,
    })
}

pub(super) fn event_item(conn: &Connection, id: &str) -> Result<EventItem> {
    type Row = (
        String,
        Option<String>,
        i64,
        String,
        Option<Vec<u8>>,
        Option<String>,
        Option<String>,
    );
    let (id, actor, at, body, sig, signer, role): Row = conn.query_row(
        "SELECT id, actor_id, created_at, body, signature, signer_id, signed_as FROM events WHERE id = ?1",
        params![id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        },
    )?;
    Ok(EventItem {
        id: parse_id(&id)?,
        actor: actor.as_deref().map(parse_id).transpose()?,
        at,
        body,
        signed: signature(sig, signer, role)?,
    })
}

pub(super) fn entry_item(conn: &Connection, person: &str) -> Result<EntryItem> {
    let (entry, at, signer, signature): (String, i64, String, Vec<u8>) = conn.query_row(
        "SELECT entry, at, signer_id, signature FROM key_entries WHERE person_id = ?1",
        params![person],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    Ok(EntryItem {
        person: parse_id(person)?,
        entry,
        at,
        signer: parse_id(&signer)?,
        signature,
    })
}

pub(super) fn signed_by(signature: &ItemSignature) -> std::result::Result<SignedBy, Refusal> {
    Ok(SignedBy {
        signature: signature.signature.clone(),
        signer: signature.signer,
        role: As::parse(&signature.signed_as).ok_or_else(|| Refusal::Invalid {
            reason: format!("signed as {}", signature.signed_as),
        })?,
    })
}

pub(super) fn revision_payload(vault: &Uuid, item: &RevisionItem, signed: &SignedBy) -> Vec<u8> {
    let facts = RevisionFacts {
        vault,
        id: &item.id,
        record: &item.record,
        kind: item.kind.as_str(),
        collection: &item.collection,
        epoch: item.epoch,
        number: item.number,
        parent: item.parent.as_ref(),
        deleted: item.deleted,
        supersedes: item.supersedes.as_deref(),
        author: &item.author,
        at: item.created_at,
        content_hash: &item.content_hash,
        summary: item
            .summary
            .as_ref()
            .map(|s| (s.nonce.as_slice(), s.summary.as_slice())),
    };
    signing::revision_payload(&facts, signed.role, &signed.signer)
}

pub(super) fn attachment_payload(vault: &Uuid, item: &AttachmentItem, signed: &SignedBy) -> Vec<u8> {
    let facts = AttachmentFacts {
        vault,
        id: &item.id,
        record: &item.record,
        kind: item.kind.as_str(),
        collection: &item.collection,
        epoch: item.epoch,
        media_type: &item.media_type,
        size: item.size,
        author: &item.author,
        at: item.created_at,
        sha256: &item.sha256,
    };
    signing::attachment_payload(&facts, signed.role, &signed.signer)
}

/// An event item as the event it is, its body as it came.
pub(super) fn event_of(item: &EventItem) -> std::result::Result<Event, Refusal> {
    let body = serde_json::from_str(&item.body).map_err(|e| Refusal::Invalid { reason: e.to_string() })?;
    Ok(Event {
        id: item.id,
        actor: item.actor,
        at: item.at,
        body,
        json: item.body.clone(),
        signed: Some(signed_by(&item.signed)?),
    })
}

/// Whether a revision's hash is of its nonce and ciphertext, which a stripped one leaves out.
fn content_checks(item: &RevisionItem) -> bool {
    item.ciphertext.is_empty() && item.nonce.is_empty()
        || store::content_hash(&item.nonce, &item.ciphertext) == item.content_hash
}

/// Checks a revision as a replica does: its content is what was signed, and the signature is the
/// signer's. A key no admin has certified yet is let through: the host took it.
pub(super) fn verify_revision(trust: &Trust, vault: &Uuid, item: &RevisionItem) -> Result<()> {
    let signed = signed_by(&item.signed).map_err(|_| Error::BadSignature)?;
    if !content_checks(item) || bad(trust, &signed, &revision_payload(vault, item, &signed)) {
        return Err(Error::BadSignature);
    }
    Ok(())
}

pub(super) fn verify_attachment(trust: &Trust, vault: &Uuid, item: &AttachmentItem) -> Result<()> {
    let signed = signed_by(&item.signed).map_err(|_| Error::BadSignature)?;
    if store::attachment_hash(&item.nonce, &item.ciphertext) != item.sha256
        || bad(trust, &signed, &attachment_payload(vault, item, &signed))
    {
        return Err(Error::BadSignature);
    }
    Ok(())
}

pub(super) fn verify_event(trust: &Trust, vault: &Uuid, event: &Event) -> Result<()> {
    let signed = event.signed.as_ref().ok_or(Error::BadSignature)?;
    if bad(trust, signed, &event.payload(vault, signed.role, &signed.signer)) {
        return Err(Error::BadSignature);
    }
    Ok(())
}

fn bad(trust: &Trust, signed: &SignedBy, payload: &[u8]) -> bool {
    trust.check(signed, payload).check == super::SignatureCheck::Bad
}

/// The host's checks of a revision's content and signature: the content is what was signed, and
/// the signer's key is certified now.
pub(super) fn check_revision(
    trust: &Trust,
    vault: &Uuid,
    item: &RevisionItem,
) -> std::result::Result<SignedBy, Refusal> {
    let signed = signed_by(&item.signed)?;
    if item.ciphertext.is_empty() || !content_checks(item) {
        return Err(Refusal::BadSignature);
    }
    trust.check_now(&signed, &revision_payload(vault, item, &signed))?;
    Ok(signed)
}

pub(super) fn check_attachment(
    trust: &Trust,
    vault: &Uuid,
    item: &AttachmentItem,
) -> std::result::Result<SignedBy, Refusal> {
    let signed = signed_by(&item.signed)?;
    if store::attachment_hash(&item.nonce, &item.ciphertext) != item.sha256 {
        return Err(Refusal::BadSignature);
    }
    trust.check_now(&signed, &attachment_payload(vault, item, &signed))?;
    Ok(signed)
}

/// Writes a revision as it came, without logging it.
pub(super) fn store_revision(conn: &Connection, item: &RevisionItem) -> Result<()> {
    let (summary_nonce, summary) = item
        .summary
        .as_ref()
        .map(|s| (s.nonce.clone(), s.summary.clone()))
        .unzip();
    conn.execute(
        "INSERT INTO revisions (id, record_id, kind, parent_id, number, collection_id, author_id, created_at, nonce,
             ciphertext, deleted, summary_nonce, summary, epoch, supersedes, signature, signer_id, signed_as, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        params![
            item.id.to_string(),
            item.record.to_string(),
            item.kind.as_str(),
            item.parent.map(|p| p.to_string()),
            item.number,
            item.collection.to_string(),
            item.author.to_string(),
            item.created_at,
            item.nonce,
            item.ciphertext,
            item.deleted,
            summary_nonce,
            summary,
            item.epoch,
            item.supersedes,
            item.signed.signature,
            item.signed.signer.to_string(),
            item.signed.signed_as,
            item.content_hash,
        ],
    )?;
    Ok(())
}

pub(super) fn store_attachment(conn: &Connection, item: &AttachmentItem) -> Result<()> {
    conn.execute(
        "INSERT INTO attachments (id, record_id, kind, collection_id, media_type, size, author_id, created_at, nonce,
             ciphertext, epoch, sha256, signature, signer_id, signed_as)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            item.id.to_string(),
            item.record.to_string(),
            item.kind.as_str(),
            item.collection.to_string(),
            item.media_type,
            item.size,
            item.author.to_string(),
            item.created_at,
            item.nonce,
            item.ciphertext,
            item.epoch,
            item.sha256,
            item.signed.signature,
            item.signed.signer.to_string(),
            item.signed.signed_as,
        ],
    )?;
    Ok(())
}

/// Adds a revision or an attachment to the change log, with the host's number when it has one.
/// Returns this store's number for it.
pub(super) fn log(
    conn: &Connection,
    item: &str,
    id: &Uuid,
    collection: &Uuid,
    kind: Kind,
    host_seq: Option<i64>,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO changes (item, item_id, collection_id, kind, host_seq) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![item, id.to_string(), collection.to_string(), kind.as_str(), host_seq],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Whether a row with this id is stored already, in a table.
pub(super) fn exists(conn: &Connection, table: &str, id: &Uuid) -> Result<bool> {
    Ok(conn
        .query_row(
            &format!("SELECT 1 FROM {table} WHERE id = ?1"),
            params![id.to_string()],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}
