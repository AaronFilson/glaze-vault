use super::*;
use crate::store;
use crate::vault::{Credential, Kind};
use serde_json::json;
use std::fs;

const PASSWORD: &str = "cone six oxidation";
const ONE_TIME: &str = "pass this on";
const BENS: &str = "bens own password";

fn names(vault: &Vault, kind: Kind) -> Vec<String> {
    let mut names: Vec<String> = vault
        .heads(kind)
        .unwrap()
        .iter()
        .map(|r| r.content["name"].as_str().unwrap().to_owned())
        .collect();
    names.sort();
    names
}

/// A one-person vault with a recipe and a draft, grown into a team with Ana as admin.
fn team() -> (tempfile::TempDir, Vault, RecoveryKey) {
    let dir = tempfile::tempdir().unwrap();
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    vault.save(Kind::Recipe, None, &json!({ "name": "Shino" })).unwrap();
    vault.save_draft(&json!({ "editing": "Celadon" })).unwrap();
    let recovery = vault.grow_into_team(" Ana ").unwrap();
    (dir, vault, recovery)
}

fn shared(vault: &Vault) -> Uuid {
    vault.collections().iter().find(|c| c.name == SHARED).unwrap().id
}

fn private_of(vault: &Vault, person: Uuid) -> Uuid {
    vault.collections().iter().find(|c| c.owner == Some(person)).unwrap().id
}

#[test]
fn growing_keeps_everything_and_asks_for_a_name_after() {
    let (dir, vault, recovery) = team();
    assert_eq!(recovery.words().len(), 24);
    let ana = vault.me();
    assert!(ana.admin && ana.name == "Ana" && vault.is_team());
    assert_eq!(vault.collections().len(), 2);
    assert_eq!(names(&vault, Kind::Recipe), ["Shino"]);
    assert_eq!(vault.draft().unwrap().unwrap(), json!({ "editing": "Celadon" }));
    drop(vault);

    // While Ana is the only one, her name is not needed.
    Vault::unlock(dir.path(), PASSWORD).unwrap();
    let people = Vault::people_in(dir.path()).unwrap();
    assert_eq!(people.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Ana"]);
    let vault = Vault::unlock_as(dir.path(), Some(ana.id), PASSWORD).unwrap();
    assert_eq!(names(&vault, Kind::Recipe), ["Shino"]);
    assert_eq!(vault.draft().unwrap().unwrap(), json!({ "editing": "Celadon" }));
    assert!(matches!(vault.grants(), Ok(grants) if grants.len() == 2));
}

#[test]
fn a_vault_for_one_keeps_its_old_key_file() {
    let dir = tempfile::tempdir().unwrap();
    Vault::create(dir.path(), PASSWORD).unwrap();
    let text = fs::read_to_string(dir.path().join(KEYRING_FILE)).unwrap();
    assert!(text.contains("\"format\": 1"));
    for field in [
        "organization",
        "public_key",
        "must_set_password",
        "previous_database_key",
    ] {
        assert!(!text.contains(field), "{field}");
    }
    assert!(Vault::people_in(dir.path()).unwrap().is_empty());
}

#[test]
fn someone_added_sees_only_what_they_were_given_once_they_choose_a_password() {
    let (dir, mut ana, _) = team();
    let shared = shared(&ana);
    let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
    assert!(ben.must_set_password && !ben.admin);
    assert!(matches!(Vault::unlock(dir.path(), PASSWORD), Err(Error::ChooseName)));
    assert!(matches!(ana.add_person("ben", ONE_TIME, &[]), Err(Error::NameTaken)));
    ana.save_in(
        Kind::Recipe,
        private_of(&ana, ana.me().id),
        &json!({ "name": "Ana's secret" }),
    )
    .unwrap();

    // With the one-time password, nothing opens until Ben chooses his own.
    let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
    assert!(as_ben.collections().is_empty() && names(&as_ben, Kind::Recipe).is_empty());
    assert!(matches!(
        as_ben.save(Kind::Recipe, None, &json!({})),
        Err(Error::NotFound)
    ));
    let recovery = as_ben.set_own_password(BENS).unwrap();
    assert!(matches!(as_ben.set_own_password(BENS), Err(Error::NotAllowed)));
    drop(as_ben);
    assert!(matches!(
        Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME),
        Err(Error::WrongPassword)
    ));

    let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
    assert_eq!(names(&as_ben, Kind::Recipe), ["Shino"]);
    assert!(matches!(
        as_ben.save_in(Kind::Recipe, shared, &json!({ "name": "Mine" })),
        Err(Error::NotAllowed)
    ));
    let head = as_ben.heads(Kind::Recipe).unwrap().remove(0);
    assert!(matches!(
        as_ben.delete(Kind::Recipe, head.revision_id),
        Err(Error::NotAllowed)
    ));
    assert!(matches!(as_ben.people(), Err(Error::NotAllowed)));
    let bens_private = private_of(&as_ben, ben.id);
    as_ben
        .save_in(Kind::Recipe, bens_private, &json!({ "name": "Ben's test" }))
        .unwrap();
    drop(as_ben);

    // His recovery key works, and an admin sees his private collection too.
    Vault::recover_as(
        dir.path(),
        Some(ben.id),
        &recovery.words().join(" "),
        "bens newer password",
    )
    .unwrap();
    ana.load_collections().unwrap();
    assert_eq!(names(&ana, Kind::Recipe), ["Ana's secret", "Ben's test", "Shino"]);
}

