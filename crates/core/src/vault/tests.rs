use super::*;
use serde_json::json;

const PASSWORD: &str = "cone six oxidation";

#[test]
fn create_lock_and_unlock() {
    let dir = tempfile::tempdir().unwrap();
    assert!(!Vault::exists(dir.path()));
    let (mut vault, recovery) = Vault::create(dir.path(), PASSWORD).unwrap();
    assert_eq!(recovery.words().len(), 24);
    let saved = vault
        .save(Kind::Recipe, None, &json!({ "name": "Leach 4321" }))
        .unwrap();
    drop(vault);

    assert!(Vault::exists(dir.path()));
    assert!(matches!(Vault::create(dir.path(), PASSWORD), Err(Error::VaultExists)));
    assert!(matches!(
        Vault::unlock(dir.path(), "wrong password"),
        Err(Error::WrongPassword)
    ));
    let vault = Vault::unlock(dir.path(), PASSWORD).unwrap();
    let recipes = vault.heads(Kind::Recipe).unwrap();
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
        .save(
            Kind::Recipe,
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
    vault.save(Kind::Recipe, None, &json!({ "name": "Tenmoku" })).unwrap();
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
    assert_eq!(vault.heads(Kind::Recipe).unwrap()[0].content["name"], "Tenmoku");
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
    let first = vault
        .save(Kind::Recipe, None, &json!({ "name": "Shino", "v": 1 }))
        .unwrap();
    let second = vault
        .save(
            Kind::Recipe,
            Some(first.revision_id),
            &json!({ "name": "Shino", "v": 2 }),
        )
        .unwrap();
    assert_eq!(second.record_id, first.record_id);
    assert_eq!(second.number, 2);
    vault.save(Kind::Recipe, None, &json!({ "name": "Ash" })).unwrap();

    let recipes = vault.heads(Kind::Recipe).unwrap();
    assert_eq!(recipes.len(), 2);
    let shino = recipes.iter().find(|r| r.record_id == first.record_id).unwrap();
    assert_eq!(shino.content["v"], 2);
    assert!(matches!(
        vault.save(Kind::Recipe, Some(Uuid::new_v4()), &json!({})),
        Err(Error::NotFound)
    ));
}

#[test]
fn moved_ciphertext_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    let a = vault.save(Kind::Recipe, None, &json!({ "name": "A" })).unwrap();
    let b = vault.save(Kind::Recipe, None, &json!({ "name": "B" })).unwrap();
    // Copy A's ciphertext onto B, as someone editing the database file directly might.
    vault
        .conn
        .execute(
            "UPDATE revisions SET nonce = (SELECT nonce FROM revisions WHERE id = ?1),
             ciphertext = (SELECT ciphertext FROM revisions WHERE id = ?1) WHERE id = ?2",
            params![a.revision_id.to_string(), b.revision_id.to_string()],
        )
        .unwrap();
    assert!(matches!(vault.heads(Kind::Recipe), Err(Error::Corrupt(_))));
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

fn names_in(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect()
}

#[test]
fn a_backup_restores_on_another_computer() {
    let (home, elsewhere, files) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let (mut vault, _) = Vault::create(home.path(), PASSWORD).unwrap();
    vault
        .save(Kind::Recipe, None, &json!({ "name": "Secret Celadon" }))
        .unwrap();
    let settings = Settings {
        auto_lock: false,
        auto_lock_minutes: 5,
        backup_reminder_days: 7,
        phone_backups: false,
    };
    vault.set_settings(&settings).unwrap();
    let path = files.path().join("vault.gvbackup");
    let last = vault.back_up(&path).unwrap();
    assert_eq!(last.file_name, "vault.gvbackup");
    assert_eq!(vault.last_backup().unwrap().unwrap().at, last.at);

    let bytes = fs::read(&path).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("Secret Celadon"));
    assert_eq!(Vault::backup_info(&path).unwrap().created_at, last.at);

    let target = elsewhere.path().join("vault");
    assert!(matches!(
        Vault::restore(&target, &path, None, &Credential::Password("wrong password")),
        Err(Error::WrongPassword)
    ));
    assert!(!target.exists());
    let (restored, set_aside) = Vault::restore(&target, &path, None, &Credential::Password(PASSWORD)).unwrap();
    assert!(set_aside.is_none());
    assert_eq!(
        restored.heads(Kind::Recipe).unwrap()[0].content["name"],
        "Secret Celadon"
    );
    assert_eq!(restored.settings().unwrap(), settings);
    drop(restored);
    Vault::unlock(&target, PASSWORD).unwrap();
}

