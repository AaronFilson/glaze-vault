//! The SQLCipher database: opening it with its key, and its schema.

use crate::crypto::{self, Key};
use crate::error::{Error, Result};
use rusqlite::{Connection, params};
use std::path::Path;
use zeroize::Zeroizing;

/// Each entry moves the schema up one version; `PRAGMA user_version` records how far it got.
const MIGRATIONS: &[&str] = &[
    // 1: one collection per vault for now; grants and revisions as in ADR 4 and 5.
    "CREATE TABLE meta (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE collections (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE grants (
        user_id TEXT NOT NULL,
        collection_id TEXT NOT NULL REFERENCES collections(id),
        enc BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        PRIMARY KEY (user_id, collection_id)
    );
    CREATE TABLE revisions (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        parent_id TEXT REFERENCES revisions(id),
        number INTEGER NOT NULL,
        collection_id TEXT NOT NULL REFERENCES collections(id),
        author_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL
    );
    CREATE INDEX revisions_by_record ON revisions(record_id, number);
    CREATE INDEX revisions_by_parent ON revisions(parent_id);",
    // 2: a revision that deletes its record, keeping its content to restore (ADR 9).
    "ALTER TABLE revisions ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;",
    // 3: a team on one computer (ADR 12): collections have names, and a private one its person;
    // grants carry a role; every collection key is also sealed to the organization, once there is
    // one. Grants made before are a one-person vault's, whose person is its admin.
    "ALTER TABLE collections ADD COLUMN name TEXT NOT NULL DEFAULT '';
    ALTER TABLE collections ADD COLUMN owner_id TEXT;
    ALTER TABLE grants ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
    CREATE TABLE organization_grants (
        collection_id TEXT PRIMARY KEY REFERENCES collections(id),
        enc BLOB NOT NULL,
        ciphertext BLOB NOT NULL
    );",
    // 4: attachments (ADR 14): a record's photos and other files, each encrypted with its
    // collection's key and kept apart from the record's revisions, which only name them.
    "CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        collection_id TEXT NOT NULL REFERENCES collections(id),
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        author_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL
    );
    CREATE INDEX attachments_by_record ON attachments(record_id);",
    // 5: roles admins make (ADR 4): a name and the kinds of record it changes, comma-separated.
    // Each reads everything in its collections, as a chemist does.
    "CREATE TABLE roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        changes TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );",
    // 6: what else a role admins make may do (ADR 4): export, print, read recipes' chemistry, and
    // manage the people on its collections, comma-separated. Roles made before could do all but
    // manage. And a recipe revision's summary, its content without its chemistry, under the
    // collection's summary key (crate::vault::summary_key), for roles that read without it.
    "ALTER TABLE roles ADD COLUMN may TEXT NOT NULL DEFAULT 'export,print,chemistry';
    ALTER TABLE revisions ADD COLUMN summary_nonce BLOB;
    ALTER TABLE revisions ADD COLUMN summary BLOB;",
    // 7: mixes (ADR 16), a kind of record older versions do not know, so they refuse the vault
    // instead of failing on one. The tables do not change.
    "",
    // 8: key epochs, the change log and tombstones (ADR 17). A collection's key changes by starting
    // a new epoch, each epoch's key wrapping the one before (collection_epochs, from epoch 2), so
    // what was stored under an older key is never encrypted again. Each revision, attachment and
    // grant says which epoch's key it is under; today's keys are epoch 1. A revision that resolves
    // a fork names the heads it supersedes, comma-separated. `changes` lists what this store holds
    // in the order it came, revisions and attachments so far by when they were saved; `erased`
    // remembers each record erased. An attachment's hash is of its nonce and ciphertext, filled in
    // below, so a store without its key can check it.
    "ALTER TABLE collections ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE grants ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE organization_grants ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE revisions ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE revisions ADD COLUMN supersedes TEXT;
    ALTER TABLE attachments ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE attachments ADD COLUMN sha256 BLOB;
    CREATE TABLE collection_epochs (
        collection_id TEXT NOT NULL REFERENCES collections(id),
        epoch INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        previous BLOB NOT NULL,
        previous_batch BLOB NOT NULL,
        previous_summary BLOB NOT NULL,
        PRIMARY KEY (collection_id, epoch)
    );
    CREATE TABLE changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        host_seq INTEGER,
        item TEXT NOT NULL,
        item_id TEXT NOT NULL,
        collection_id TEXT,
        kind TEXT
    );
    CREATE INDEX changes_by_item ON changes(item_id);
    INSERT INTO changes (item, item_id, collection_id, kind)
        SELECT item, id, collection_id, kind FROM (
            SELECT 'revision' AS item, id, collection_id, kind, created_at, 0 AS rank, rowid AS row FROM revisions
            UNION ALL
            SELECT 'attachment', id, collection_id, kind, created_at, 1, rowid FROM attachments
        ) ORDER BY created_at, rank, row;
    CREATE TABLE erased (
        record_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        collection_id TEXT NOT NULL REFERENCES collections(id),
        erased_at INTEGER NOT NULL,
        erased_by TEXT NOT NULL
    );",
    // 9: the directory as events (ADR 18). Each change to people, admins, collections, grants and
    // roles, and each record erased or moved, is kept as an event, its body JSON as it was made,
    // and the change log lists it. `people` is who is in the vault, as the key file says on one
    // computer, so that checks of who may do what need nothing but the database. A vault from
    // before gets the events it would have made, from what it holds, when it is next unlocked
    // (vault::events::fill): its people are only in its key file.
    "CREATE TABLE events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        actor_id TEXT,
        collection_id TEXT,
        created_at INTEGER NOT NULL,
        body TEXT NOT NULL
    );
    CREATE TABLE people (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        public_key BLOB NOT NULL,
        admin INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL,
        removed_at INTEGER
    );",
    // 10: signatures and the audit log (ADR 19). Each revision, attachment and event keeps the
    // signature of whoever made it, moved it or vouched for it after (`signed_as`), and whose key
    // that was. Certificates say a signing key is a person's, signed by the organization, whose
    // signing keys are listed with when each was its key, or by the key itself in a one-person
    // vault. The audit log is a hash chain of what people did, each entry signed by them;
    // `device_id` and `host_seq` are for the LAN host.
    "ALTER TABLE revisions ADD COLUMN signature BLOB;
    ALTER TABLE revisions ADD COLUMN signer_id TEXT;
    ALTER TABLE revisions ADD COLUMN signed_as TEXT;
    ALTER TABLE attachments ADD COLUMN signature BLOB;
    ALTER TABLE attachments ADD COLUMN signer_id TEXT;
    ALTER TABLE attachments ADD COLUMN signed_as TEXT;
    ALTER TABLE events ADD COLUMN signature BLOB;
    ALTER TABLE events ADD COLUMN signer_id TEXT;
    ALTER TABLE events ADD COLUMN signed_as TEXT;
    CREATE TABLE certificates (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        signing_key BLOB NOT NULL,
        encryption_key BLOB NOT NULL,
        issued_at INTEGER NOT NULL,
        issuer_key BLOB NOT NULL,
        signature BLOB NOT NULL,
        proof BLOB,
        revoked_at INTEGER
    );
    CREATE INDEX certificates_by_person ON certificates(person_id);
    CREATE TABLE organization_keys (
        signing_key BLOB PRIMARY KEY,
        encryption_key BLOB NOT NULL,
        added_at INTEGER NOT NULL,
        retired_at INTEGER
    );
    CREATE TABLE audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        at INTEGER NOT NULL,
        person_id TEXT,
        device_id TEXT,
        action TEXT NOT NULL,
        kind TEXT,
        record_id TEXT,
        collection_id TEXT,
        detail TEXT,
        prev_hash BLOB NOT NULL,
        hash BLOB NOT NULL,
        signature BLOB,
        host_seq INTEGER
    );",
    // 11: the sync model (ADR 20). A revision keeps the hash of its nonce and ciphertext, filled in
    // below, which its signature covers, so a copy without its ciphertext, for someone who reads
    // only its summary, still checks. On a host, `devices` are the computers certified to sync
    // with it, and on every store `key_entries` keep the latest of each person's key file entry,
    // to reach their computers. On a replica, `sync_state` keeps a cursor and the key held for
    // each scope, and `refused` the items the host would not take. A collection's name and the
    // event that makes it belong to the collection's part of the change log, so whoever comes to
    // read it gets them when they catch up on it. Whether a certificate is trusted goes by where it
    // and the organization's keys came in the change log (`place`), not by computers' clocks,
    // filled in below from the events that made them.
    "ALTER TABLE revisions ADD COLUMN content_hash BLOB;
    ALTER TABLE certificates ADD COLUMN place INTEGER;
    ALTER TABLE organization_keys ADD COLUMN place INTEGER;
    ALTER TABLE organization_keys ADD COLUMN retired_place INTEGER;
    CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        signing_key BLOB NOT NULL,
        people TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        issuer_key BLOB NOT NULL,
        signature BLOB NOT NULL,
        revoked_at INTEGER
    );
    CREATE TABLE key_entries (
        person_id TEXT PRIMARY KEY,
        entry TEXT NOT NULL,
        at INTEGER NOT NULL,
        signer_id TEXT NOT NULL,
        signature BLOB NOT NULL
    );
    CREATE TABLE sync_state (
        scope TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL,
        held TEXT
    );
    CREATE TABLE refused (
        item_id TEXT PRIMARY KEY,
        refusal TEXT NOT NULL,
        at INTEGER NOT NULL
    );
    UPDATE changes SET collection_id = (SELECT e.collection_id FROM events e WHERE e.id = changes.item_id)
        WHERE item = 'event' AND item_id IN (
            SELECT id FROM events WHERE type IN ('collection-created', 'collection-renamed'));",
    // 12: photos in chunks (plan section 3.7). A replica keeps an attachment it pulled without its
    // bytes, an empty ciphertext, until it has fetched them; on the way in, on the host from a
    // computer or on a replica from the host, the pieces wait here until the last arrives.
    "CREATE TABLE incoming_attachments (
        id TEXT NOT NULL,
        device_id TEXT,
        offset INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (id, offset)
    );",
    // 13: offline limits, revoking computers and the host's backups (ADR 24). The vault's rule
    // for computers away from the host is the directory's, as its event wrote it. The host keeps
    // each computer's offline secret from pairing, which extension codes are made with, and
    // whether a computer revoked was lost.
    "CREATE TABLE offline_policy (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        policy TEXT NOT NULL
    );
    ALTER TABLE devices ADD COLUMN offline_secret BLOB;
    ALTER TABLE devices ADD COLUMN lost INTEGER NOT NULL DEFAULT 0;",
];