#[test]
fn a_batch_operator_opens_batch_sheets_and_nothing_else() {
    let (dir, mut ana, _) = team();
    let shared = shared(&ana);
    let sheet = ana
        .save_in(
            Kind::Batch,
            shared,
            &json!({ "name": "Shino", "lines": [{ "material": "M-104", "amount": "40" }] }),
        )
        .unwrap();
    let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Operator)]).unwrap();
    let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
    as_ben.set_own_password(BENS).unwrap();

    assert_eq!(names(&as_ben, Kind::Batch), ["Shino"]);
    assert!(names(&as_ben, Kind::Recipe).is_empty());
    assert!(names(&as_ben, Kind::Material).is_empty());
    let recipe = ana.heads(Kind::Recipe).unwrap()[0].record_id;
    assert!(matches!(as_ben.history(Kind::Recipe, recipe), Err(Error::NotFound)));
    assert!(matches!(
        as_ben.save(Kind::Batch, Some(sheet.revision_id), &json!({ "name": "Changed" })),
        Err(Error::NotAllowed)
    ));
    assert!(matches!(
        as_ben.save_in(Kind::Recipe, shared, &json!({ "name": "Ben's glaze" })),
        Err(Error::NotAllowed)
    ));
    // What Ben holds is the batch key, made from the collection's key, which it does not lead
    // back to, so it opens no recipe, whatever the app does.
    let held = as_ben.readable(&shared).unwrap().key.clone();
    let collection_key = ana.readable(&shared).unwrap().key.clone();
    assert_eq!(*held, *super::super::batch_key(&collection_key, &shared));
    assert_ne!(*held, *collection_key);
    // They log a mix of the sheet, under the batch key, which the rest of the team reads.
    let mix = as_ben
        .save_in(Kind::Mix, shared, &json!({ "name": "Shino", "lots": ["L-7"] }))
        .unwrap();
    assert_eq!(names(&as_ben, Kind::Mix), ["Shino"]);
    assert_eq!(names(&ana, Kind::Mix), ["Shino"]);
    as_ben
        .save(
            Kind::Mix,
            Some(mix.revision_id),
            &json!({ "name": "Shino", "lots": ["L-8"] }),
        )
        .unwrap();
    // In their own private collection, Ben does as he likes.
    let own = private_of(&as_ben, ben.id);
    as_ben
        .save_in(Kind::Recipe, own, &json!({ "name": "Ben's glaze" }))
        .unwrap();
}

#[test]
fn making_someone_a_batch_operator_changes_the_collections_key() {
    let (dir, mut ana, _) = team();
    let shared = shared(&ana);
    ana.save_in(Kind::Batch, shared, &json!({ "name": "Shino" })).unwrap();
    let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
    let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
    as_ben.set_own_password(BENS).unwrap();
    let kept_key = as_ben.readable(&shared).unwrap().key.clone();
    drop(as_ben);

    ana.save_in(Kind::Mix, shared, &json!({ "name": "Shino" })).unwrap();
    ana.set_role(ben.id, shared, Some(Role::Operator)).unwrap();
    assert_ne!(*ana.readable(&shared).unwrap().key, *kept_key);
    assert_eq!(names(&ana, Kind::Mix), ["Shino"]);
    assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
    assert_eq!(names(&ana, Kind::Batch), ["Shino"]);
    let as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
    assert!(names(&as_ben, Kind::Recipe).is_empty());
    assert_eq!(names(&as_ben, Kind::Batch), ["Shino"]);
    assert_eq!(names(&as_ben, Kind::Mix), ["Shino"]);
    drop(as_ben);

    // And taking it away again starts another key epoch, under which the sheets still open.
    ana.set_role(ben.id, shared, None).unwrap();
    assert_eq!(names(&ana, Kind::Batch), ["Shino"]);
}

