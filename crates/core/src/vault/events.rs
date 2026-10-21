//! The directory as events (docs/adr/0018-directory-events.md): every change to people, admins,
//! collections, grants and roles, and every record erased or moved, is an event. One function,
//! [`apply`], writes an event to the tables, so the vault on one computer, the LAN host and its
//! replicas all change their tables the same way, and [`record`] checks it first with the same
//! check (access.rs). Events are kept, in the change log's order, and never changed.

use super::{Kind, now_ms, parse_id, parse_role};
use crate::access::{Directory, Role};
use crate::crypto::SealedBox;
use crate::error::{Error, Result};
use crate::keyring::Keyring;
use crate::signing::{self, As, Signer};
use crate::vault::{Capabilities, CustomRole, atomically, audit, roles};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// One change, made by `actor` at `at`. Events made from what a vault held before it kept them
/// have no actor.
pub(crate) struct Event {
    pub id: Uuid,
    pub actor: Option<Uuid>,
    pub at: i64,
    pub body: Body,
    /// The body as JSON, as it was made: what is kept and what a signature covers.
    pub json: String,
    pub signed: Option<SignedBy>,
}

/// A signature over an item, whose key made it, and in what capacity (ADR 19).
#[derive(Clone)]
pub(crate) struct SignedBy {
    pub signature: Vec<u8>,
    pub signer: Uuid,
    pub role: As,
}

impl Event {
    /// A new event, not signed yet.
    pub fn new(actor: Option<Uuid>, at: i64, body: Body) -> Result<Event> {
        let json = serde_json::to_string(&body)?;
        Ok(Event {
            id: Uuid::new_v4(),
            actor,
            at,
            body,
            json,
            signed: None,
        })
    }

    /// What a signature over the event covers.
    pub fn payload(&self, vault: &Uuid, role: As, signer: &Uuid) -> Vec<u8> {
        signing::event_payload(
            vault,
            &self.id,
            self.body.name(),
            self.actor.as_ref(),
            self.body.collection().as_ref(),
            self.at,
            &self.json,
            role,
            signer,
        )
    }
}

/// What an event changes. Kept as JSON, as it was made: the stored text is never written again.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub(crate) enum Body {
    /// Someone joins the vault: the first person when it is made, or someone an admin adds. Their
    /// key file entry is not here: each store keeps its own key file.
    PersonAdded {
        person: Uuid,
        name: String,
        #[serde(with = "crate::crypto::b64")]
        public_key: Vec<u8>,
    },
    /// Someone has new keys: an admin reset them, or the organization's recovery key did.
    PersonKeysChanged {
        person: Uuid,
        #[serde(with = "crate::crypto::b64")]
        public_key: Vec<u8>,
    },
    /// Someone leaves, with every grant they had.
    PersonRemoved {
        person: Uuid,
    },
    AdminGiven {
        person: Uuid,
    },
    /// Admin taken away; the organization has a new key, whose public half this is.
    AdminTaken {
        person: Uuid,
        #[serde(with = "crate::crypto::b64")]
        organization_key: Vec<u8>,
    },
    /// A one-person vault grows into a team's, its person named and made its first admin.
    TeamFormed {
        person: Uuid,
        name: String,
        #[serde(with = "crate::crypto::b64")]
        public_key: Vec<u8>,
        #[serde(with = "crate::crypto::b64")]
        organization_key: Vec<u8>,
    },
    /// A team's vault goes back to its actor's alone (ADR 6): everyone else leaves, the private
    /// collections they leave behind get these names, and the organization goes.
    TeamDisbanded {
        renamed: Vec<Renamed>,
    },
    CollectionCreated {
        collection: Uuid,
        name: String,
        owner: Option<Uuid>,
    },
    CollectionRenamed {
        collection: Uuid,
        name: String,
    },
    /// A collection's new key epoch (ADR 17), its key wrapping the one before, three times. The
    /// grants sealed at it follow, each its own event.
    KeyEpoch {
        collection: Uuid,
        epoch: i64,
        #[serde(with = "crate::crypto::b64")]
        previous: Vec<u8>,
        #[serde(with = "crate::crypto::b64")]
        previous_batch: Vec<u8>,
        #[serde(with = "crate::crypto::b64")]
        previous_summary: Vec<u8>,
    },
    /// A person's role on a collection, and the key it gives them, sealed to them at an epoch: a
    /// new grant, a changed one, or one sealed again.
    GrantSet {
        person: Uuid,
        collection: Uuid,
        role: Role,
        epoch: i64,
        sealed: SealedBox,
    },
    GrantRemoved {
        person: Uuid,
        collection: Uuid,
    },
    /// A collection's key sealed to the organization, which admins hold.
    OrganizationGrantSet {
        collection: Uuid,
        epoch: i64,
        sealed: SealedBox,
    },
    /// That a signing key and an encryption key are a person's (signing.rs): issued by the
    /// organization, whose key `issuer_key` is, or by the person for themselves, with `proof`
    /// that they hold the person's secret in a team's vault.
    CertificateIssued {
        certificate: Uuid,
        person: Uuid,
        #[serde(with = "crate::crypto::b64")]
        signing_key: Vec<u8>,
        #[serde(with = "crate::crypto::b64")]
        encryption_key: Vec<u8>,
        issued_at: i64,
        #[serde(with = "crate::crypto::b64")]
        issuer_key: Vec<u8>,
        #[serde(with = "crate::crypto::b64")]
        signature: Vec<u8>,
        #[serde(default, with = "crate::crypto::b64_option", skip_serializing_if = "Option::is_none")]
        proof: Option<Vec<u8>>,
    },
    /// The organization's signing key, and its encryption key, signed with the signing key: the
    /// key certificates are trusted by.
    OrganizationKeyAdded {
        #[serde(with = "crate::crypto::b64")]
        signing_key: Vec<u8>,
        #[serde(with = "crate::crypto::b64")]
        encryption_key: Vec<u8>,
        #[serde(with = "crate::crypto::b64")]
        signature: Vec<u8>,
    },
    RoleCreated {
        role: CustomRole,
    },
    RoleChanged {
        role: CustomRole,
    },
    RoleDeleted {
        role: Uuid,
    },
    /// A deleted record erased (ADR 9): its revisions and attachments go, and its tombstone stays.
    Erased {
        record: Uuid,
        kind: Kind,
        collection: Uuid,
    },
    /// A record moved to another collection. Its revisions and attachments, encrypted again for
    /// it, follow in the change log.
    Moved {
        record: Uuid,
        kind: Kind,
        from: Uuid,
        to: Uuid,
    },
}

