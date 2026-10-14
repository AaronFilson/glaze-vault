//! A vault: the database, its key file, and the keys of the person who unlocked it.
//!
//! For now a vault has one person and one collection (docs/adr/0006-one-person-first.md), but it is
//! stored the way a team's vault will be, so growing one needs no change of format.

use crate::crypto::{self, Key, KeyPair, PasswordKdf};
use crate::error::{Error, Result};
use crate::keyring::{self, Keyring, KeyringUser};
use crate::recovery::RecoveryKey;
use crate::store;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use zeroize::Zeroizing;

pub const MIN_PASSWORD_CHARS: usize = 8;
const MAX_RECORD_BYTES: usize = 1024 * 1024;
const KEYRING_FILE: &str = "vault.keys";
const DATABASE_FILE: &str = "vault.db";

pub struct Vault {
    dir: PathBuf,
    keyring: Keyring,
    user_id: Uuid,
    keys: KeyPair,
    conn: Connection,
    collection_id: Uuid,
    collection_key: Key,
}

/// The newest revision of a recipe. `content` is whatever the UI saved; the core keeps it
/// encrypted and does not look inside.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeHead {
    pub record_id: Uuid,
    pub revision_id: Uuid,
    pub number: i64,
    pub saved_at: i64,
    pub content: serde_json::Value,
}

impl Vault {
    /// A vault exists once its key file does: the key file is written last when one is made.
    pub fn exists(dir: &Path) -> bool {
        dir.join(KEYRING_FILE).is_file()
    }

    /// Makes a vault for one person, and returns the recovery key to show them once.
    pub fn create(dir: &Path, password: &str) -> Result<(Vault, RecoveryKey)> {
        check_password(password)?;
        if Vault::exists(dir) {
            return Err(Error::VaultExists);
        }
        fs::create_dir_all(dir)?;
        set_aside_orphan_database(dir)?;

        let vault_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let keys = KeyPair::generate();
        let database_key = crypto::random_key();
        let recovery = RecoveryKey::generate();

        let password_kdf = PasswordKdf::new();
        let private_key = crypto::encrypt(
            &password_kdf.derive(password),
            &keys.secret,
            &keyring::private_key_aad(&vault_id, &user_id, "password"),
        );
        let private_key_by_recovery = crypto::encrypt(
            &crypto::recovery_key(&recovery.entropy(), user_id.as_bytes()),
            &keys.secret,
            &keyring::private_key_aad(&vault_id, &user_id, "recovery"),
        );
        let keyring = Keyring {
            format: keyring::FORMAT,
            vault_id,
            users: vec![KeyringUser {
                id: user_id,
                name: String::new(),
                password_kdf,
                private_key,
                private_key_by_recovery,
                database_key: crypto::seal_key(
                    &keys.public,
                    &database_key,
                    &keyring::database_key_info(&vault_id, &user_id),
                ),
            }],
        };

        let conn = store::open(&dir.join(DATABASE_FILE), &database_key)?;
        let collection_id = Uuid::new_v4();
        let collection_key = crypto::random_key();
        let sealed = crypto::seal_key(
            &keys.public,
            &collection_key,
            &grant_info(&vault_id, &collection_id, &user_id),
        );
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO meta (name, value) VALUES ('vault_id', ?1), ('default_collection', ?2)",
            params![vault_id.to_string(), collection_id.to_string()],
        )?;
        tx.execute(
            "INSERT INTO collections (id, created_at) VALUES (?1, ?2)",
            params![collection_id.to_string(), now_ms()],
        )?;
        tx.execute(
            "INSERT INTO grants (user_id, collection_id, enc, ciphertext) VALUES (?1, ?2, ?3, ?4)",
            params![
                user_id.to_string(),
                collection_id.to_string(),
                sealed.enc,
                sealed.ciphertext
            ],
        )?;
        tx.commit()?;
        keyring.write(&dir.join(KEYRING_FILE))?;

