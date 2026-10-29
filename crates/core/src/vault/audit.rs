//! The audit log (docs/adr/0019-signatures-and-audit-log.md): what people did, in order, each
//! entry chained to the one before by its hash and signed by whoever did it. It keeps ids, never
//! content: the admin's screen puts names back from what it can open. Erasing a record leaves its
//! entries.
//!
//! What was opened, printed and exported only the app can say, so those entries show what an honest
//! app did, not proof of what someone read. On one computer anyone with the database key could
//! write the log again; the LAN host will keep it, and sign it.

use super::signatures::SignatureCheck;
use super::{Kind, Vault, now_ms, parse_id};
use crate::error::{Error, Result};
use crate::signing::{self, Signer};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// One thing someone did, as the log keeps it.
pub(crate) struct Entry<'a> {
    pub action: &'a str,
    pub kind: Option<Kind>,
    pub record: Option<Uuid>,
    pub collection: Option<Uuid>,
    pub detail: Option<String>,
}

impl<'a> Entry<'a> {
    pub fn new(action: &'a str) -> Entry<'a> {
        Entry {
            action,
            kind: None,
            record: None,
            collection: None,
            detail: None,
        }
    }

    pub fn of(action: &'a str, kind: Kind, record: Uuid, collection: Uuid) -> Entry<'a> {
        Entry {
            kind: Some(kind),
            record: Some(record),
            collection: Some(collection),
            ..Entry::new(action)
        }
    }

    pub fn detail(self, detail: impl Into<String>) -> Entry<'a> {
        Entry {
            detail: Some(detail.into()),
            ..self
        }
    }
}

/// The hash the first entry chains on.
const START: [u8; 32] = [0; 32];

/// Adds an entry at the end of the log, by `signer`, in the caller's transaction if there is one.
pub(crate) fn note(conn: &Connection, signer: &Signer, entry: Entry) -> Result<()> {
    let previous: Vec<u8> = conn
        .query_row("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1", [], |row| row.get(0))
        .optional()?
        .unwrap_or_else(|| START.to_vec());
    let (id, at) = (Uuid::new_v4(), now_ms());
    let kind = entry.kind.map(Kind::as_str);
    let payload = signing::audit_payload(
        &signer.vault,
        &id,
        at,
        Some(&signer.person),
        entry.action,
        kind,
        entry.record.as_ref(),
        entry.collection.as_ref(),
        entry.detail.as_deref(),
    );
    let hash = signing::audit_hash(&previous, &payload);
    let signature = signer.sign(&signing::audit_signature_payload(&signer.vault, &hash));
    conn.execute(
        "INSERT INTO audit (id, at, person_id, action, kind, record_id, collection_id, detail, prev_hash, hash, signature)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            id.to_string(),
            at,
            signer.person.to_string(),
            entry.action,
            kind,
            entry.record.map(|r| r.to_string()),
            entry.collection.map(|c| c.to_string()),
            entry.detail,
            previous,
            hash,
            signature
        ],
    )?;
    Ok(())
}

/// What the page tells the log, which only it knows: a record opened, a record printed, or
/// records exported.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Note {
    /// Noted once a sign-in, however often it is opened.
    Opened { kind: Kind, record: Uuid },
    /// With what was printed, such as a batch size.
    Printed {
        kind: Kind,
        record: Uuid,
        detail: Option<String>,
    },
    /// What was exported: the format and how many records.
    Exported { detail: String },
    /// A record someone else had checked out, taken over from them (plan section 3.5).
    TookOver { kind: Kind, record: Uuid, from: Uuid },
}

/// One entry, for an admin's screen.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub seq: i64,
    pub at: i64,
    pub person: Option<Uuid>,
    pub action: String,
    pub kind: Option<Kind>,
    pub record: Option<Uuid>,
    pub collection: Option<Uuid>,
    pub detail: Option<String>,
    /// Whether its signature is its person's, by a key certified as theirs.
    pub check: SignatureCheck,
}