/// A private collection a team leaves behind when it goes back to one person, and its new name.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Renamed {
    pub collection: Uuid,
    pub name: String,
}

impl Body {
    /// The event's type, as its JSON names it.
    fn name(&self) -> &'static str {
        match self {
            Body::PersonAdded { .. } => "person-added",
            Body::PersonKeysChanged { .. } => "person-keys-changed",
            Body::PersonRemoved { .. } => "person-removed",
            Body::AdminGiven { .. } => "admin-given",
            Body::AdminTaken { .. } => "admin-taken",
            Body::TeamFormed { .. } => "team-formed",
            Body::TeamDisbanded { .. } => "team-disbanded",
            Body::CollectionCreated { .. } => "collection-created",
            Body::CollectionRenamed { .. } => "collection-renamed",
            Body::KeyEpoch { .. } => "key-epoch",
            Body::GrantSet { .. } => "grant-set",
            Body::GrantRemoved { .. } => "grant-removed",
            Body::OrganizationGrantSet { .. } => "organization-grant-set",
            Body::CertificateIssued { .. } => "certificate-issued",
            Body::OrganizationKeyAdded { .. } => "organization-key-added",
            Body::RoleCreated { .. } => "role-created",
            Body::RoleChanged { .. } => "role-changed",
            Body::RoleDeleted { .. } => "role-deleted",
            Body::Erased { .. } => "erased",
            Body::Moved { .. } => "moved",
        }
    }

    /// The collection the event is about, if any: for the LAN host to choose who gets it.
    fn collection(&self) -> Option<Uuid> {
        match self {
            Body::CollectionCreated { collection, .. }
            | Body::CollectionRenamed { collection, .. }
            | Body::KeyEpoch { collection, .. }
            | Body::GrantSet { collection, .. }
            | Body::GrantRemoved { collection, .. }
            | Body::OrganizationGrantSet { collection, .. }
            | Body::Erased { collection, .. } => Some(*collection),
            Body::Moved { to, .. } => Some(*to),
            _ => None,
        }
    }

    /// Where the event goes in the change log: the directory's scope (None), or a collection's.
    /// A new key epoch and an erasure are in their collection's, before what uses them; a move is
    /// in both collections', so those who read only the one it left learn it went.
    fn scopes(&self) -> Vec<Option<Uuid>> {
        match self {
            Body::KeyEpoch { collection, .. } | Body::Erased { collection, .. } => vec![Some(*collection)],
            Body::Moved { from, to, .. } => vec![Some(*from), Some(*to)],
            _ => vec![None],
        }
    }

    /// What the audit log keeps of the event: ids, and never the keys or names it carries.
    fn audit_entry(&self) -> audit::Entry<'static> {
        match self {
            Body::Erased {
                record,
                kind,
                collection,
            } => audit::Entry::of("erased", *kind, *record, *collection),
            Body::Moved { record, kind, from, to } => {
                audit::Entry::of("moved", *kind, *record, *to).detail(format!("from {from}"))
            }
            _ => {
                let subject = match self {
                    Body::PersonAdded { person, .. }
                    | Body::PersonKeysChanged { person, .. }
                    | Body::PersonRemoved { person }
                    | Body::AdminGiven { person }
                    | Body::AdminTaken { person, .. }
                    | Body::TeamFormed { person, .. }
                    | Body::GrantSet { person, .. }
                    | Body::GrantRemoved { person, .. }
                    | Body::CertificateIssued { person, .. } => Some(format!("person {person}")),
                    Body::RoleCreated { role } | Body::RoleChanged { role } => Some(format!("role {}", role.id)),
                    Body::RoleDeleted { role } => Some(format!("role {role}")),
                    _ => None,
                };
                let entry = audit::Entry {
                    collection: self.collection(),
                    ..audit::Entry::new(self.name())
                };
                match subject {
                    Some(subject) => entry.detail(subject),
                    None => entry,
                }
            }
        }
    }

    /// The kind of record an erasure or a move is of.
    fn record_kind(&self) -> Option<Kind> {
        match self {
            Body::Erased { kind, .. } | Body::Moved { kind, .. } => Some(*kind),
            _ => None,
        }
    }
}