#[test]
fn restoring_over_a_vault_keeps_the_old_one_aside() {
    let (dir, files) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (mut vault, recovery) = Vault::create(dir.path(), PASSWORD).unwrap();
    vault.save(Kind::Recipe, None, &json!({ "name": "Before" })).unwrap();
    let path = files.path().join("b.gvbackup");
    vault.back_up(&path).unwrap();
    vault.save(Kind::Recipe, None, &json!({ "name": "After" })).unwrap();
    vault.change_password(PASSWORD, "changed since").unwrap();
    drop(vault);

    // The backup opens with the recovery key, and sets a new password.
    let words = recovery.words().join(" ");
    let credential = Credential::RecoveryKey {
        words: &words,
        new_password: "restored password",
    };
    let (restored, set_aside) = Vault::restore(dir.path(), &path, None, &credential).unwrap();
    let names: Vec<_> = restored
        .heads(Kind::Recipe)
        .unwrap()
        .iter()
        .map(|r| r.content["name"].clone())
        .collect();
    assert_eq!(names, vec![json!("Before")]);
    // The backup it came from counts as its latest.
    let last = restored.last_backup().unwrap().unwrap();
    assert_eq!(last.file_name, "b.gvbackup");
    assert_eq!(last.at, Vault::backup_info(&path).unwrap().created_at);
    drop(restored);
    Vault::unlock(dir.path(), "restored password").unwrap();

    let aside = set_aside.unwrap();
    assert!(aside.file_name().unwrap().to_string_lossy().starts_with("replaced-"));
    let old = Vault::unlock(&aside, "changed since").unwrap();
    assert_eq!(old.heads(Kind::Recipe).unwrap().len(), 2);
}

#[test]
fn a_vault_set_aside_can_be_brought_back() {
    let (dir, files) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    vault.save(Kind::Recipe, None, &json!({ "name": "Before" })).unwrap();
    let path = files.path().join("b.gvbackup");
    vault.back_up(&path).unwrap();
    vault.save(Kind::Recipe, None, &json!({ "name": "After" })).unwrap();
    drop(vault);
    let (restored, _) = Vault::restore(dir.path(), &path, None, &Credential::Password(PASSWORD)).unwrap();
    drop(restored);

    let aside = Vault::set_aside(dir.path()).unwrap();
    assert_eq!(aside.len(), 1);
    let replaced = Vault::bring_back(dir.path(), &aside[0].name).unwrap().unwrap();
    assert!(!dir.path().join(&aside[0].name).exists());
    let back = Vault::unlock(dir.path(), PASSWORD).unwrap();
    assert_eq!(back.heads(Kind::Recipe).unwrap().len(), 2);
    drop(back);
    // The restored vault went aside in its place, to switch back to.
    let now = Vault::set_aside(dir.path()).unwrap();
    assert_eq!(now.len(), 1);
    assert_eq!(dir.path().join(&now[0].name), replaced);

    for name in ["../elsewhere", "replaced-", "replaced-1/..", "vault.keys"] {
        assert!(
            matches!(Vault::bring_back(dir.path(), name), Err(Error::NotFound)),
            "{name}"
        );
    }
    assert!(Vault::set_aside(&dir.path().join("missing")).unwrap().is_empty());
}