/// The log, newest first, and whether its chain is whole: no entry changed, taken out or put in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLog {
    pub entries: Vec<AuditEntry>,
    pub intact: bool,
}

impl Vault {
    /// Notes what the page did. Opening a record is noted once a sign-in.
    pub fn note(&mut self, what: Note) -> Result<()> {
        let entry = match what {
            Note::Opened { kind, record } => {
                if !self.opened.insert(record) {
                    return Ok(());
                }
                Entry::of("opened", kind, record, self.collection_of(kind, record)?)
            }
            Note::Printed { kind, record, detail } => {
                let entry = Entry::of("printed", kind, record, self.collection_of(kind, record)?);
                match detail {
                    Some(detail) => entry.detail(detail),
                    None => entry,
                }
            }
            Note::Exported { detail } => Entry::new("exported").detail(detail),
            Note::TookOver { kind, record, from } => {
                Entry::of("took-over", kind, record, self.collection_of(kind, record)?).detail(format!("person {from}"))
            }
        };
        note(&self.conn, &self.signer, entry)
    }

    /// The collection a record this person can open is in.
    fn collection_of(&self, kind: Kind, record: Uuid) -> Result<Uuid> {
        let collection: String = self
            .conn
            .query_row(
                "SELECT collection_id FROM revisions WHERE record_id = ?1 AND kind = ?2 LIMIT 1",
                params![record.to_string(), kind.as_str()],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        let collection = parse_id(&collection)?;
        self.readable(&collection)?;
        Ok(collection)
    }

    /// The audit log, newest first, `limit` entries or all of them: for an admin, or a one-person
    /// vault's person. The whole chain is checked; each entry's signature too.
    pub fn audit_log(&self, limit: Option<usize>) -> Result<AuditLog> {
        if self.is_team() {
            self.admin()?;
        }
        type Row = (
            i64,
            String,
            i64,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Vec<u8>,
            Vec<u8>,
            Option<Vec<u8>>,
        );
        let rows = self
            .conn
            .prepare(
                "SELECT seq, id, at, person_id, action, kind, record_id, collection_id, detail, prev_hash, hash, signature
                 FROM audit ORDER BY seq",
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
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<Row>>>()?;
        let vault = self.keyring.vault_id;
        let trust = self.trust()?;
        let shown = limit.unwrap_or(rows.len());
        let first_shown = rows.len().saturating_sub(shown);
        let mut previous = START.to_vec();
        let mut intact = true;
        let mut entries = Vec::new();
        for (index, row) in rows.into_iter().enumerate() {
            let (seq, id, at, person, action, kind, record, collection, detail, prev_hash, hash, signature) = row;
            let (id, person, record, collection) = (
                parse_id(&id)?,
                person.as_deref().map(parse_id).transpose()?,
                record.as_deref().map(parse_id).transpose()?,
                collection.as_deref().map(parse_id).transpose()?,
            );
            let payload = signing::audit_payload(
                &vault,
                &id,
                at,
                person.as_ref(),
                &action,
                kind.as_deref(),
                record.as_ref(),
                collection.as_ref(),
                detail.as_deref(),
            );
            intact &= prev_hash == previous && signing::audit_hash(&prev_hash, &payload) == hash;
            if index >= first_shown {
                let check = match (person, signature) {
                    (Some(person), Some(signature)) => {
                        let signed = super::events::SignedBy {
                            signature,
                            signer: person,
                            role: signing::As::Author,
                        };
                        trust
                            .check(&signed, &signing::audit_signature_payload(&vault, &hash))
                            .check
                    }
                    _ => SignatureCheck::Unconfirmed,
                };
                entries.push(AuditEntry {
                    seq,
                    at,
                    person,
                    action,
                    kind: kind.as_deref().and_then(Kind::parse),
                    record,
                    collection,
                    detail,
                    check,
                });
            }
            previous = hash;
        }
        entries.reverse();
        Ok(AuditLog { entries, intact })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::Role;
    use serde_json::json;

    const PASSWORD: &str = "cone six oxidation";
    const ONE_TIME: &str = "pass this on";

    fn actions(log: &AuditLog) -> Vec<&str> {
        log.entries.iter().rev().map(|e| e.action.as_str()).collect()
    }

    #[test]
    fn the_log_keeps_what_was_done_in_a_signed_chain() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let saved = vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
        for _ in 0..2 {
            vault
                .note(Note::Opened {
                    kind: Kind::Recipe,
                    record: saved.record_id,
                })
                .unwrap();
        }
        vault
            .note(Note::Printed {
                kind: Kind::Recipe,
                record: saved.record_id,
                detail: Some("5000 g".into()),
            })
            .unwrap();
        vault
            .note(Note::Exported {
                detail: "1 recipe as JSON".into(),
            })
            .unwrap();
        let gone = vault.delete(Kind::Recipe, saved.revision_id).unwrap();
        vault.erase(Kind::Recipe, gone.record_id).unwrap();

        let log = vault.audit_log(None).unwrap();
        assert!(log.intact);
        assert_eq!(
            actions(&log),
            [
                "created",
                "person-added",
                "collection-created",
                "grant-set",
                "certificate-issued",
                "saved",
                "opened",
                "printed",
                "exported",
                "deleted",
                "erased"
            ]
        );
        assert!(log.entries.iter().all(|e| e.check == SignatureCheck::Good));
        assert!(log.entries.iter().all(|e| e.person == Some(vault.me().id)));
        // The erased record's entries stay, with its id and nothing it held.
        let printed = log.entries.iter().find(|e| e.action == "printed").unwrap();
        assert_eq!(printed.record, Some(saved.record_id));
        assert_eq!(printed.detail.as_deref(), Some("5000 g"));
        assert_eq!(vault.audit_log(Some(2)).unwrap().entries.len(), 2);

        // Each unlock is noted.
        drop(vault);
        let vault = Vault::unlock(dir.path(), PASSWORD).unwrap();
        assert_eq!(vault.audit_log(Some(1)).unwrap().entries[0].action, "signed-in");
    }

    #[test]
    fn an_entry_changed_or_taken_out_breaks_the_chain() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
        vault.save(Kind::Recipe, None, &json!({ "name": "Tenmoku" })).unwrap();
        let action: String = vault
            .conn
            .query_row("SELECT action FROM audit WHERE seq = 2", [], |row| row.get(0))
            .unwrap();
        vault
            .conn
            .execute("UPDATE audit SET action = 'opened' WHERE seq = 2", [])
            .unwrap();
        assert!(!vault.audit_log(None).unwrap().intact);
        vault
            .conn
            .execute("UPDATE audit SET action = ?1 WHERE seq = 2", params![action])
            .unwrap();
        assert!(vault.audit_log(None).unwrap().intact);
        vault.conn.execute("DELETE FROM audit WHERE seq = 2", []).unwrap();
        assert!(!vault.audit_log(None).unwrap().intact);
    }

    #[test]
    fn in_a_team_only_admins_read_the_log_and_it_names_who_changed_what() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ana, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        ana.grow_into_team("Ana").unwrap();
        let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
        let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
        as_ben.set_own_password("bens own password").unwrap();
        assert!(matches!(as_ben.audit_log(None), Err(Error::NotAllowed)));
        drop(as_ben);

        let log = ana.audit_log(None).unwrap();
        assert!(log.intact);
        let added = log.entries.iter().find(|e| e.action == "person-added").unwrap();
        assert_eq!(added.detail.as_deref(), Some(format!("person {}", ben.id).as_str()));
        assert!(
            log.entries
                .iter()
                .any(|e| e.action == "signed-in" && e.person == Some(ben.id))
        );
        assert!(log.entries.iter().all(|e| e.check == SignatureCheck::Good));
    }
}