#[test]
fn taking_a_role_away_changes_the_collections_key() {
    let (dir, mut ana, _) = team();
    let shared = shared(&ana);
    let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Formulator)]).unwrap();
    let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
    as_ben.set_own_password(BENS).unwrap();
    as_ben
        .save_in(Kind::Recipe, shared, &json!({ "name": "Ben's glaze" }))
        .unwrap();
    let kept_key = as_ben.readable(&shared).unwrap().key.clone();
    drop(as_ben);

    ana.set_role(ben.id, shared, None).unwrap();
    assert_ne!(*ana.readable(&shared).unwrap().key, *kept_key);
    assert_eq!(names(&ana, Kind::Recipe), ["Ben's glaze", "Shino"]);
    let as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
    assert!(names(&as_ben, Kind::Recipe).is_empty());
    drop(as_ben);
    drop(ana);
    let ana = Vault::unlock_as(
        dir.path(),
        Vault::people_in(dir.path())
            .unwrap()
            .iter()
            .find(|p| p.admin)
            .map(|p| p.id),
        PASSWORD,
    )
    .unwrap();
    assert_eq!(names(&ana, Kind::Recipe), ["Ben's glaze", "Shino"]);
}

#[test]
fn removing_someone_changes_the_database_key_too() {
    let (dir, mut ana, _) = team();
    let ana_id = ana.me().id;
    let shared = shared(&ana);
    let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
    let old_database_key = ana.database_key().unwrap();
    assert!(matches!(ana.remove_person(ana_id), Err(Error::NotAllowed)));
    ana.remove_person(ben.id).unwrap();
    assert!(matches!(
        Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME),
        Err(Error::NoSuchPerson)
    ));
    drop(ana);
    assert!(store::open(&dir.path().join(super::super::DATABASE_FILE), &old_database_key).is_err());
    let ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
    assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
    // Ben's private collection stays, for admins.
    assert_eq!(ana.collections().len(), 3);
}

#[test]
fn a_change_of_database_key_that_stopped_part_way_is_finished_on_opening() {
    let (dir, ana, _) = team();
    let ana_id = ana.me().id;
    // As if the key file was written with the new key, and the app stopped before the
    // database changed to it.
    let mut keyring = ana.keyring.clone();
    let new = crypto::random_key();
    let sealed = crypto::seal_key(
        &ana.keys.public,
        &new,
        &keyring::database_key_info(&keyring.vault_id, &ana_id),
    );
    let user = super::super::user_mut(&mut keyring, &ana_id);
    user.previous_database_key = Some(std::mem::replace(&mut user.database_key, sealed));
    drop(ana);
    keyring.write(&dir.path().join(KEYRING_FILE)).unwrap();

    let ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
    assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
    assert!(ana.keyring.users.iter().all(|u| u.previous_database_key.is_none()));
    drop(ana);
    assert!(store::open(&dir.path().join(super::super::DATABASE_FILE), &new).is_ok());
}

#[test]
fn an_admin_resets_someone_who_lost_everything() {
    let (dir, mut ana, _) = team();
    let shared = shared(&ana);
    let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
    let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
    let old_sheet = as_ben.set_own_password(BENS).unwrap();
    drop(as_ben);

    ana.reset_person(ben.id, "a new one-time").unwrap();
    assert!(matches!(
        Vault::unlock_as(dir.path(), Some(ben.id), BENS),
        Err(Error::WrongPassword)
    ));
    let words = old_sheet.words().join(" ");
    assert!(matches!(
        Vault::recover_as(dir.path(), Some(ben.id), &words, "whatever it is"),
        Err(Error::WrongRecoveryKey)
    ));
    let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), "a new one-time").unwrap();
    assert!(as_ben.me().must_set_password);
    as_ben.set_own_password(BENS).unwrap();
    assert_eq!(names(&as_ben, Kind::Recipe), ["Shino"]);
}