#[test]
fn damaged_backups_and_other_files_are_refused() {
    let (dir, files) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
    let path = files.path().join("b.gvbackup");
    vault.back_up(&path).unwrap();
    drop(vault);
    let good = fs::read(&path).unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let restore = |bytes: &[u8]| {
        let path = files.path().join("try.gvbackup");
        fs::write(&path, bytes).unwrap();
        Vault::restore(elsewhere.path(), &path, None, &Credential::Password(PASSWORD)).map(|_| ())
    };

    let mut flipped = good.clone();
    *flipped.last_mut().unwrap() ^= 1;
    assert!(matches!(restore(&flipped), Err(Error::BackupDamaged)));
    assert!(matches!(restore(&good[..good.len() - 100]), Err(Error::BackupDamaged)));
    assert!(matches!(restore(&good[..20]), Err(Error::BackupDamaged)));
    assert!(matches!(restore(b"name,material,amount\n"), Err(Error::NotABackup)));
    assert!(
        names_in(elsewhere.path()).is_empty(),
        "a backup that fails writes nothing"
    );
    restore(&good).unwrap();
}

#[test]
fn a_new_recovery_key_replaces_the_old_one() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, old) = Vault::create(dir.path(), PASSWORD).unwrap();
    assert!(matches!(
        vault.new_recovery_key("not the password"),
        Err(Error::WrongPassword)
    ));
    let new = vault.new_recovery_key(PASSWORD).unwrap();
    drop(vault);
    assert!(matches!(
        Vault::recover(dir.path(), &old.words().join(" "), "another password"),
        Err(Error::WrongRecoveryKey)
    ));
    Vault::recover(dir.path(), &new.words().join(" "), "another password").unwrap();
}

#[test]
fn settings_have_defaults_and_limits() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    assert_eq!(vault.settings().unwrap(), Settings::default());
    assert!(vault.settings().unwrap().auto_lock);
    let zero = Settings {
        auto_lock_minutes: 0,
        ..Settings::default()
    };
    assert!(matches!(vault.set_settings(&zero), Err(Error::InvalidSetting(_))));
    let off = Settings {
        auto_lock: false,
        ..Settings::default()
    };
    vault.set_settings(&off).unwrap();
    drop(vault);
    assert_eq!(Vault::unlock(dir.path(), PASSWORD).unwrap().settings().unwrap(), off);
}

#[test]
fn a_draft_is_kept_until_cleared() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    assert!(vault.draft().unwrap().is_none());
    vault
        .save_draft(&json!({ "content": { "name": "Half done" } }))
        .unwrap();
    vault.save_draft(&json!({ "content": { "name": "Newer" } })).unwrap();
    drop(vault);
    let mut vault = Vault::unlock(dir.path(), PASSWORD).unwrap();
    assert_eq!(vault.draft().unwrap().unwrap()["content"]["name"], "Newer");
    assert_eq!(vault.draft().unwrap().unwrap()["content"]["name"], "Newer");
    vault.clear_draft().unwrap();
    assert!(vault.draft().unwrap().is_none());
}

#[test]
fn kinds_keep_their_own_lists_and_histories() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    let recipe = vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
    let spar = vault
        .save(Kind::Material, None, &json!({ "name": "Custer, lot 7" }))
        .unwrap();
    let spar2 = vault
        .save(
            Kind::Material,
            Some(spar.revision_id),
            &json!({ "name": "Custer, lot 8" }),
        )
        .unwrap();
    let spar3 = vault
        .save(
            Kind::Material,
            Some(spar2.revision_id),
            &json!({ "name": "Custer, lot 9" }),
        )
        .unwrap();

    let recipes = vault.heads(Kind::Recipe).unwrap();
    assert_eq!(recipes.len(), 1);
    assert_eq!(recipes[0].content["name"], "Shino");
    let materials = vault.heads(Kind::Material).unwrap();
    assert_eq!(materials.len(), 1);
    assert_eq!(materials[0].revision_id, spar3.revision_id);

    let history = vault.history(Kind::Material, spar.record_id).unwrap();
    let names: Vec<_> = history.iter().map(|r| (r.number, r.content["name"].clone())).collect();
    assert_eq!(
        names,
        [
            (3, json!("Custer, lot 9")),
            (2, json!("Custer, lot 8")),
            (1, json!("Custer, lot 7"))
        ]
    );
    assert_eq!(vault.history(Kind::Recipe, recipe.record_id).unwrap().len(), 1);

    // A record is only found as its own kind, so a recipe cannot continue a material.
    assert!(matches!(
        vault.history(Kind::Recipe, spar.record_id),
        Err(Error::NotFound)
    ));
    assert!(matches!(
        vault.save(Kind::Recipe, Some(spar3.revision_id), &json!({})),
        Err(Error::NotFound)
    ));
}