/// Checks that the signer may make a change, against the directory as it is in `conn`, signs it
/// and applies it. Several in one transaction each see the ones before.
pub(crate) fn record(conn: &Connection, signer: &Signer, body: Body) -> Result<()> {
    Directory::load(conn)?.check(signer.person, &body)?;
    let mut event = Event::new(Some(signer.person), now_ms(), body)?;
    let payload = event.payload(&signer.vault, As::Author, &signer.person);
    event.signed = Some(SignedBy {
        signature: signer.sign(&payload),
        signer: signer.person,
        role: As::Author,
    });
    atomically(conn, |conn| {
        apply(conn, &event)?;
        audit::note(conn, signer, event.body.audit_entry())
    })
}

/// Keeps an event, adds it to the change log, and writes what it changes to the tables. It does
/// not check it: [`record`] does, and so will the LAN host before it applies what it is sent.
pub(crate) fn apply(conn: &Connection, event: &Event) -> Result<()> {
    keep(conn, event)?;
    for scope in event.body.scopes() {
        log(conn, event, scope, None)?;
    }
    let at = event.at;
    let actor = || {
        event
            .actor
            .ok_or_else(|| Error::Corrupt(format!("event {} has no actor", event.id)))
    };
    match &event.body {
        Body::PersonAdded {
            person,
            name,
            public_key,
        } => insert_person(conn, *person, name, public_key, false, at)?,
        Body::PersonKeysChanged { person, public_key } => {
            conn.execute(
                "UPDATE people SET public_key = ?1 WHERE id = ?2",
                params![public_key, person.to_string()],
            )?;
            // Certificates of the keys they had no longer hold.
            conn.execute(
                "UPDATE certificates SET revoked_at = ?1
                 WHERE person_id = ?2 AND encryption_key != ?3 AND revoked_at IS NULL",
                params![at, person.to_string(), public_key],
            )?;
        }
        Body::PersonRemoved { person } => {
            conn.execute("DELETE FROM grants WHERE user_id = ?1", params![person.to_string()])?;
            conn.execute(
                "UPDATE people SET removed_at = ?1 WHERE id = ?2",
                params![at, person.to_string()],
            )?;
            conn.execute(
                "UPDATE certificates SET revoked_at = ?1 WHERE person_id = ?2 AND revoked_at IS NULL",
                params![at, person.to_string()],
            )?;
        }
        Body::AdminGiven { person } => set_admin(conn, person, true)?,
        Body::AdminTaken { person, .. } => set_admin(conn, person, false)?,
        Body::TeamFormed {
            person,
            name,
            public_key,
            ..
        } => {
            conn.execute(
                "UPDATE people SET name = ?1, public_key = ?2, admin = 1 WHERE id = ?3",
                params![name, public_key, person.to_string()],
            )?;
        }
        Body::TeamDisbanded { renamed } => {
            let actor = actor()?.to_string();
            for shelf in renamed {
                conn.execute(
                    "UPDATE collections SET name = ?1, owner_id = NULL WHERE id = ?2",
                    params![shelf.name, shelf.collection.to_string()],
                )?;
            }
            conn.execute("DELETE FROM grants WHERE user_id != ?1", params![actor])?;
            conn.execute(
                "UPDATE people SET removed_at = ?1 WHERE id != ?2 AND removed_at IS NULL",
                params![at, actor],
            )?;
            conn.execute(
                "UPDATE certificates SET revoked_at = ?1 WHERE person_id != ?2 AND revoked_at IS NULL",
                params![at, actor],
            )?;
            conn.execute("UPDATE people SET admin = 0", [])?;
            conn.execute("DELETE FROM organization_grants", [])?;
            // With no organization, nothing it signed from now on is trusted.
            conn.execute(
                "UPDATE organization_keys SET retired_at = ?1 WHERE retired_at IS NULL",
                params![at],
            )?;
        }
        Body::CollectionCreated {
            collection,
            name,
            owner,
        } => {
            conn.execute(
                "INSERT INTO collections (id, created_at, name, owner_id) VALUES (?1, ?2, ?3, ?4)",
                params![collection.to_string(), at, name, owner.map(|o| o.to_string())],
            )?;
        }
        Body::CollectionRenamed { collection, name } => {
            conn.execute(
                "UPDATE collections SET name = ?1 WHERE id = ?2",
                params![name, collection.to_string()],
            )?;
        }
        Body::KeyEpoch {
            collection,
            epoch,
            previous,
            previous_batch,
            previous_summary,
        } => {
            conn.execute(
                "INSERT INTO collection_epochs (collection_id, epoch, created_at, previous, previous_batch, previous_summary)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    collection.to_string(),
                    epoch,
                    at,
                    previous,
                    previous_batch,
                    previous_summary
                ],
            )?;
            conn.execute(
                "UPDATE collections SET epoch = ?1 WHERE id = ?2",
                params![epoch, collection.to_string()],
            )?;
        }
        Body::GrantSet {
            person,
            collection,
            role,
            epoch,
            sealed,
        } => {
            conn.execute(
                "DELETE FROM grants WHERE user_id = ?1 AND collection_id = ?2",
                params![person.to_string(), collection.to_string()],
            )?;
            conn.execute(
                "INSERT INTO grants (user_id, collection_id, enc, ciphertext, role, epoch) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    person.to_string(),
                    collection.to_string(),
                    sealed.enc,
                    sealed.ciphertext,
                    role.code(),
                    epoch
                ],
            )?;
        }
        Body::GrantRemoved { person, collection } => {
            conn.execute(
                "DELETE FROM grants WHERE user_id = ?1 AND collection_id = ?2",
                params![person.to_string(), collection.to_string()],
            )?;
        }
        Body::OrganizationGrantSet {
            collection,
            epoch,
            sealed,
        } => {
            conn.execute(
                "DELETE FROM organization_grants WHERE collection_id = ?1",
                params![collection.to_string()],
            )?;
            conn.execute(
                "INSERT INTO organization_grants (collection_id, enc, ciphertext, epoch) VALUES (?1, ?2, ?3, ?4)",
                params![collection.to_string(), sealed.enc, sealed.ciphertext, epoch],
            )?;
        }
        Body::CertificateIssued {
            certificate,
            person,
            signing_key,
            encryption_key,
            issued_at,
            issuer_key,
            signature,
            proof,
        } => {
            conn.execute(
                "INSERT INTO certificates (id, person_id, signing_key, encryption_key, issued_at, issuer_key, signature, proof)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    certificate.to_string(),
                    person.to_string(),
                    signing_key,
                    encryption_key,
                    issued_at,
                    issuer_key,
                    signature,
                    proof
                ],
            )?;
        }
        Body::OrganizationKeyAdded {
            signing_key,
            encryption_key,
            ..
        } => {
            // The organization has one signing key at a time: the one before it is retired, and
            // what it signs from now on is not trusted.
            conn.execute(
                "UPDATE organization_keys SET retired_at = ?1 WHERE retired_at IS NULL",
                params![at],
            )?;
            conn.execute(
                "INSERT INTO organization_keys (signing_key, encryption_key, added_at) VALUES (?1, ?2, ?3)",
                params![signing_key, encryption_key, at],
            )?;
        }
        Body::RoleCreated { role } => {
            conn.execute(
                "INSERT INTO roles (id, name, changes, may, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    role.id.to_string(),
                    role.name,
                    roles::joined(&role.changes),
                    role.may.code(),
                    at
                ],
            )?;
        }
        Body::RoleChanged { role } => {
            conn.execute(
                "UPDATE roles SET name = ?1, changes = ?2, may = ?3 WHERE id = ?4",
                params![
                    role.name,
                    roles::joined(&role.changes),
                    role.may.code(),
                    role.id.to_string()
                ],
            )?;
        }
        Body::RoleDeleted { role } => {
            conn.execute("DELETE FROM roles WHERE id = ?1", params![role.to_string()])?;
        }
        Body::Erased {
            record,
            kind,
            collection,
        } => {
            let (record, kind) = (record.to_string(), kind.as_str());
            forget_record(conn, &record, kind)?;
            conn.execute(
                "DELETE FROM revisions WHERE record_id = ?1 AND kind = ?2",
                params![record, kind],
            )?;
            conn.execute(
                "DELETE FROM attachments WHERE record_id = ?1 AND kind = ?2",
                params![record, kind],
            )?;
            conn.execute(
                "INSERT INTO erased (record_id, kind, collection_id, erased_at, erased_by) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![record, kind, collection.to_string(), at, actor()?.to_string()],
            )?;
        }
        // Its revisions and attachments leave the change log where they were, and are logged
        // again as they are written for the collection they move to.
        Body::Moved { record, kind, .. } => forget_record(conn, &record.to_string(), kind.as_str())?,
    }
    Ok(())
}