#[test]
fn the_organization_recovery_key_gets_an_admin_back_in() {
    let (dir, mut ana, organization_sheet) = team();
    let ana_id = ana.me().id;
    let ben = ana.add_person("Ben", ONE_TIME, &[]).unwrap();
    drop(ana);
    let words = organization_sheet.words().join(" ");
    assert!(matches!(
        Vault::recover_organization(dir.path(), &words, ben.id, "new admin password"),
        Err(Error::NotAllowed)
    ));
    let (ana, sheet) = Vault::recover_organization(dir.path(), &words, ana_id, "new admin password").unwrap();
    assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
    assert!(ana.me().admin);
    drop(ana);
    Vault::recover_as(dir.path(), Some(ana_id), &sheet.words().join(" "), "and another one").unwrap();
}

#[test]
fn only_admins_back_up_and_restore_a_teams_vault() {
    let (dir, mut ana, organization_sheet) = team();
    let ana_id = ana.me().id;
    let shared = shared(&ana);
    let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Formulator)]).unwrap();
    let files = tempfile::tempdir().unwrap();
    let path = files.path().join("team.gvbackup");
    ana.back_up(&path).unwrap();
    let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
    as_ben.set_own_password(BENS).unwrap();
    assert!(matches!(
        as_ben.back_up(&files.path().join("b.gvbackup")),
        Err(Error::NotAllowed)
    ));
    drop(as_ben);
    drop(ana);

    let info = Vault::backup_info(&path).unwrap();
    assert_eq!(info.admins.iter().map(|p| p.id).collect::<Vec<_>>(), [ana_id]);
    let elsewhere = tempfile::tempdir().unwrap();
    assert!(matches!(
        Vault::restore(elsewhere.path(), &path, Some(ben.id), &Credential::Password(ONE_TIME)),
        Err(Error::NotAllowed)
    ));
    let (restored, _) = Vault::restore(elsewhere.path(), &path, Some(ana_id), &Credential::Password(PASSWORD)).unwrap();
    assert_eq!(restored.people().unwrap().len(), 2);
    drop(restored);

    let again = tempfile::tempdir().unwrap();
    let words = organization_sheet.words().join(" ");
    let (restored, _, _) =
        Vault::restore_by_organization(again.path(), &path, &words, ana_id, "new admin password").unwrap();
    assert_eq!(names(&restored, Kind::Recipe), ["Shino"]);
}

#[test]
fn only_an_admin_here_restores_over_a_teams_vault() {
    let (dir, mut ana, organization_sheet) = team();
    let ana_id = ana.me().id;
    let files = tempfile::tempdir().unwrap();
    let team_backup = files.path().join("team.gvbackup");
    ana.back_up(&team_backup).unwrap();
    ana.add_person("Ben", ONE_TIME, &[(shared(&ana), Role::Chemist)])
        .unwrap();
    drop(ana);
    // Ben's own vault, elsewhere, whose password he knows.
    let elsewhere = tempfile::tempdir().unwrap();
    let (mut bens, _) = Vault::create(elsewhere.path(), BENS).unwrap();
    let bens_backup = files.path().join("bens.gvbackup");
    bens.back_up(&bens_backup).unwrap();
    drop(bens);

    assert!(matches!(
        Vault::restore(dir.path(), &bens_backup, None, &Credential::Password(BENS)),
        Err(Error::NotAnAdminHere)
    ));
    assert_eq!(Vault::people_in(dir.path()).unwrap().len(), 2);
    assert!(Vault::set_aside(dir.path()).unwrap().is_empty());

    let (restored, set_aside) =
        Vault::restore(dir.path(), &team_backup, Some(ana_id), &Credential::Password(PASSWORD)).unwrap();
    assert!(set_aside.is_some());
    drop(restored);
    let words = organization_sheet.words().join(" ");
    Vault::restore_by_organization(dir.path(), &team_backup, &words, ana_id, "new admin password").unwrap();
}

#[cfg(unix)]
#[test]
fn removing_someone_can_be_finished_after_it_fails() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, mut ana, _) = team();
    let ben = ana
        .add_person("Ben", ONE_TIME, &[(shared(&ana), Role::Chemist)])
        .unwrap();
    // The key file cannot be written, so the database key cannot change.
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
    let failed = ana.remove_person(ben.id);
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(failed.is_err());
    // Ben is still listed, so nothing written later drops him while the database key stays.
    assert!(ana.people().unwrap().iter().any(|p| p.id == ben.id));
    assert!(Vault::people_in(dir.path()).unwrap().iter().any(|p| p.id == ben.id));
    assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);

    ana.remove_person(ben.id).unwrap();
    assert!(ana.people().unwrap().iter().all(|p| p.id != ben.id));
    assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
    assert!(matches!(
        Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME),
        Err(Error::NoSuchPerson)
    ));
}

