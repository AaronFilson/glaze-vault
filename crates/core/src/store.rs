//! The SQLCipher database: opening it with its key, and its schema.

use crate::crypto::Key;
use crate::error::{Error, Result};
use rusqlite::Connection;
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
];

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
        tx.pragma_update(None, "user_version", (index + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}