        let vault = Vault {
            dir: dir.to_owned(),
            keyring,
            user_id,
            keys,
            conn,
            collection_id,
            collection_key,
        };
        Ok((vault, recovery))
    }

    /// Opens the vault with the password. A vault has one person for now, so no name is asked.
    pub fn unlock(dir: &Path, password: &str) -> Result<Vault> {
        let keyring = read_keyring(dir)?;
        let user = only_user(&keyring)?;
        let key = user.password_kdf.derive(password);
        let secret = crypto::decrypt(
            &key,
            &user.private_key,
            &keyring::private_key_aad(&keyring.vault_id, &user.id, "password"),
        )
        .ok_or(Error::WrongPassword)?;
        Vault::open(dir, keyring, secret)
    }

    /// Opens the vault with the recovery key and sets a new password. The recovery key stays the
    /// same, so the printed sheet still works.
    pub fn recover(dir: &Path, words: &str, new_password: &str) -> Result<Vault> {
        check_password(new_password)?;
        let recovery = RecoveryKey::parse(words)?;
        let keyring = read_keyring(dir)?;
        let user = only_user(&keyring)?;
        let key = crypto::recovery_key(&recovery.entropy(), user.id.as_bytes());
        let secret = crypto::decrypt(
            &key,
            &user.private_key_by_recovery,
            &keyring::private_key_aad(&keyring.vault_id, &user.id, "recovery"),
        )
        .ok_or(Error::WrongRecoveryKey)?;
        let mut vault = Vault::open(dir, keyring, secret)?;
        vault.set_password(new_password)?;
        Ok(vault)
    }

    pub fn change_password(&mut self, current: &str, new_password: &str) -> Result<()> {
        check_password(new_password)?;
        let user = self.user();
        let key = user.password_kdf.derive(current);
        crypto::decrypt(
            &key,
            &user.private_key,
            &keyring::private_key_aad(&self.keyring.vault_id, &self.user_id, "password"),
        )
        .ok_or(Error::WrongPassword)?;
        self.set_password(new_password)
    }

    /// Saves a recipe. With no parent it starts a new recipe; with one, it adds the next revision
    /// after it. Revisions are never changed, only added (docs/adr/0005-lan-host-and-replicas.md).
    pub fn save_recipe(&mut self, parent: Option<Uuid>, content: &serde_json::Value) -> Result<RecipeHead> {
        let plaintext = Zeroizing::new(serde_json::to_vec(content)?);
        if plaintext.len() > MAX_RECORD_BYTES {
            return Err(Error::TooLarge);
        }
        let (record_id, number) = match parent {
            None => (Uuid::new_v4(), 1),
            Some(parent_id) => {
                let (record_id, number): (String, i64) = self
                    .conn
                    .query_row(
                        "SELECT record_id, number FROM revisions WHERE id = ?1 AND kind = 'recipe'",
                        params![parent_id.to_string()],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?
                    .ok_or(Error::NotFound)?;
                (parse_id(&record_id)?, number + 1)
            }
        };
        let revision_id = Uuid::new_v4();
        let saved_at = now_ms();
        let aad = revision_aad(
            &revision_id,
            &record_id,
            "recipe",
            &self.collection_id,
            number,
            parent.as_ref(),
        );
        let sealed = crypto::encrypt(&self.collection_key, &plaintext, &aad);
        self.conn.execute(
            "INSERT INTO revisions (id, record_id, kind, parent_id, number, collection_id, author_id, created_at, nonce, ciphertext)
             VALUES (?1, ?2, 'recipe', ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                revision_id.to_string(),
                record_id.to_string(),
                parent.map(|id| id.to_string()),
                number,
                self.collection_id.to_string(),
                self.user_id.to_string(),
                saved_at,
                sealed.nonce,
                sealed.ciphertext,
            ],
        )?;
        Ok(RecipeHead {
            record_id,
            revision_id,
            number,
            saved_at,
            content: content.clone(),
        })
    }

    /// The newest revision of every recipe, newest first.
    pub fn recipes(&self) -> Result<Vec<RecipeHead>> {
        let mut statement = self.conn.prepare(
            "SELECT r.id, r.record_id, r.parent_id, r.number, r.collection_id, r.created_at, r.nonce, r.ciphertext
             FROM revisions r
             WHERE r.kind = 'recipe'
               AND NOT EXISTS (SELECT 1 FROM revisions c WHERE c.parent_id = r.id)
             ORDER BY r.created_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Vec<u8>>(6)?,
                row.get::<_, Vec<u8>>(7)?,
            ))
        })?;
        let mut heads: Vec<RecipeHead> = Vec::new();
        for row in rows {
            let (id, record_id, parent_id, number, collection_id, saved_at, nonce, ciphertext) = row?;
            let (revision_id, record_id, collection_id) =
                (parse_id(&id)?, parse_id(&record_id)?, parse_id(&collection_id)?);
            let parent = parent_id.as_deref().map(parse_id).transpose()?;
            // Two heads for one recipe means a fork from offline editing (ADR 5): show the newest
            // until forks can be resolved.
            if heads.iter().any(|head| head.record_id == record_id) {
                continue;
            }
            if collection_id != self.collection_id {
                continue;
            }
            let aad = revision_aad(
                &revision_id,
                &record_id,
                "recipe",
                &collection_id,
                number,
                parent.as_ref(),
            );
            let plaintext = crypto::decrypt(&self.collection_key, &crypto::Sealed { nonce, ciphertext }, &aad)
                .ok_or_else(|| Error::Corrupt(format!("revision {revision_id} does not decrypt")))?;
            heads.push(RecipeHead {
                record_id,
                revision_id,
                number,
                saved_at,
                content: serde_json::from_slice(&plaintext)?,
            });
        }
        Ok(heads)
    }

    fn open(dir: &Path, keyring: Keyring, secret: Zeroizing<Vec<u8>>) -> Result<Vault> {
        let user = only_user(&keyring)?;
        let user_id = user.id;
        let keys = KeyPair::from_secret(secret).ok_or_else(|| Error::Corrupt("the private key is not valid".into()))?;
        let database_key = crypto::open_key(
            &keys,
            &user.database_key,
            &keyring::database_key_info(&keyring.vault_id, &user_id),
        )
        .ok_or_else(|| Error::Corrupt("the database key is not sealed to this user".into()))?;
        let conn = store::open(&dir.join(DATABASE_FILE), &database_key)?;

        let stored_id: String =
            conn.query_row("SELECT value FROM meta WHERE name = 'vault_id'", [], |row| row.get(0))?;
        if parse_id(&stored_id)? != keyring.vault_id {
            return Err(Error::Corrupt("the key file belongs to another vault".into()));
        }
        let collection_id: String =
            conn.query_row("SELECT value FROM meta WHERE name = 'default_collection'", [], |row| {
                row.get(0)
            })?;
        let collection_id = parse_id(&collection_id)?;
        let (enc, ciphertext): (Vec<u8>, Vec<u8>) = conn
            .query_row(
                "SELECT enc, ciphertext FROM grants WHERE user_id = ?1 AND collection_id = ?2",
                params![user_id.to_string(), collection_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| Error::Corrupt("no access to the vault's collection".into()))?;
        let collection_key = crypto::open_key(
            &keys,
            &crypto::SealedBox { enc, ciphertext },
            &grant_info(&keyring.vault_id, &collection_id, &user_id),
        )
        .ok_or_else(|| Error::Corrupt("the collection key does not open".into()))?;

        Ok(Vault {
            dir: dir.to_owned(),
            keyring,
            user_id,
            keys,
            conn,
            collection_id,
            collection_key,
        })
    }

    fn user(&self) -> &KeyringUser {
        self.keyring
            .users
            .iter()
            .find(|user| user.id == self.user_id)
            .expect("the unlocked user is in the keyring")
    }

    /// Encrypts the private key under a new password, with a new salt.
    fn set_password(&mut self, password: &str) -> Result<()> {
        let kdf = PasswordKdf::new();
        let sealed = crypto::encrypt(
            &kdf.derive(password),
            &self.keys.secret,
            &keyring::private_key_aad(&self.keyring.vault_id, &self.user_id, "password"),
        );
        let mut keyring = self.keyring.clone();
        let user = keyring
            .users
            .iter_mut()
            .find(|user| user.id == self.user_id)
            .expect("the unlocked user is in the keyring");
        user.password_kdf = kdf;
        user.private_key = sealed;
        keyring.write(&self.dir.join(KEYRING_FILE))?;
        self.keyring = keyring;
        Ok(())
    }
}