#[test]
fn taking_admin_away_gives_the_organization_and_every_collection_new_keys() {
    let (dir, mut ana, organization_sheet) = team();
    let ana_id = ana.me().id;
    let shared = shared(&ana);
    let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Formulator)]).unwrap();
    ana.make_admin(ben.id).unwrap();
    let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
    as_ben.set_own_password(BENS).unwrap();
    assert!(as_ben.me().admin);
    drop(as_ben);
    // One person signs in at a time, as in the app.
    drop(ana);
    let mut ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
    let kept_key = ana.readable(&shared).unwrap().key.clone();

    assert!(matches!(ana.take_admin_away(ana_id), Err(Error::NotAllowed)));
    assert!(matches!(ana.remove_person(ben.id), Err(Error::RemovingAdmin)));
    let new_sheet = ana.take_admin_away(ben.id).unwrap();
    assert!(matches!(ana.take_admin_away(ben.id), Err(Error::NotAnAdmin)));
    assert_ne!(*ana.readable(&shared).unwrap().key, *kept_key);
    assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
    assert!(!ana.people().unwrap().iter().find(|p| p.id == ben.id).unwrap().admin);

    // Ben keeps his role on Shared, and nothing more.
    let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
    assert!(!as_ben.me().admin);
    assert_eq!(names(&as_ben, Kind::Recipe), ["Shino"]);
    as_ben
        .save_in(Kind::Recipe, shared, &json!({ "name": "Ben's" }))
        .unwrap();
    assert!(matches!(as_ben.people(), Err(Error::NotAllowed)));
    assert!(
        as_ben
            .collections()
            .iter()
            .all(|c| c.id == shared || c.owner == Some(ben.id))
    );
    drop(as_ben);

    // The old organization sheet no longer opens anything; the new one does.
    drop(ana);
    let old = organization_sheet.words().join(" ");
    assert!(matches!(
        Vault::recover_organization(dir.path(), &old, ana_id, "anas new password"),
        Err(Error::WrongRecoveryKey)
    ));
    let (mut ana, _) =
        Vault::recover_organization(dir.path(), &new_sheet.words().join(" "), ana_id, "anas new password").unwrap();
    assert_eq!(names(&ana, Kind::Recipe), ["Ben's", "Shino"]);

    // And now he can be removed.
    ana.remove_person(ben.id).unwrap();
    assert!(matches!(
        Vault::unlock_as(dir.path(), Some(ben.id), BENS),
        Err(Error::NoSuchPerson)
    ));
}

#[cfg(unix)]
#[test]
fn a_change_of_organization_key_that_stopped_is_finished_at_the_next_unlock() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, mut ana, _) = team();
    let ana_id = ana.me().id;
    let ben = ana.add_person("Ben", ONE_TIME, &[]).unwrap();
    ana.make_admin(ben.id).unwrap();
    // The collections change, and then the key file cannot be written.
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
    let failed = ana.take_admin_away(ben.id);
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(failed.is_err());
    // Still open, with the new key, so what is saved now is sealed as the collections are.
    ana.save(Kind::Recipe, None, &json!({ "name": "Tenmoku" })).unwrap();
    drop(ana);

    let mut ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
    assert!(ana.me().admin);
    assert_eq!(names(&ana, Kind::Recipe), ["Shino", "Tenmoku"]);
    assert!(
        !Vault::people_in(dir.path())
            .unwrap()
            .iter()
            .find(|p| p.id == ben.id)
            .unwrap()
            .admin
    );
    // The sheet that was not shown is replaced.
    let sheet = ana.new_organization_recovery_key().unwrap();
    drop(ana);
    Vault::recover_organization(dir.path(), &sheet.words().join(" "), ana_id, "anas new password").unwrap();
}