#[test]
fn a_revision_cannot_pass_as_another_kind() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    vault.save(Kind::Material, None, &json!({ "name": "Spar" })).unwrap();
    vault.conn.execute("UPDATE revisions SET kind = 'recipe'", []).unwrap();
    assert!(matches!(vault.heads(Kind::Recipe), Err(Error::Corrupt(_))));
}

#[test]
fn saving_many_at_once_saves_all_or_none() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    let first = vault.save(Kind::Material, None, &json!({ "name": "Spar" })).unwrap();
    let saved = vault
        .save_all(
            Kind::Material,
            None,
            &[
                (None, json!({ "name": "Frit" })),
                (Some(first.revision_id), json!({ "name": "Spar, lot 2" })),
            ],
        )
        .unwrap();
    assert_eq!(saved[1].record_id, first.record_id);
    assert_eq!(saved[1].number, 2);
    assert_eq!(vault.heads(Kind::Material).unwrap().len(), 2);

    // One that cannot be saved, here a parent that is not there, leaves out the rest too.
    let error = vault
        .save_all(
            Kind::Material,
            None,
            &[(None, json!({ "name": "Whiting" })), (Some(Uuid::new_v4()), json!({}))],
        )
        .unwrap_err();
    assert!(matches!(error, Error::NotFound));
    let names: Vec<_> = vault
        .heads(Kind::Material)
        .unwrap()
        .iter()
        .map(|r| r.content["name"].clone())
        .collect();
    assert_eq!(names.len(), 2);
    assert!(!names.contains(&json!("Whiting")));
    drop(vault);
    // And what was saved is still there after reopening.
    assert_eq!(
        Vault::unlock(dir.path(), PASSWORD)
            .unwrap()
            .heads(Kind::Material)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn deleting_hides_a_record_until_it_is_restored() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    let first = vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
    let second = vault
        .save(Kind::Recipe, Some(first.revision_id), &json!({ "name": "Shino 2" }))
        .unwrap();
    // Only the newest revision can delete, so a delete cannot fork the record.
    assert!(matches!(
        vault.delete(Kind::Recipe, first.revision_id),
        Err(Error::NotFound)
    ));

    let gone = vault.delete(Kind::Recipe, second.revision_id).unwrap();
    assert!(gone.deleted);
    assert_eq!((gone.number, &gone.content), (3, &json!({ "name": "Shino 2" })));
    assert!(vault.heads(Kind::Recipe).unwrap().is_empty());
    assert_eq!(vault.deleted(Kind::Recipe).unwrap()[0].revision_id, gone.revision_id);
    assert_eq!(vault.history(Kind::Recipe, first.record_id).unwrap().len(), 2);
    assert!(matches!(
        vault.delete(Kind::Recipe, gone.revision_id),
        Err(Error::NotFound)
    ));

    let back = vault.save(Kind::Recipe, Some(gone.revision_id), &gone.content).unwrap();
    assert_eq!((back.number, back.deleted), (4, false));
    assert_eq!(vault.heads(Kind::Recipe).unwrap()[0].revision_id, back.revision_id);
    assert!(vault.deleted(Kind::Recipe).unwrap().is_empty());
}