/// Keeps an event, without the change log or what it changes.
fn keep(conn: &Connection, event: &Event) -> Result<()> {
    let signed = event.signed.as_ref();
    conn.execute(
        "INSERT INTO events (id, type, actor_id, collection_id, created_at, body, signature, signer_id, signed_as)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            event.id.to_string(),
            event.body.name(),
            event.actor.map(|a| a.to_string()),
            event.body.collection().map(|c| c.to_string()),
            event.at,
            event.json,
            signed.map(|s| &s.signature),
            signed.map(|s| s.signer.to_string()),
            signed.map(|s| s.role.code()),
        ],
    )?;
    Ok(())
}

/// Adds an event to the change log, in a scope, at `seq` or at the end.
fn log(conn: &Connection, event: &Event, scope: Option<Uuid>, seq: Option<i64>) -> Result<()> {
    conn.execute(
        "INSERT INTO changes (seq, item, item_id, collection_id, kind) VALUES (?1, 'event', ?2, ?3, ?4)",
        params![
            seq,
            event.id.to_string(),
            scope.map(|s| s.to_string()),
            event.body.record_kind().map(|k| k.as_str())
        ],
    )?;
    Ok(())
}

/// Takes a record's revisions and attachments out of the change log.
fn forget_record(conn: &Connection, record: &str, kind: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM changes WHERE item_id IN (
            SELECT id FROM revisions WHERE record_id = ?1 AND kind = ?2
            UNION ALL SELECT id FROM attachments WHERE record_id = ?1 AND kind = ?2)",
        params![record, kind],
    )?;
    Ok(())
}