#[cfg(unix)]
#[test]
fn after_a_change_of_organization_key_stopped_the_next_one_builds_on_it() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, mut ana, old_sheet) = team();
    let ana_id = ana.me().id;
    let ben = ana.add_person("Ben", ONE_TIME, &[]).unwrap();
    let cara = ana.add_person("Cara", ONE_TIME, &[]).unwrap();
    ana.make_admin(ben.id).unwrap();
    ana.make_admin(cara.id).unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
    let failed = ana.take_admin_away(ben.id);
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(failed.is_err());

    // In the same session: Ben's change goes into the key file before Cara's starts, so he
    // does not get the newest organization key back.
    ana.take_admin_away(cara.id).unwrap();
    let admins: Vec<Uuid> = ana.people().unwrap().iter().filter(|p| p.admin).map(|p| p.id).collect();
    assert_eq!(admins, [ana_id]);
    // And a new sheet made now opens the organization the key file names.
    let sheet = ana.new_organization_recovery_key().unwrap();
    drop(ana);
    assert!(matches!(
        Vault::recover_organization(dir.path(), &old_sheet.words().join(" "), ana_id, "anas new password"),
        Err(Error::WrongRecoveryKey)
    ));
    let (ana, _) =
        Vault::recover_organization(dir.path(), &sheet.words().join(" "), ana_id, "anas new password").unwrap();
    assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
}

#[cfg(unix)]
#[test]
fn the_old_organization_sheet_does_not_open_a_change_that_stopped() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, mut ana, old_sheet) = team();
    let ana_id = ana.me().id;
    let ben = ana.add_person("Ben", ONE_TIME, &[]).unwrap();
    ana.make_admin(ben.id).unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
    assert!(ana.take_admin_away(ben.id).is_err());
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
    drop(ana);
    // Nobody has unlocked since: recovering finishes the change, and the old sheet is refused.
    assert!(matches!(
        Vault::recover_organization(dir.path(), &old_sheet.words().join(" "), ana_id, "anas new password"),
        Err(Error::WrongRecoveryKey)
    ));
    let ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
    assert!(
        !Vault::people_in(dir.path())
            .unwrap()
            .iter()
            .find(|p| p.id == ben.id)
            .unwrap()
            .admin
    );
    assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
}

#[test]
fn admins_make_collections_and_admins() {
    let (dir, mut ana, _) = team();
    let ben = ana.add_person("Ben", ONE_TIME, &[]).unwrap();
    let glazes = ana.create_collection("  Production glazes ").unwrap();
    assert_eq!(glazes.name, "Production glazes");
    ana.save_in(Kind::Recipe, glazes.id, &json!({ "name": "Tenmoku" }))
        .unwrap();
    ana.rename_collection(glazes.id, "Production").unwrap();
    assert!(matches!(
        ana.rename_collection(private_of(&ana, ana.me().id), "Mine"),
        Err(Error::NotAllowed)
    ));
    ana.make_admin(ben.id).unwrap();
    assert!(matches!(ana.remove_person(ben.id), Err(Error::RemovingAdmin)));
    let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
    as_ben.set_own_password(BENS).unwrap();
    assert!(as_ben.me().admin);
    assert_eq!(names(&as_ben, Kind::Recipe), ["Shino", "Tenmoku"]);
    assert!(as_ben.collections().iter().any(|c| c.name == "Production"));
    assert!(matches!(ana.make_admin(Uuid::new_v4()), Err(Error::NoSuchPerson)));
}

#[test]
fn a_batch_operator_made_admin_opens_the_collection() {
    let (dir, mut ana, _) = team();
    let shared = shared(&ana);
    let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Operator)]).unwrap();
    ana.make_admin(ben.id).unwrap();
    let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
    as_ben.set_own_password(BENS).unwrap();
    assert_eq!(
        *as_ben.readable(&shared).unwrap().key,
        *ana.readable(&shared).unwrap().key
    );
    assert_eq!(names(&as_ben, Kind::Recipe), ["Shino"]);
    as_ben.set_role(ben.id, shared, Some(Role::Chemist)).unwrap();
    assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);
}