#[test]
fn erasing_removes_every_revision_of_a_deleted_record() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    let kept = vault.save(Kind::Recipe, None, &json!({ "name": "Tenmoku" })).unwrap();
    let first = vault
        .save(Kind::Recipe, None, &json!({ "name": "Secret Celadon" }))
        .unwrap();
    let second = vault
        .save(
            Kind::Recipe,
            Some(first.revision_id),
            &json!({ "name": "Secret Celadon 2" }),
        )
        .unwrap();
    assert!(matches!(
        vault.erase(Kind::Recipe, first.record_id),
        Err(Error::NotDeleted)
    ));

    vault.delete(Kind::Recipe, second.revision_id).unwrap();
    assert_eq!(vault.erase(Kind::Recipe, first.record_id).unwrap(), 3);
    assert!(vault.deleted(Kind::Recipe).unwrap().is_empty());
    assert!(matches!(
        vault.history(Kind::Recipe, first.record_id),
        Err(Error::NotFound)
    ));
    assert_eq!(vault.heads(Kind::Recipe).unwrap()[0].record_id, kept.record_id);
    let left: i64 = vault
        .conn
        .query_row(
            "SELECT count(*) FROM revisions WHERE record_id = ?1",
            params![first.record_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
    // A tombstone remembers it, and the change log lists that in place of its revisions.
    let (kind, by): (String, String) = vault
        .conn
        .query_row(
            "SELECT kind, erased_by FROM erased WHERE record_id = ?1",
            params![first.record_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((kind.as_str(), by), ("recipe", vault.user_id.to_string()));
    // So is the event that erased it (ADR 18), in the collection's part of the log.
    let logged = changes(&vault);
    assert_eq!(logged[0], ("revision".to_owned(), kept.revision_id.to_string()));
    assert_eq!(logged.len(), 2);
    let (name, actor, _) = events::kept(&vault.conn).pop().unwrap();
    assert_eq!((name.as_str(), actor), ("erased", Some(vault.user_id.to_string())));
    assert_eq!(logged[1].0, "event");
}

/// The change log's entries for collections, in order, as (item, id): what is saved, and the
/// events about records, without the directory's or the collection's own making.
fn changes(vault: &Vault) -> Vec<(String, String)> {
    let mut statement = vault
        .conn
        .prepare(
            "SELECT item, item_id FROM changes WHERE collection_id IS NOT NULL
             AND item_id NOT IN (SELECT id FROM events WHERE type = 'collection-created') ORDER BY seq",
        )
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

#[test]
fn the_change_log_lists_what_is_saved_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    let recipe = vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
    let firing = vault.save(Kind::Firing, None, &json!({ "cone": "10" })).unwrap();
    let photo = vault
        .add_attachment(Kind::Firing, firing.record_id, "image/png", b"tile")
        .unwrap();
    let saved = vault
        .save_all(Kind::Material, None, &[(None, json!({ "name": "Spar" }))])
        .unwrap();
    // A save that fails leaves nothing in the log either.
    assert!(
        vault
            .save_all(
                Kind::Material,
                None,
                &[(None, json!({})), (Some(Uuid::new_v4()), json!({}))]
            )
            .is_err()
    );
    let item = |item: &str, id: Uuid| (item.to_owned(), id.to_string());
    assert_eq!(
        changes(&vault),
        [
            item("revision", recipe.revision_id),
            item("revision", firing.revision_id),
            item("attachment", photo.id),
            item("revision", saved[0].revision_id),
        ]
    );
    let hash: Vec<u8> = vault
        .conn
        .query_row(
            "SELECT sha256 FROM attachments WHERE id = ?1",
            params![photo.id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    let (nonce, ciphertext): (Vec<u8>, Vec<u8>) = vault
        .conn
        .query_row(
            "SELECT nonce, ciphertext FROM attachments WHERE id = ?1",
            params![photo.id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(hash, crypto::sha256(&[&nonce, &ciphertext]));
}

#[test]
fn a_fork_is_listed_with_its_other_version_until_one_is_chosen() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    let first = vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
    // Two changes from the same revision, as on two computers.
    let ours = vault
        .save(Kind::Recipe, Some(first.revision_id), &json!({ "name": "Shino, ours" }))
        .unwrap();
    let theirs = vault
        .save(
            Kind::Recipe,
            Some(first.revision_id),
            &json!({ "name": "Shino, theirs" }),
        )
        .unwrap();
    let heads = vault.heads(Kind::Recipe).unwrap();
    assert_eq!(heads.len(), 1);
    assert_eq!(theirs.forks.len(), 1);
    assert_eq!(theirs.forks[0].revision_id, ours.revision_id);
    let other = if heads[0].revision_id == ours.revision_id {
        &theirs
    } else {
        &ours
    };
    assert_eq!(heads[0].forks.len(), 1);
    assert_eq!(heads[0].forks[0].revision_id, other.revision_id);
    assert!(!heads[0].forks[0].deleted);
    assert_eq!(vault.history(Kind::Recipe, first.record_id).unwrap().len(), 3);

    // The others must be all of them, and only them.
    for others in [
        vec![],
        vec![first.revision_id],
        vec![theirs.revision_id, first.revision_id],
    ] {
        assert!(matches!(
            vault.resolve_fork(Kind::Recipe, ours.revision_id, &others),
            Err(Error::ForkChanged)
        ));
    }
    let chosen = vault
        .resolve_fork(Kind::Recipe, ours.revision_id, &[theirs.revision_id])
        .unwrap();
    assert_eq!((chosen.number, &chosen.content), (3, &ours.content));
    let heads = vault.heads(Kind::Recipe).unwrap();
    assert_eq!(heads.len(), 1);
    assert_eq!(heads[0].revision_id, chosen.revision_id);
    assert!(heads[0].forks.is_empty());
    // What was set aside is in the history, and is no longer one of the newest.
    assert_eq!(vault.history(Kind::Recipe, first.record_id).unwrap().len(), 4);
    assert!(matches!(
        vault.delete(Kind::Recipe, theirs.revision_id),
        Err(Error::NotFound)
    ));
    assert!(matches!(
        vault.resolve_fork(Kind::Recipe, chosen.revision_id, &[]),
        Err(Error::ForkChanged)
    ));
    drop(vault);
    let vault = Vault::unlock(dir.path(), PASSWORD).unwrap();
    assert_eq!(vault.heads(Kind::Recipe).unwrap()[0].revision_id, chosen.revision_id);

    // The list of what it sets aside is bound to it.
    vault
        .conn
        .execute(
            "UPDATE revisions SET supersedes = ?1 WHERE id = ?2",
            params![ours.revision_id.to_string(), chosen.revision_id.to_string()],
        )
        .unwrap();
    assert!(matches!(vault.heads(Kind::Recipe), Err(Error::Corrupt(_))));
}

#[test]
fn a_delete_against_an_edit_keeps_the_edit() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    let first = vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
    let edited = vault
        .save(Kind::Recipe, Some(first.revision_id), &json!({ "name": "Shino 2" }))
        .unwrap();
    // Deleted from the first revision, where the edit was not seen.
    let gone = vault
        .add_revision(Kind::Recipe, Some(first.revision_id), None, &first.content, true, &[])
        .unwrap();
    let heads = vault.heads(Kind::Recipe).unwrap();
    assert_eq!(heads.len(), 1);
    assert_eq!(heads[0].revision_id, edited.revision_id);
    assert_eq!(heads[0].forks.len(), 1);
    assert!(heads[0].forks[0].deleted);
    assert!(vault.deleted(Kind::Recipe).unwrap().is_empty());
    assert!(matches!(
        vault.erase(Kind::Recipe, first.record_id),
        Err(Error::NotDeleted)
    ));

    // Choosing the delete deletes it.
    let chosen = vault
        .resolve_fork(Kind::Recipe, gone.revision_id, &[edited.revision_id])
        .unwrap();
    assert!(chosen.deleted);
    assert!(vault.heads(Kind::Recipe).unwrap().is_empty());
    assert_eq!(vault.deleted(Kind::Recipe).unwrap()[0].revision_id, chosen.revision_id);
    assert!(vault.deleted(Kind::Recipe).unwrap()[0].forks.is_empty());
}

#[test]
fn a_deletion_cannot_be_undone_without_the_key() {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    let saved = vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
    vault.delete(Kind::Recipe, saved.revision_id).unwrap();
    vault.conn.execute("UPDATE revisions SET deleted = 0", []).unwrap();
    assert!(matches!(vault.heads(Kind::Recipe), Err(Error::Corrupt(_))));
}