fn insert_person(conn: &Connection, id: Uuid, name: &str, public_key: &[u8], admin: bool, at: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO people (id, name, public_key, admin, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id.to_string(), name, public_key, admin, at],
    )?;
    Ok(())
}

fn set_admin(conn: &Connection, person: &Uuid, admin: bool) -> Result<()> {
    conn.execute(
        "UPDATE people SET admin = ?1 WHERE id = ?2",
        params![admin, person.to_string()],
    )?;
    Ok(())
}

/// The meta row that says a vault's directory is kept as events.
const FILLED: &str = "directory";

/// Marks a new vault's directory as kept as events from the start.
pub(super) fn mark_filled(conn: &Connection) -> Result<()> {
    conn.execute("INSERT INTO meta (name, value) VALUES (?1, '1')", params![FILLED])?;
    Ok(())
}

/// Makes the events a vault from before them (schema 8 and earlier) would have recorded, from what
/// it holds, once: the people in its key file, which the database did not list, and its admins,
/// collections, roles, key epochs, grants and erased records. They have no actor, and go first in
/// the change log, ahead of the revisions they came before; an erased record's event takes its
/// tombstone's place. `unlocker` is the public key of whoever is unlocking, which a one-person
/// vault's key file does not keep.
pub(super) fn fill(conn: &Connection, keyring: &Keyring, unlocker: Option<(Uuid, &[u8])>) -> Result<()> {
    let filled: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE name = ?1", params![FILLED], |row| {
            row.get(0)
        })
        .optional()?;
    if filled.is_some() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    let now = now_ms();
    let mut events: Vec<Event> = Vec::new();
    let mut push = |at: i64, body: Body| -> Result<()> {
        events.push(Event::new(None, at, body)?);
        Ok(())
    };

    let team = keyring.organization.is_some();
    for user in &keyring.users {
        let public_key = match unlocker {
            Some((id, key)) if id == user.id && user.public_key.is_empty() => key.to_vec(),
            _ => user.public_key.clone(),
        };
        let admin = team && user.organization_key.is_some();
        insert_person(&tx, user.id, &user.name, &public_key, admin, now)?;
        push(
            now,
            Body::PersonAdded {
                person: user.id,
                name: user.name.clone(),
                public_key,
            },
        )?;
    }
    for user in keyring.users.iter().filter(|u| team && u.organization_key.is_some()) {
        push(now, Body::AdminGiven { person: user.id })?;
    }

    type Shelf = (String, String, Option<String>, i64);
    let shelves = tx
        .prepare("SELECT id, name, owner_id, created_at FROM collections ORDER BY created_at, rowid")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
        .collect::<rusqlite::Result<Vec<Shelf>>>()?;
    for (id, name, owner, at) in shelves {
        push(
            at,
            Body::CollectionCreated {
                collection: parse_id(&id)?,
                name,
                owner: owner.as_deref().map(parse_id).transpose()?,
            },
        )?;
    }

    type MadeRole = (String, String, String, String, i64);
    let made = tx
        .prepare("SELECT id, name, changes, may, created_at FROM roles ORDER BY created_at, rowid")?
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })?
        .collect::<rusqlite::Result<Vec<MadeRole>>>()?;
    for (id, name, changes, may, at) in made {
        let role = CustomRole {
            id: parse_id(&id)?,
            name,
            changes: changes.split(',').filter_map(Kind::parse).collect(),
            may: Capabilities::parse(&may),
        };
        push(at, Body::RoleCreated { role })?;
    }

    type Epoch = (String, i64, i64, Vec<u8>, Vec<u8>, Vec<u8>);
    let epochs = tx
        .prepare(
            "SELECT e.collection_id, e.epoch, e.created_at, e.previous, e.previous_batch, e.previous_summary
             FROM collection_epochs e JOIN collections c ON c.id = e.collection_id
             ORDER BY c.created_at, c.rowid, e.epoch",
        )?
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
        .collect::<rusqlite::Result<Vec<Epoch>>>()?;
    for (collection, epoch, at, previous, previous_batch, previous_summary) in epochs {
        push(
            at,
            Body::KeyEpoch {
                collection: parse_id(&collection)?,
                epoch,
                previous,
                previous_batch,
                previous_summary,
            },
        )?;
    }

    type Grant = (String, String, String, i64, Vec<u8>, Vec<u8>);
    let grants = tx
        .prepare("SELECT user_id, collection_id, role, epoch, enc, ciphertext FROM grants ORDER BY rowid")?
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
        .collect::<rusqlite::Result<Vec<Grant>>>()?;
    for (person, collection, role, epoch, enc, ciphertext) in grants {
        push(
            now,
            Body::GrantSet {
                person: parse_id(&person)?,
                collection: parse_id(&collection)?,
                role: parse_role(&role)?,
                epoch,
                sealed: SealedBox { enc, ciphertext },
            },
        )?;
    }

    type OrganizationGrant = (String, i64, Vec<u8>, Vec<u8>);
    let organization_grants = tx
        .prepare("SELECT collection_id, epoch, enc, ciphertext FROM organization_grants ORDER BY rowid")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
        .collect::<rusqlite::Result<Vec<OrganizationGrant>>>()?;
    for (collection, epoch, enc, ciphertext) in organization_grants {
        push(
            now,
            Body::OrganizationGrantSet {
                collection: parse_id(&collection)?,
                epoch,
                sealed: SealedBox { enc, ciphertext },
            },
        )?;
    }

    // Everything in the change log moves up to make room at its start, in two steps, so no two
    // entries share a number on the way.
    let entries: Vec<(&Event, Option<Uuid>)> = events
        .iter()
        .flat_map(|event| event.body.scopes().into_iter().map(move |scope| (event, scope)))
        .collect();
    tx.execute("UPDATE changes SET seq = -seq", [])?;
    tx.execute("UPDATE changes SET seq = ?1 - seq", params![entries.len() as i64])?;
    for (index, (event, scope)) in entries.into_iter().enumerate() {
        log(&tx, event, scope, Some(index as i64 + 1))?;
    }
    for event in &events {
        keep(&tx, event)?;
    }

    // Each erased record's tombstone becomes an event, where the tombstone was in the change log.
    type Tombstone = (String, String, String, i64, String);
    let tombstones = tx
        .prepare("SELECT record_id, kind, collection_id, erased_at, erased_by FROM erased ORDER BY rowid")?
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })?
        .collect::<rusqlite::Result<Vec<Tombstone>>>()?;
    for (record, kind, collection, at, by) in tombstones {
        let event = Event::new(
            Some(parse_id(&by)?),
            at,
            Body::Erased {
                record: parse_id(&record)?,
                kind: Kind::parse(&kind).ok_or_else(|| Error::Corrupt(format!("unknown kind {kind}")))?,
                collection: parse_id(&collection)?,
            },
        )?;
        keep(&tx, &event)?;
        tx.execute(
            "UPDATE changes SET item = 'event', item_id = ?1 WHERE item = 'erased' AND item_id = ?2",
            params![event.id.to_string(), record],
        )?;
    }
    // The next entry goes after the last, wherever the numbers moved to.
    tx.execute(
        "UPDATE sqlite_sequence SET seq = (SELECT max(seq) FROM changes) WHERE name = 'changes'",
        [],
    )?;
    mark_filled(&tx)?;
    tx.commit()?;
    Ok(())
}