#[test]
fn a_team_goes_back_to_one_person_and_can_grow_again() {
    let (dir, mut ana, _) = team();
    let ana_id = ana.me().id;
    let shared = shared(&ana);
    let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Formulator)]).unwrap();
    let mut as_ben = Vault::unlock_as(dir.path(), Some(ben.id), ONE_TIME).unwrap();
    as_ben.set_own_password(BENS).unwrap();
    as_ben
        .save_in(
            Kind::Recipe,
            private_of(&as_ben, ben.id),
            &json!({ "name": "Ben's test" }),
        )
        .unwrap();
    let bens_shared_key = as_ben.readable(&shared).unwrap().key.clone();
    drop(as_ben);
    ana.load_collections().unwrap();

    let backup = ana.go_back_to_one_person().unwrap();
    assert!(backup.is_file());
    assert!(!ana.is_team());
    assert_ne!(*ana.readable(&shared).unwrap().key, *bens_shared_key);
    assert_eq!(names(&ana, Kind::Recipe), ["Ben's test", "Shino"]);
    assert!(
        ana.collections()
            .iter()
            .any(|c| c.name == "From Ben" && c.owner.is_none())
    );
    assert_eq!(ana.draft().unwrap().unwrap(), json!({ "editing": "Celadon" }));
    drop(ana);

    assert!(Vault::people_in(dir.path()).unwrap().is_empty());
    let text = fs::read_to_string(dir.path().join(KEYRING_FILE)).unwrap();
    assert!(text.contains("\"format\": 1") && !text.contains("organization"));
    assert!(matches!(
        Vault::unlock_as(dir.path(), Some(ben.id), BENS),
        Err(Error::NoSuchPerson)
    ));
    let mut ana = Vault::unlock(dir.path(), PASSWORD).unwrap();
    assert_eq!(names(&ana, Kind::Recipe), ["Ben's test", "Shino"]);

    // Growing again keeps Ana's private collection rather than making another.
    ana.grow_into_team("Ana").unwrap();
    assert_eq!(ana.collections().iter().filter(|c| c.owner == Some(ana_id)).count(), 1);
    assert_eq!(names(&ana, Kind::Recipe), ["Ben's test", "Shino"]);
}

type Stored = (String, Vec<u8>, Option<Vec<u8>>, i64);