fn check_password(password: &str) -> Result<()> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(Error::PasswordTooShort(MIN_PASSWORD_CHARS));
    }
    Ok(())
}

fn read_keyring(dir: &Path) -> Result<Keyring> {
    if !Vault::exists(dir) {
        return Err(Error::NoVault);
    }
    Keyring::read(&dir.join(KEYRING_FILE))
}

fn only_user(keyring: &Keyring) -> Result<&KeyringUser> {
    match keyring.users.as_slice() {
        [user] => Ok(user),
        _ => Err(Error::Corrupt("this version opens vaults with one person only".into())),
    }
}

/// A database with no key file is left from a setup that stopped part way. Its key was never
/// saved, so nothing can open it, but it is moved aside rather than deleted.
fn set_aside_orphan_database(dir: &Path) -> Result<()> {
    for name in [DATABASE_FILE, "vault.db-wal", "vault.db-shm"] {
        let path = dir.join(name);
        if path.exists() {
            fs::rename(&path, dir.join(format!("{name}.unfinished-{}", now_ms())))?;
        }
    }
    Ok(())
}

fn grant_info(vault_id: &Uuid, collection_id: &Uuid, user_id: &Uuid) -> Vec<u8> {
    format!("glaze-vault v1 collection-key vault {vault_id} collection {collection_id} user {user_id}").into_bytes()
}

