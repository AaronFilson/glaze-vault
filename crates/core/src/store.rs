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