/// The stored rows of a collection, as bytes, to see that a change of key leaves them alone.
fn stored(vault: &Vault, collection: Uuid) -> Vec<Stored> {
    let mut statement = vault
        .conn
        .prepare(
            "SELECT id, ciphertext, summary, epoch FROM revisions WHERE collection_id = ?1
             UNION ALL SELECT id, ciphertext, NULL, epoch FROM attachments WHERE collection_id = ?1 ORDER BY 1",
        )
        .unwrap();
    statement
        .query_map(params![collection.to_string()], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

#[test]
fn taking_a_role_away_starts_a_new_key_epoch_and_leaves_what_is_stored() {
    let (dir, mut ana, _) = team();
    let ana_id = ana.me().id;
    let shared = shared(&ana);
    let shino = ana.heads(Kind::Recipe).unwrap()[0].clone();
    ana.save_in(Kind::Batch, shared, &json!({ "name": "Shino sheet" }))
        .unwrap();
    let firing = ana
        .save_in(Kind::Firing, shared, &json!({ "name": "Cone 10" }))
        .unwrap();
    let photo = ana
        .add_attachment(Kind::Firing, firing.record_id, "image/jpeg", b"tile")
        .unwrap();
    let reader = ana
        .create_role(
            "Sales",
            &[Kind::Firing],
            Capabilities {
                chemistry: false,
                ..Capabilities::BUILT_IN
            },
        )
        .unwrap();
    let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Formulator)]).unwrap();
    let cleo = ana.add_person("Cleo", ONE_TIME, &[(shared, Role::Operator)]).unwrap();
    let dee = ana
        .add_person("Dee", ONE_TIME, &[(shared, Role::Custom(reader.id))])
        .unwrap();
    for person in [ben.id, cleo.id, dee.id] {
        Vault::unlock_as(dir.path(), Some(person), ONE_TIME)
            .unwrap()
            .set_own_password(BENS)
            .unwrap();
    }
    let bens_key = Vault::unlock_as(dir.path(), Some(ben.id), BENS)
        .unwrap()
        .readable(&shared)
        .unwrap()
        .key
        .clone();
    let before = stored(&ana, shared);

    ana.set_role(ben.id, shared, None).unwrap();
    // Nothing stored changed: only the collection's key did, at epoch 2.
    assert_eq!(stored(&ana, shared), before);
    let open = ana.readable(&shared).unwrap();
    assert_eq!(open.epoch, 2);
    assert_ne!(*open.key, *bens_key);
    assert_eq!(**open.key_at(1).unwrap(), *bens_key);
    assert_eq!(names(&ana, Kind::Recipe), ["Shino"]);

    // What is saved now goes under the new key, which Ben's old one does not open.
    let tenmoku = ana
        .save_in(Kind::Recipe, shared, &json!({ "name": "Tenmoku" }))
        .unwrap();
    let (epoch, nonce, ciphertext): (i64, Vec<u8>, Vec<u8>) = ana
        .conn
        .query_row(
            "SELECT epoch, nonce, ciphertext FROM revisions WHERE id = ?1",
            params![tenmoku.revision_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(epoch, 2);
    let aad = super::super::revision_aad(
        &tenmoku.revision_id,
        &tenmoku.record_id,
        "recipe",
        &shared,
        1,
        None,
        false,
        None,
    );
    assert!(crypto::decrypt(&bens_key, &crypto::Sealed { nonce, ciphertext }, &aad).is_none());
    let shino_row: (Vec<u8>, Vec<u8>) = ana
        .conn
        .query_row(
            "SELECT nonce, ciphertext FROM revisions WHERE id = ?1",
            params![shino.revision_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let aad = super::super::revision_aad(
        &shino.revision_id,
        &shino.record_id,
        "recipe",
        &shared,
        1,
        None,
        false,
        None,
    );
    let sealed = crypto::Sealed {
        nonce: shino_row.0,
        ciphertext: shino_row.1,
    };
    assert!(crypto::decrypt(&bens_key, &sealed, &aad).is_some());

    // Those who stay read both epochs, each with the key they hold, after unlocking again.
    drop(ana);
    let ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
    assert_eq!(names(&ana, Kind::Recipe), ["Shino", "Tenmoku"]);
    let as_cleo = Vault::unlock_as(dir.path(), Some(cleo.id), BENS).unwrap();
    assert_eq!(as_cleo.readable(&shared).unwrap().epoch, 2);
    assert_eq!(names(&as_cleo, Kind::Batch), ["Shino sheet"]);
    assert!(names(&as_cleo, Kind::Recipe).is_empty());
    let as_dee = Vault::unlock_as(dir.path(), Some(dee.id), BENS).unwrap();
    assert_eq!(names(&as_dee, Kind::Firing), ["Cone 10"]);
    assert_eq!(names(&as_dee, Kind::Recipe), ["Shino", "Tenmoku"]);
    assert_eq!(&as_dee.attachment(photo.id).unwrap().1[..], b"tile");
    let as_ben = Vault::unlock_as(dir.path(), Some(ben.id), BENS).unwrap();
    assert!(names(&as_ben, Kind::Recipe).is_empty());
}

#[test]
fn a_grant_from_an_earlier_epoch_is_refused() {
    let (dir, mut ana, _) = team();
    let shared = shared(&ana);
    let ben = ana.add_person("Ben", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
    let cleo = ana.add_person("Cleo", ONE_TIME, &[(shared, Role::Chemist)]).unwrap();
    Vault::unlock_as(dir.path(), Some(cleo.id), ONE_TIME)
        .unwrap()
        .set_own_password(BENS)
        .unwrap();
    // Cleo's grant at epoch 1, kept to put back.
    let (enc, ciphertext): (Vec<u8>, Vec<u8>) = ana
        .conn
        .query_row(
            "SELECT enc, ciphertext FROM grants WHERE user_id = ?1 AND collection_id = ?2",
            params![cleo.id.to_string(), shared.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    ana.set_role(ben.id, shared, None).unwrap();
    // Labelled as the current epoch, the old key does not open: the epoch is sealed with it.
    ana.conn
        .execute(
            "UPDATE grants SET enc = ?1, ciphertext = ?2 WHERE user_id = ?3 AND collection_id = ?4",
            params![enc, ciphertext, cleo.id.to_string(), shared.to_string()],
        )
        .unwrap();
    assert!(matches!(
        Vault::unlock_as(dir.path(), Some(cleo.id), BENS),
        Err(Error::Corrupt(_))
    ));
}

#[test]
fn a_draft_saved_before_a_change_of_key_still_opens() {
    let (dir, mut ana, _) = team();
    let ana_id = ana.me().id;
    let ben = ana.add_person("Ben", ONE_TIME, &[]).unwrap();
    ana.make_admin(ben.id).unwrap();
    ana.save_draft(&json!({ "editing": "Celadon 2" })).unwrap();
    ana.take_admin_away(ben.id).unwrap();
    assert!(ana.collections.iter().all(|c| c.epoch == 2));
    assert_eq!(ana.draft().unwrap().unwrap()["editing"], "Celadon 2");
    drop(ana);
    let mut ana = Vault::unlock_as(dir.path(), Some(ana_id), PASSWORD).unwrap();
    assert_eq!(ana.draft().unwrap().unwrap()["editing"], "Celadon 2");
    // A new draft goes under the current key.
    ana.save_draft(&json!({ "editing": "Celadon 3" })).unwrap();
    assert_eq!(ana.draft().unwrap().unwrap()["editing"], "Celadon 3");
}