/// Binds a revision's content to where it belongs, so ciphertext cannot be moved to another
/// record, collection or place in the history.
fn revision_aad(
    id: &Uuid,
    record_id: &Uuid,
    kind: &str,
    collection_id: &Uuid,
    number: i64,
    parent: Option<&Uuid>,
) -> Vec<u8> {
    let parent = parent.map(Uuid::to_string).unwrap_or_default();
    format!("glaze-vault v1 revision {id} record {record_id} kind {kind} collection {collection_id} number {number} parent {parent}")
        .into_bytes()
}

fn parse_id(text: &str) -> Result<Uuid> {
    Uuid::parse_str(text).map_err(|_| Error::Corrupt(format!("bad id {text}")))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PASSWORD: &str = "cone six oxidation";

    #[test]
    fn create_lock_and_unlock() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!Vault::exists(dir.path()));
        let (mut vault, recovery) = Vault::create(dir.path(), PASSWORD).unwrap();
        assert_eq!(recovery.words().len(), 24);
        let saved = vault.save_recipe(None, &json!({ "name": "Leach 4321" })).unwrap();
        drop(vault);

        assert!(Vault::exists(dir.path()));
        assert!(matches!(Vault::create(dir.path(), PASSWORD), Err(Error::VaultExists)));
        assert!(matches!(
            Vault::unlock(dir.path(), "wrong password"),
            Err(Error::WrongPassword)
        ));
        let vault = Vault::unlock(dir.path(), PASSWORD).unwrap();
        let recipes = vault.recipes().unwrap();
        assert_eq!(recipes.len(), 1);
        assert_eq!(recipes[0].revision_id, saved.revision_id);
        assert_eq!(recipes[0].content["name"], "Leach 4321");
    }

    #[test]
    fn short_passwords_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            Vault::create(dir.path(), "1234567"),
            Err(Error::PasswordTooShort(8))
        ));
        assert!(!Vault::exists(dir.path()));
    }

    #[test]
    fn nothing_readable_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        vault
            .save_recipe(
                None,
                &json!({ "name": "Secret Celadon", "lines": [{ "material": "Whiting", "amount": 20 }] }),
            )
            .unwrap();
        drop(vault);
        for entry in fs::read_dir(dir.path()).unwrap() {
            let bytes = fs::read(entry.unwrap().path()).unwrap();
            let text = String::from_utf8_lossy(&bytes);
            assert!(!text.contains("Secret Celadon"));
            assert!(!text.contains("Whiting"));
            assert!(!text.starts_with("SQLite format 3"));
        }
    }

    #[test]
    fn recovery_key_resets_the_password() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, recovery) = Vault::create(dir.path(), PASSWORD).unwrap();
        vault.save_recipe(None, &json!({ "name": "Tenmoku" })).unwrap();
        drop(vault);

        let words = recovery.words().join(" ");
        let other = RecoveryKey::generate().words().join(" ");
        assert!(matches!(
            Vault::recover(dir.path(), &other, "a new password"),
            Err(Error::WrongRecoveryKey)
        ));
        assert!(matches!(
            Vault::recover(dir.path(), "not words at all", "a new password"),
            Err(Error::WrongRecoveryKey)
        ));

        let vault = Vault::recover(dir.path(), &words, "a new password").unwrap();
        assert_eq!(vault.recipes().unwrap()[0].content["name"], "Tenmoku");
        drop(vault);
        assert!(matches!(Vault::unlock(dir.path(), PASSWORD), Err(Error::WrongPassword)));
        Vault::unlock(dir.path(), "a new password").unwrap();
        // The same sheet still works afterwards.
        Vault::recover(dir.path(), &words, "a third password").unwrap();
    }

    #[test]
    fn change_password_needs_the_current_one() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        assert!(matches!(
            vault.change_password("not it at all", "new password 1"),
            Err(Error::WrongPassword)
        ));
        vault.change_password(PASSWORD, "new password 1").unwrap();
        drop(vault);
        assert!(matches!(Vault::unlock(dir.path(), PASSWORD), Err(Error::WrongPassword)));
        Vault::unlock(dir.path(), "new password 1").unwrap();
    }

    #[test]
    fn revisions_chain_and_the_newest_is_listed() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let first = vault.save_recipe(None, &json!({ "name": "Shino", "v": 1 })).unwrap();
        let second = vault
            .save_recipe(Some(first.revision_id), &json!({ "name": "Shino", "v": 2 }))
            .unwrap();
        assert_eq!(second.record_id, first.record_id);
        assert_eq!(second.number, 2);
        vault.save_recipe(None, &json!({ "name": "Ash" })).unwrap();

        let recipes = vault.recipes().unwrap();
        assert_eq!(recipes.len(), 2);
        let shino = recipes.iter().find(|r| r.record_id == first.record_id).unwrap();
        assert_eq!(shino.content["v"], 2);
        assert!(matches!(
            vault.save_recipe(Some(Uuid::new_v4()), &json!({})),
            Err(Error::NotFound)
        ));
    }

    #[test]
    fn moved_ciphertext_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
        let a = vault.save_recipe(None, &json!({ "name": "A" })).unwrap();
        let b = vault.save_recipe(None, &json!({ "name": "B" })).unwrap();
        // Copy A's ciphertext onto B, as someone editing the database file directly might.
        vault
            .conn
            .execute(
                "UPDATE revisions SET nonce = (SELECT nonce FROM revisions WHERE id = ?1),
                 ciphertext = (SELECT ciphertext FROM revisions WHERE id = ?1) WHERE id = ?2",
                params![a.revision_id.to_string(), b.revision_id.to_string()],
            )
            .unwrap();
        assert!(matches!(vault.recipes(), Err(Error::Corrupt(_))));
    }

    #[test]
    fn a_half_made_vault_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(DATABASE_FILE), b"left over").unwrap();
        Vault::create(dir.path(), PASSWORD).unwrap();
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().any(|n| n.starts_with("vault.db.unfinished-")));
    }
}