/// A step a migration needs that SQL cannot do, run in its transaction after its SQL.
type Fill = fn(&Connection) -> Result<()>;

/// Each fill, by the version its migration brings the schema to.
const FILLS: &[(usize, Fill)] = &[(8, hash_attachments), (11, hash_revisions), (11, place_trust)];

pub fn open(path: &Path, key: &Key) -> Result<Connection> {
    let conn = Connection::open(path)?;
    // A raw key, so SQLCipher skips its own password hashing: the key is already random.
    let pragma = Zeroizing::new(format!("PRAGMA key = \"x'{}'\";", hex::encode(key.as_ref())));
    conn.execute_batch(&pragma)?;
    // SQLCipher only finds out whether the key is right on the first read.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .map_err(|_| Error::Corrupt("the database key does not open the database".into()))?;
    // secure_delete zeroes what is removed, so an erased record leaves nothing in free pages.
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;")?;
    migrate(&conn)?;
    Ok(conn)
}

/// Encrypts the whole database again under a new key. SQLCipher does this only outside
/// write-ahead logging.
pub fn rekey(conn: &Connection, key: &Key) -> Result<()> {
    let pragma = Zeroizing::new(format!("PRAGMA rekey = \"x'{}'\";", hex::encode(key.as_ref())));
    conn.query_row("PRAGMA journal_mode = DELETE", [], |_| Ok(()))?;
    conn.execute_batch(&pragma)?;
    conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let version = usize::try_from(version).unwrap_or(usize::MAX);
    if version > MIGRATIONS.len() {
        return Err(Error::Corrupt(format!(
            "the vault was saved by a newer version of Glaze Vault (schema {version}); update the app"
        )));
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(version) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        for (_, fill) in FILLS.iter().filter(|(to, _)| *to == index + 1) {
            fill(&tx)?;
        }
        tx.pragma_update(None, "user_version", (index + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

/// What an attachment's `sha256` holds: the hash of its nonce and then its ciphertext.
pub(crate) fn attachment_hash(nonce: &[u8], ciphertext: &[u8]) -> Vec<u8> {
    crypto::sha256(&[nonce, ciphertext]).to_vec()
}

/// What a revision's `content_hash` holds: the hash of its nonce and then its ciphertext.
pub(crate) fn content_hash(nonce: &[u8], ciphertext: &[u8]) -> Vec<u8> {
    crypto::sha256(&[nonce, ciphertext]).to_vec()
}

/// Hashes the revisions stored before they kept their hashes.
fn hash_revisions(conn: &Connection) -> Result<()> {
    conn.create_scalar_function(
        "glaze_vault_content_hash",
        2,
        rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| Ok(content_hash(&context.get::<Vec<u8>>(0)?, &context.get::<Vec<u8>>(1)?)),
    )?;
    conn.execute(
        "UPDATE revisions SET content_hash = glaze_vault_content_hash(nonce, ciphertext) WHERE content_hash IS NULL",
        [],
    )?;
    conn.remove_function("glaze_vault_content_hash", 2)?;
    Ok(())
}

/// Where each certificate and organization key came in the change log, and where the key after
/// each, or going back to one person, retired it, from the events that did.
pub(crate) fn place_trust(conn: &Connection) -> Result<()> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    conn.execute(
        "UPDATE certificates SET place = (
            SELECT min(c.seq) FROM events e JOIN changes c ON c.item_id = e.id
            WHERE e.type = 'certificate-issued' AND json_extract(e.body, '$.certificate') = certificates.id)",
        [],
    )?;
    let events = conn
        .prepare(
            "SELECT e.type, e.body, min(c.seq) AS place FROM events e JOIN changes c ON c.item_id = e.id
             WHERE e.type IN ('organization-key-added', 'team-disbanded') GROUP BY e.id ORDER BY place",
        )?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (kind, body, place) in events {
        conn.execute(
            "UPDATE organization_keys SET retired_place = ?1 WHERE place IS NOT NULL AND retired_place IS NULL",
            params![place],
        )?;
        if kind == "organization-key-added" {
            let body: serde_json::Value = serde_json::from_str(&body)?;
            let key = body["signingKey"]
                .as_str()
                .and_then(|text| STANDARD.decode(text).ok())
                .ok_or_else(|| Error::Corrupt("an organization key event has no key".into()))?;
            conn.execute(
                "UPDATE organization_keys SET place = ?1 WHERE signing_key = ?2",
                params![place, key],
            )?;
        }
    }
    Ok(())
}

/// Hashes the attachments stored before they had hashes, one at a time: there may be many photos.
fn hash_attachments(conn: &Connection) -> Result<()> {
    let ids = conn
        .prepare("SELECT id FROM attachments WHERE sha256 IS NULL")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in ids {
        let (nonce, ciphertext): (Vec<u8>, Vec<u8>) = conn.query_row(
            "SELECT nonce, ciphertext FROM attachments WHERE id = ?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        conn.execute(
            "UPDATE attachments SET sha256 = ?1 WHERE id = ?2",
            rusqlite::params![attachment_hash(&nonce, &ciphertext), id],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    #[test]
    fn schema_8_lists_what_was_stored_in_order_and_hashes_attachments() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        for sql in &MIGRATIONS[..7] {
            conn.execute_batch(sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 7).unwrap();
        conn.execute("INSERT INTO collections (id, created_at) VALUES ('c', 0)", [])
            .unwrap();
        for (id, at) in [("r5", 5), ("r1", 1)] {
            conn.execute(
                "INSERT INTO revisions (id, record_id, kind, number, collection_id, author_id, created_at, nonce, ciphertext)
                 VALUES (?1, ?1, 'recipe', 1, 'c', 'a', ?2, x'00', x'01')",
                params![id, at],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO attachments (id, record_id, kind, collection_id, media_type, size, author_id, created_at, nonce, ciphertext)
             VALUES ('a3', 'r1', 'firing', 'c', 'image/png', 1, 'a', 3, x'0203', x'0405')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();
        let mut statement = conn.prepare("SELECT item, item_id FROM changes ORDER BY seq").unwrap();
        let changes: Vec<(String, String)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let expected = [("revision", "r1"), ("attachment", "a3"), ("revision", "r5")];
        assert_eq!(changes, expected.map(|(item, id)| (item.to_owned(), id.to_owned())));
        let hash: Vec<u8> = conn
            .query_row("SELECT sha256 FROM attachments WHERE id = 'a3'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(hash, crypto::sha256(&[&[2, 3], &[4, 5]]));
        let epoch: i64 = conn
            .query_row("SELECT epoch FROM revisions WHERE id = 'r5'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(epoch, 1);
    }
}