/// Every event kept, in the change log's order, for tests: (type, actor, body).
#[cfg(test)]
pub(crate) fn kept(conn: &Connection) -> Vec<(String, Option<String>, Body)> {
    let mut statement = conn
        .prepare(
            "SELECT e.type, e.actor_id, e.body FROM events e
             JOIN (SELECT item_id, min(seq) AS seq FROM changes WHERE item = 'event' GROUP BY item_id) c
             ON c.item_id = e.id ORDER BY c.seq",
        )
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, String>(2)?)))
        .unwrap()
        .map(|row| {
            let (name, actor, body) = row.unwrap();
            (name, actor, serde_json::from_str(&body).unwrap())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto;
    use crate::store;
    use crate::vault::{Vault, team};
    use serde_json::json;

    const PASSWORD: &str = "cone six oxidation";
    const ONE_TIME: &str = "pass this on";

    /// The directory's tables, row by row, to compare two stores by.
    fn tables(conn: &Connection) -> Vec<Vec<String>> {
        rows(
            conn,
            &[
                "SELECT id, name, public_key, admin, added_at, removed_at FROM people ORDER BY id",
                "SELECT id, person_id, signing_key, encryption_key, issued_at, issuer_key, signature, proof, revoked_at
                 FROM certificates ORDER BY id",
                "SELECT signing_key, encryption_key, added_at, retired_at FROM organization_keys ORDER BY signing_key",
            ],
        )
        .into_iter()
        .chain(but_people(conn))
        .collect()
    }

    /// The directory's tables other than its people.
    fn but_people(conn: &Connection) -> Vec<Vec<String>> {
        rows(
            conn,
            &[
                "SELECT id, name, owner_id, epoch, created_at FROM collections ORDER BY id",
                "SELECT user_id, collection_id, role, epoch, enc, ciphertext FROM grants ORDER BY user_id, collection_id",
                "SELECT collection_id, epoch, enc, ciphertext FROM organization_grants ORDER BY collection_id",
                "SELECT id, name, changes, may, created_at FROM roles ORDER BY id",
                "SELECT collection_id, epoch, created_at, previous, previous_batch, previous_summary
                 FROM collection_epochs ORDER BY collection_id, epoch",
                "SELECT record_id, kind, collection_id, erased_at, erased_by FROM erased ORDER BY record_id",
            ],
        )
    }

    /// Who is in the vault now: what a vault from before events can tell of its people.
    fn people_now(conn: &Connection) -> Vec<Vec<String>> {
        rows(
            conn,
            &["SELECT id, name, public_key, admin FROM people WHERE removed_at IS NULL ORDER BY id"],
        )
    }

    fn rows(conn: &Connection, queries: &[&str]) -> Vec<Vec<String>> {
        queries
            .iter()
            .map(|sql| {
                let mut statement = conn.prepare(sql).unwrap();
                let columns = statement.column_count();
                statement
                    .query_map([], |row| {
                        Ok((0..columns)
                            .map(|i| format!("{:?}", row.get::<_, rusqlite::types::Value>(i).unwrap()))
                            .collect::<Vec<_>>()
                            .join("|"))
                    })
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap()
            })
            .collect()
    }

    /// Every event a store keeps, in the change log's order.
    fn logged(conn: &Connection) -> Vec<Event> {
        let mut statement = conn
            .prepare(
                "SELECT e.id, e.actor_id, e.created_at, e.body, e.signature, e.signer_id, e.signed_as FROM events e
                 JOIN (SELECT item_id, min(seq) AS seq FROM changes WHERE item = 'event' GROUP BY item_id) c
                 ON c.item_id = e.id ORDER BY c.seq",
            )
            .unwrap();
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<Vec<u8>>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .unwrap()
            .map(|row| {
                let (id, actor, at, body, signature, signer, role) = row.unwrap();
                Event {
                    id: parse_id(&id).unwrap(),
                    actor: actor.map(|a| parse_id(&a).unwrap()),
                    at,
                    body: serde_json::from_str(&body).unwrap(),
                    json: body,
                    signed: signature.map(|signature| SignedBy {
                        signature,
                        signer: parse_id(&signer.unwrap()).unwrap(),
                        role: As::parse(&role.unwrap()).unwrap(),
                    }),
                }
            })
            .collect()
    }

    /// A store that has only had a vault's events applied to it, in order, as a replica will.
    fn replayed(conn: &Connection) -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let replica = store::open(&dir.path().join("replica.db"), &crypto::random_key()).unwrap();
        for event in logged(conn) {
            apply(&replica, &event).unwrap();
        }
        (dir, replica)
    }

    /// A team that has done one of each change to its directory, and erased and moved a record.
    fn busy_team() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let (mut ana, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let shino = ana.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
        ana.grow_into_team("Ana").unwrap();
        let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        let sales = ana
            .create_role(
                "Sales",
                &[Kind::Firing],
                Capabilities {
                    chemistry: false,
                    ..Capabilities::BUILT_IN
                },
            )
            .unwrap();
        let production = ana.create_collection("Production").unwrap().id;
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
        let cleo = ana.add_person("Cleo", ONE_TIME, &[(shared, Role::Operator)]).unwrap();
        let dee = ana
            .add_person("Dee", ONE_TIME, &[(shared, Role::Custom(sales.id))])
            .unwrap();
        ana.set_role(ben.id, shared, Some(Role::Operator)).unwrap();
        ana.rename_collection(production, "Prod").unwrap();
        ana.make_admin(ben.id).unwrap();
        ana.take_admin_away(ben.id).unwrap();
        ana.reset_person(cleo.id, "a new one-time").unwrap();
        ana.change_role(sales.id, "Sales", &[Kind::Firing], Capabilities::BUILT_IN)
            .unwrap();
        ana.set_role(dee.id, shared, None).unwrap();
        ana.delete_role(sales.id).unwrap();
        let tenmoku = ana
            .save_in(Kind::Recipe, shared, &json!({ "name": "Tenmoku" }))
            .unwrap();
        let gone = ana.delete(Kind::Recipe, tenmoku.revision_id).unwrap();
        ana.erase(Kind::Recipe, gone.record_id).unwrap();
        ana.move_records(&[(Kind::Recipe, shino.record_id)], production)
            .unwrap();
        ana.remove_person(cleo.id).unwrap();
        (dir, ana)
    }

    #[test]
    fn a_vaults_events_applied_in_order_make_the_same_directory() {
        let (_dir, ana) = busy_team();
        let (_replica_dir, replica) = replayed(&ana.conn);
        assert_eq!(tables(&replica), tables(&ana.conn));
        // Each was made by Ana, who was there to make it.
        let ana_id = ana.me().id;
        assert!(logged(&ana.conn).iter().skip(3).all(|e| e.actor == Some(ana_id)));
    }

    #[test]
    fn a_vault_from_before_events_gets_them_once_from_what_it_holds() {
        let (dir, ana) = busy_team();
        let ana_id = ana.me().id;
        let (before, people) = (but_people(&ana.conn), people_now(&ana.conn));
        // What the change log lists besides the directory's events, the erasure's event as the
        // tombstone it was.
        let erasure: String = ana
            .conn
            .query_row("SELECT id FROM events WHERE type = 'erased'", [], |row| row.get(0))
            .unwrap();
        let as_saved = |entries: Vec<(String, String)>| -> Vec<(String, String)> {
            entries
                .into_iter()
                .map(|(item, id)| match item.as_str() {
                    "event" => ("erased".to_owned(), String::new()),
                    _ => (item, id),
                })
                .collect()
        };
        let saved = as_saved(
            ana.conn
                .prepare("SELECT item, item_id FROM changes WHERE item != 'event' OR item_id = ?1 ORDER BY seq")
                .unwrap()
                .query_map([&erasure], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap(),
        );
        let erased: String = ana
            .conn
            .query_row("SELECT record_id FROM erased", [], |row| row.get(0))
            .unwrap();
        // As it was at schema 8: no events, nobody listed in the database, and the erased
        // record's tombstone in the change log.
        ana.conn
            .execute_batch(&format!(
                "UPDATE changes SET item = 'erased', item_id = '{erased}'
                 WHERE item_id = (SELECT id FROM events WHERE type = 'erased');
                 DELETE FROM changes WHERE item = 'event';
                 DELETE FROM events; DELETE FROM people; DELETE FROM meta WHERE name = '{FILLED}';
                 DELETE FROM certificates; DELETE FROM organization_keys;"
            ))
            .unwrap();
        drop(ana);

        let mut ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
        assert_eq!(but_people(&ana.conn), before);
        assert_eq!(people_now(&ana.conn), people);
        let events = logged(&ana.conn);
        // Besides those, the unlock lists the organization's key and certifies Ana's.
        let trust: Vec<String> = events
            .iter()
            .filter(|e| {
                matches!(
                    e.body,
                    Body::OrganizationKeyAdded { .. } | Body::CertificateIssued { .. }
                )
            })
            .map(|e| e.id.to_string())
            .collect();
        assert!(!trust.is_empty());
        assert!(
            events.iter().all(|e| e.actor.is_none()
                || matches!(e.body, Body::Erased { .. })
                || trust.contains(&e.id.to_string()))
        );
        let (_replica_dir, replica) = replayed(&ana.conn);
        assert_eq!(tables(&replica), tables(&ana.conn));

        // The events go first in the change log, then what was saved, in the order it was, with
        // the erasure where its tombstone was; and what is saved now goes after it all.
        let order: Vec<(String, String)> = ana
            .conn
            .prepare("SELECT item, item_id FROM changes ORDER BY seq")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let made = events.iter().filter(|e| e.actor.is_none()).count();
        assert!(order[..made].iter().all(|(item, _)| item == "event"));
        let rest: Vec<(String, String)> = order[made..]
            .iter()
            .filter(|(_, id)| !trust.contains(id))
            .cloned()
            .collect();
        assert_eq!(as_saved(rest), saved);
        let latest = ana.save(Kind::Recipe, None, &json!({ "name": "Celadon" })).unwrap();
        let last: String = ana
            .conn
            .query_row("SELECT item_id FROM changes ORDER BY seq DESC LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(last, latest.revision_id.to_string());

        // Only once.
        let count = logged(&ana.conn).len();
        drop(ana);
        let ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
        assert_eq!(logged(&ana.conn).len(), count);
    }

    #[test]
    fn a_one_person_vault_records_its_person_collection_and_grant() {
        let dir = tempfile::tempdir().unwrap();
        let (vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let me = vault.me().id;
        let events = logged(&vault.conn);
        assert!(matches!(
            &events[..],
            [
                Event { body: Body::PersonAdded { person, .. }, .. },
                Event { body: Body::CollectionCreated { owner: None, .. }, .. },
                Event { body: Body::GrantSet { role: Role::Admin, epoch: 1, .. }, .. },
                Event { body: Body::CertificateIssued { person: certified, signing_key, issuer_key, .. }, .. },
            ] if *person == me && *certified == me && signing_key == issuer_key
        ));
        assert!(events.iter().all(|e| e.actor == Some(me)));
        // Its person's public key is in the directory, though its key file does not keep it.
        let public_key: Vec<u8> = vault
            .conn
            .query_row("SELECT public_key FROM people", [], |row| row.get(0))
            .unwrap();
        assert_eq!(public_key, vault.keys.public);
    }

    #[test]
    fn going_back_to_one_person_and_growing_again_replay_too() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ana, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        ana.grow_into_team("Ana").unwrap();
        let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Formulator)]).unwrap();
        ana.make_admin(ben.id).unwrap();
        ana.go_back_to_one_person().unwrap();
        assert!(!Directory::load(&ana.conn).unwrap().is_team());
        ana.grow_into_team("Ana").unwrap();
        let (_replica_dir, replica) = replayed(&ana.conn);
        assert_eq!(tables(&replica), tables(&ana.conn));
        let directory = Directory::load(&ana.conn).unwrap();
        assert_eq!(directory.people.len(), 1);
        assert!(directory.is_admin(ana.me().id));
    }

    #[test]
    fn a_narrower_role_is_never_sealed_the_new_key_whole() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ana, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        ana.grow_into_team("Ana").unwrap();
        let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
        ana.set_role(ben.id, shared, Some(Role::Operator)).unwrap();
        // Every grant at the new epoch is kept for good, so Ben's must hold the batch key alone.
        let at_two: Vec<Role> = logged(&ana.conn)
            .into_iter()
            .filter_map(|e| match e.body {
                Body::GrantSet {
                    person, epoch: 2, role, ..
                } if person == ben.id => Some(role),
                _ => None,
            })
            .collect();
        assert_eq!(at_two, [Role::Operator]);
    }

    #[test]
    fn an_event_the_directory_refuses_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (mut ana, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        ana.grow_into_team("Ana").unwrap();
        let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
        let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
        let before = tables(&ana.conn);
        let count = logged(&ana.conn).len();
        // Ben, a chemist, makes himself a formulator, with a key he made up.
        let forged = team::grant_set(
            &ana.keyring.vault_id,
            &ben.id,
            &ana.keys.public,
            &shared,
            &crypto::random_key(),
            1,
            Role::Formulator,
            crate::vault::Held::Collection,
        );
        let as_ben = Signer::new(ana.keyring.vault_id, ben.id, &crate::crypto::KeyPair::generate());
        assert!(matches!(record(&ana.conn, &as_ben, forged), Err(Error::NotAllowed)));
        let stranger = Signer::new(ana.keyring.vault_id, Uuid::new_v4(), &ana.keys);
        assert!(matches!(
            record(&ana.conn, &stranger, Body::PersonRemoved { person: ben.id }),
            Err(Error::NotAllowed)
        ));
        assert_eq!(tables(&ana.conn), before);
        assert_eq!(logged(&ana.conn).len(), count);
    }
}
