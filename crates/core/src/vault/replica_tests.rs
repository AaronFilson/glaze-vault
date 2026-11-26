use super::*;
use crate::access::Role;
use crate::vault::items::CHUNK_BYTES;
use crate::vault::{Capabilities, HostStore, Kind};
use serde_json::json;
use tempfile::TempDir;

const PASSWORD: &str = "cone six oxidation";
const ONE_TIME: &str = "pass this on";
const OWN: &str = "their own password";

/// One round of syncing, as crates/sync's session runs it: hello, pull until done, push.
pub(crate) fn sync(vault: &mut Vault, host: &mut HostStore) -> PushResult {
    let device = vault.device().unwrap();
    let (_, levels) = vault.sync_state().unwrap();
    let welcome = host.hello(device, &levels).unwrap();
    vault.apply_welcome(&welcome).unwrap();
    loop {
        let (cursors, _) = vault.sync_state().unwrap();
        let batch = host.pull(device, &cursors, 64 * 1024).unwrap();
        vault.apply_batch(&batch).unwrap();
        if !batch.more {
            break;
        }
    }
    for (id, mut offset) in vault.missing_bytes().unwrap() {
        while let Some(chunk) = host.chunk(device, id, offset).unwrap() {
            offset += chunk.bytes.len() as u64;
            if vault.take_chunk(&chunk).unwrap() {
                break;
            }
        }
    }
    let pending = vault.pending(usize::MAX).unwrap();
    let result = host.accept(device, pending.clone()).unwrap();
    vault.apply_push_result(&result, &pending).unwrap();
    result
}

struct Team {
    _dirs: Vec<TempDir>,
    host: HostStore,
    shared: Uuid,
    production: Uuid,
    ana: Uuid,
    ben: Uuid,
    cleo: Uuid,
    dee: Uuid,
    recipe: Uuid,
    sheet: Uuid,
    firing: Uuid,
    /// Each person's computer, unlocked and synced once.
    computers: Vec<Vault>,
}

/// Ana (admin), Ben (formulator), Cleo (batch operator) and Dee (reads without chemistry) on
/// Shared; Production is Ana's only. A recipe, its batch sheet, and a firing with a photo, made
/// before the vault was hosted; then each of them on a computer of their own.
fn team() -> Team {
    let (vault_dir, host_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (mut ana, _) = Vault::create(vault_dir.path(), PASSWORD).unwrap();
    ana.grow_into_team("Ana").unwrap();
    let ana_id = ana.me().id;
    let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
    let production = ana.create_collection("Production").unwrap().id;
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
    let mut people = Vec::new();
    for (name, role) in [
        ("Ben", Role::Formulator),
        ("Cleo", Role::Operator),
        ("Dee", Role::Custom(reader.id)),
    ] {
        people.push(ana.add_person(name, ONE_TIME, &[(shared, role)]).unwrap().id);
    }
    for person in &people {
        Vault::unlock_as(vault_dir.path(), Some(*person), ONE_TIME)
            .unwrap()
            .set_own_password(OWN)
            .unwrap();
    }
    ana.load_collections().unwrap();
    let recipe = ana
        .save_in(
            Kind::Recipe,
            shared,
            &json!({ "name": "Shino", "lines": [], "notes": "secret" }),
        )
        .unwrap()
        .record_id;
    let sheet = ana
        .save_in(Kind::Batch, shared, &json!({ "name": "Shino sheet" }))
        .unwrap()
        .record_id;
    let firing = ana
        .save_in(Kind::Firing, shared, &json!({ "name": "Cone 10" }))
        .unwrap()
        .record_id;
    ana.add_attachment(Kind::Firing, firing, "image/jpeg", b"tile").unwrap();
    let mut host = ana.prepare_host(host_dir.path()).unwrap();

    let mut dirs = vec![vault_dir, host_dir];
    let mut computers = Vec::new();
    for (person, password) in [(ana_id, PASSWORD), (people[0], OWN), (people[1], OWN), (people[2], OWN)] {
        let dir = tempfile::tempdir().unwrap();
        let device = DeviceKey::generate();
        let certificate = ana
            .certify_device(device.id, "laptop", &device.public(), &[person])
            .unwrap();
        host.add_device(&certificate).unwrap();
        Vault::join(dir.path(), &host.join_package(device.id).unwrap(), &device).unwrap();
        let mut computer = Vault::unlock_as(dir.path(), Some(person), password).unwrap();
        sync(&mut computer, &mut host);
        computers.push(computer);
        dirs.push(dir);
    }
    Team {
        _dirs: dirs,
        host,
        shared,
        production,
        ana: ana_id,
        ben: people[0],
        cleo: people[1],
        dee: people[2],
        recipe,
        sheet,
        firing,
        computers,
    }
}

/// Pulls everything from the host, giving the first error instead of panicking.
fn pull_all(vault: &mut Vault, host: &mut HostStore) -> Result<()> {
    let device = vault.device()?;
    loop {
        let (cursors, _) = vault.sync_state()?;
        let batch = host.pull(device, &cursors, 64 * 1024)?;
        vault.apply_batch(&batch)?;
        if !batch.more {
            return Ok(());
        }
    }
}

#[test]
fn the_organization_vouches_for_the_host_it_prepares_and_computers_require_it() {
    let mut team = team();
    let host_key = team.host.identity();
    for computer in &team.computers {
        assert!(computer.host_certified(&host_key).unwrap());
        assert_eq!(computer.meta(HOST_CERTIFICATE).unwrap().as_deref(), Some("required"));
    }
    // A computer whose pinned key the vault never vouched for keeps nothing it pulls.
    let ben = &mut team.computers[1];
    ben.set_meta("host_key", &hex::encode([7u8; 32])).unwrap();
    ben.conn.execute("DELETE FROM sync_state", []).unwrap();
    let before = count(ben, "SELECT count(*) FROM revisions");
    assert!(matches!(pull_all(ben, &mut team.host), Err(Error::HostNotCertified)));
    assert_eq!(count(ben, "SELECT count(*) FROM revisions"), before);
}

#[test]
fn a_computer_from_before_certificates_trusts_its_pin_until_an_admin_certifies_it() {
    let mut team = team();
    let pinned = [9u8; 32];
    for computer in team.computers.iter_mut() {
        computer.set_meta("host_key", &hex::encode(pinned)).unwrap();
        computer
            .conn
            .execute("DELETE FROM meta WHERE name = ?1", params![HOST_CERTIFICATE])
            .unwrap();
    }
    let (ana, ben) = team.computers.split_at_mut(1);
    let (ana, ben) = (&mut ana[0], &mut ben[0]);
    pull_all(ben, &mut team.host).unwrap();
    assert!(!ben.host_certified(&pinned).unwrap());

    // Not Ben, who is not an admin; Ana, at her sign-in.
    ben.certify_pinned_host().unwrap();
    assert!(!ben.host_certified(&pinned).unwrap());
    ana.certify_pinned_host().unwrap();
    assert!(ana.host_certified(&pinned).unwrap());
    sync(ana, &mut team.host);
    sync(ben, &mut team.host);
    assert!(ben.host_certified(&pinned).unwrap());
    assert_eq!(ben.meta(HOST_CERTIFICATE).unwrap().as_deref(), Some("required"));
}

#[test]
fn only_an_admin_with_the_organization_key_certifies_a_host() {
    let team = team();
    let ben = &team.computers[1];
    let key = crate::crypto::KeyPair::generate();
    let issuer = signing::person_key(&key);
    let issued_at = now_ms();
    let body = Body::HostCertified {
        host_key: vec![5; 32],
        issued_at,
        issuer_key: signing::public(&issuer),
        signature: signing::sign(
            &issuer,
            &signing::host_payload(&ben.keyring.vault_id, &[5; 32], issued_at),
        ),
    };
    assert!(events::record(&ben.conn, &ben.signer, body).is_err());
    assert!(!ben.host_certified(&[5; 32]).unwrap());
}

fn names(vault: &Vault, kind: Kind) -> Vec<String> {
    let mut names: Vec<String> = vault
        .heads(kind)
        .unwrap()
        .iter()
        .map(|r| r.content["name"].as_str().unwrap_or_default().to_owned())
        .collect();
    names.sort();
    names
}

fn count(vault: &Vault, sql: &str) -> i64 {
    vault.conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

#[test]
fn each_computer_gets_what_its_people_read_and_never_more() {
    let t = team();
    let [ana, ben, cleo, dee] = &t.computers[..] else {
        unreachable!()
    };
    assert!(ana.is_replica());
    assert_eq!(names(ana, Kind::Recipe), ["Shino"]);
    assert_eq!(names(ben, Kind::Recipe), ["Shino"]);
    assert_eq!(ben.heads(Kind::Recipe).unwrap()[0].content["notes"], "secret");
    assert_eq!(names(ben, Kind::Firing), ["Cone 10"]);
    // Cleo's computer has batch sheets, and nothing else of the collection.
    assert_eq!(names(cleo, Kind::Batch), ["Shino sheet"]);
    assert_eq!(count(cleo, "SELECT count(*) FROM revisions WHERE kind != 'batch'"), 0);
    assert_eq!(count(cleo, "SELECT count(*) FROM attachments"), 0);
    // Dee's has recipes' summaries without their content, and firings with photos.
    assert_eq!(names(dee, Kind::Recipe), ["Shino"]);
    assert!(dee.heads(Kind::Recipe).unwrap()[0].content.get("notes").is_none());
    assert_eq!(
        count(
            dee,
            "SELECT count(*) FROM revisions WHERE kind = 'recipe' AND length(ciphertext) > 0"
        ),
        0
    );
    assert_eq!(
        count(
            dee,
            "SELECT count(*) FROM revisions WHERE kind IN ('batch', 'material')"
        ),
        0
    );
    assert_eq!(names(dee, Kind::Firing), ["Cone 10"]);
    let photo = dee
        .conn
        .query_row("SELECT id FROM attachments", [], |row| row.get::<_, String>(0))
        .unwrap();
    assert_eq!(&dee.attachment(parse_id(&photo).unwrap()).unwrap().1[..], b"tile");
    // Nobody but Ana's computer has Production, or the grants of others.
    for computer in [ben, cleo, dee] {
        assert!(computer.collections().iter().all(|c| c.id != t.production));
        assert_eq!(
            count(computer, "SELECT count(DISTINCT user_id) FROM grants"),
            1,
            "only their own person's grants"
        );
    }
    assert!(ana.collections().iter().any(|c| c.id == t.production));
    assert_eq!(names(cleo, Kind::Mix), Vec::<String>::new());
    let _ = (t.ana, t.cleo, t.dee, t.sheet, t.firing);
}

/// The newest revision of a recipe, on a computer.
fn head(vault: &Vault, record: Uuid) -> crate::vault::Revision {
    vault
        .heads(Kind::Recipe)
        .unwrap()
        .into_iter()
        .find(|r| r.record_id == record)
        .unwrap()
}

#[test]
fn a_save_on_one_computer_reaches_the_others_signed() {
    let mut t = team();
    let shino = head(&t.computers[1], t.recipe);
    let saved = t.computers[1]
        .save(
            Kind::Recipe,
            Some(shino.revision_id),
            &json!({ "name": "Shino 2", "lines": [], "notes": "" }),
        )
        .unwrap();
    let result = sync(&mut t.computers[1], &mut t.host);
    assert_eq!(result.accepted.len(), 1);
    assert!(result.refused.is_empty());
    // Nothing waits to be pushed now.
    assert!(t.computers[1].pending(usize::MAX).unwrap().is_empty());
    sync(&mut t.computers[0], &mut t.host);
    assert_eq!(names(&t.computers[0], Kind::Recipe), ["Shino 2"]);
    let history = t.computers[0].history(Kind::Recipe, t.recipe).unwrap();
    assert_eq!(history[0].revision_id, saved.revision_id);
    let signed = history[0].signed.as_ref().unwrap();
    assert_eq!((signed.by, signed.check), (t.ben, crate::vault::SignatureCheck::Good));
    // Dee gets its summary.
    sync(&mut t.computers[3], &mut t.host);
    assert_eq!(names(&t.computers[3], Kind::Recipe), ["Shino 2"]);
}

#[test]
fn edits_made_apart_fork_and_one_is_chosen() {
    let mut t = team();
    let shino = head(&t.computers[0], t.recipe).revision_id;
    let anas = t.computers[0]
        .save(
            Kind::Recipe,
            Some(shino),
            &json!({ "name": "Ana's Shino", "lines": [], "notes": "" }),
        )
        .unwrap();
    t.computers[1]
        .save(
            Kind::Recipe,
            Some(shino),
            &json!({ "name": "Ben's Shino", "lines": [], "notes": "" }),
        )
        .unwrap();
    sync(&mut t.computers[0], &mut t.host);
    sync(&mut t.computers[1], &mut t.host);
    sync(&mut t.computers[0], &mut t.host);
    let forked = head(&t.computers[0], t.recipe);
    assert_eq!(forked.forks.len(), 1);
    assert_eq!(head(&t.computers[1], t.recipe).forks.len(), 1);
    let others: Vec<Uuid> = std::iter::once(forked.revision_id)
        .chain(forked.forks.iter().map(|f| f.revision_id))
        .filter(|id| *id != anas.revision_id)
        .collect();
    t.computers[0]
        .resolve_fork(Kind::Recipe, anas.revision_id, &others)
        .unwrap();
    sync(&mut t.computers[0], &mut t.host);
    sync(&mut t.computers[1], &mut t.host);
    let resolved = head(&t.computers[1], t.recipe);
    assert!(resolved.forks.is_empty());
    assert_eq!(resolved.content["name"], "Ana's Shino");
}

#[test]
fn an_erasure_spreads_and_a_computer_that_was_away_cannot_bring_the_record_back() {
    let mut t = team();
    let shino = head(&t.computers[0], t.recipe).revision_id;
    // Ben, away, saves a revision; Ana deletes and erases the record meanwhile. The delete must
    // reach the host before the erasure.
    let deleted = t.computers[0].delete(Kind::Recipe, shino).unwrap();
    assert!(matches!(
        t.computers[0].erase(Kind::Recipe, deleted.record_id),
        Err(Error::NotSynced)
    ));
    sync(&mut t.computers[0], &mut t.host);
    t.computers[0].erase(Kind::Recipe, deleted.record_id).unwrap();
    let result = sync(&mut t.computers[0], &mut t.host);
    assert!(result.refused.is_empty(), "{:?}", result.refused);
    t.computers[1]
        .save(
            Kind::Recipe,
            Some(shino),
            &json!({ "name": "Ben's", "lines": [], "notes": "" }),
        )
        .unwrap();
    let unsent = t.computers[1].pending(usize::MAX).unwrap();
    // Ben's computer learns of the erasure as it pulls, and drops the record, his revision
    // with it; the host would have refused that revision anyway.
    let result = sync(&mut t.computers[1], &mut t.host);
    assert!(result.accepted.is_empty() && result.refused.is_empty());
    let bens = t.computers[1].device().unwrap();
    assert_eq!(t.host.accept(bens, unsent).unwrap().refused[0].1, Refusal::Erased);
    assert!(names(&t.computers[1], Kind::Recipe).is_empty());
    assert_eq!(
        count(&t.computers[1], "SELECT count(*) FROM revisions WHERE kind = 'recipe'"),
        0
    );
    assert!(t.computers[1].pending(usize::MAX).unwrap().is_empty());
}

#[test]
fn an_erasure_of_a_record_changed_elsewhere_is_undone() {
    let mut t = team();
    let shino = head(&t.computers[0], t.recipe).revision_id;
    let deleted = t.computers[0].delete(Kind::Recipe, shino).unwrap();
    sync(&mut t.computers[0], &mut t.host);
    // Ben, who had not seen the delete, saves a revision, after Ana's sync and before she
    // erases what she has.
    t.computers[1]
        .save(
            Kind::Recipe,
            Some(shino),
            &json!({ "name": "Ben's", "lines": [], "notes": "" }),
        )
        .unwrap();
    sync(&mut t.computers[1], &mut t.host);
    t.computers[0].erase(Kind::Recipe, deleted.record_id).unwrap();
    let result = sync(&mut t.computers[0], &mut t.host);
    assert!(result.refused.iter().any(|(_, r)| *r == Refusal::ChangedElsewhere));
    // The next sync brings the record back, Ben's revision listed with her delete as a fork.
    sync(&mut t.computers[0], &mut t.host);
    let back = head(&t.computers[0], t.recipe);
    assert_eq!(back.content["name"], "Ben's");
    assert_eq!(back.forks.len(), 1);
    assert!(back.forks[0].deleted);
}

#[test]
fn a_record_moved_where_someone_cannot_read_leaves_their_computer() {
    let mut t = team();
    t.computers[0]
        .move_records(&[(Kind::Recipe, t.recipe)], t.production)
        .unwrap();
    let result = sync(&mut t.computers[0], &mut t.host);
    assert!(result.refused.is_empty(), "{:?}", result.refused);
    sync(&mut t.computers[1], &mut t.host);
    assert!(names(&t.computers[1], Kind::Recipe).is_empty());
    assert_eq!(
        count(&t.computers[1], "SELECT count(*) FROM revisions WHERE kind = 'recipe'"),
        0
    );
    sync(&mut t.computers[3], &mut t.host);
    assert!(names(&t.computers[3], Kind::Recipe).is_empty());
    // Ana still has it, in Production, as the host does.
    sync(&mut t.computers[0], &mut t.host);
    assert_eq!(head(&t.computers[0], t.recipe).collection_id, t.production);
}

#[test]
fn what_was_saved_away_under_an_old_key_is_sealed_again_before_it_is_pushed() {
    let mut t = team();
    let shino = head(&t.computers[1], t.recipe).revision_id;
    // Ben saves while away; meanwhile Ana takes Dee's role away, which gives Shared a new key.
    t.computers[1]
        .save(
            Kind::Recipe,
            Some(shino),
            &json!({ "name": "Ben's", "lines": [], "notes": "" }),
        )
        .unwrap();
    t.computers[0].set_role(t.dee, t.shared, None).unwrap();
    let result = sync(&mut t.computers[0], &mut t.host);
    assert!(result.refused.is_empty(), "{:?}", result.refused);
    let result = sync(&mut t.computers[1], &mut t.host);
    assert!(result.refused.is_empty(), "{:?}", result.refused);
    assert_eq!(
        count(
            &t.computers[1],
            "SELECT max(epoch) FROM revisions WHERE kind = 'recipe'"
        ),
        2
    );
    sync(&mut t.computers[0], &mut t.host);
    assert_eq!(names(&t.computers[0], Kind::Recipe), ["Ben's"]);
    // Dee's computer drops the collection.
    sync(&mut t.computers[3], &mut t.host);
    assert!(names(&t.computers[3], Kind::Recipe).is_empty());
    assert_eq!(count(&t.computers[3], "SELECT count(*) FROM revisions"), 0);
}

#[test]
fn a_new_password_reaches_the_persons_other_computer() {
    let mut t = team();
    let (dir, device) = (tempfile::tempdir().unwrap(), DeviceKey::generate());
    let ana_vault = t._dirs[0].path().to_owned();
    let ana = Vault::unlock_as(&ana_vault, Some(t.ana), PASSWORD).unwrap();
    let certificate = ana
        .certify_device(device.id, "second laptop", &device.public(), &[t.ben])
        .unwrap();
    t.host.add_device(&certificate).unwrap();
    Vault::join(dir.path(), &t.host.join_package(device.id).unwrap(), &device).unwrap();

    t.computers[1].change_password(OWN, "bens newer password").unwrap();
    let result = sync(&mut t.computers[1], &mut t.host);
    assert!(result.accepted.iter().any(|(id, _)| *id == t.ben));
    // The second computer still opens with the old one until it syncs; then with the new.
    let mut second = Vault::unlock_as(dir.path(), Some(t.ben), OWN).unwrap();
    sync(&mut second, &mut t.host);
    drop(second);
    assert!(matches!(
        Vault::unlock_as(dir.path(), Some(t.ben), OWN),
        Err(Error::WrongPassword)
    ));
    let second = Vault::unlock_as(dir.path(), Some(t.ben), "bens newer password").unwrap();
    assert_eq!(names(&second, Kind::Recipe), ["Shino"]);
}

#[test]
fn the_host_refuses_what_a_computer_may_not_push() {
    let mut t = team();
    let shino = head(&t.computers[1], t.recipe).revision_id;
    t.computers[1]
        .save(
            Kind::Recipe,
            Some(shino),
            &json!({ "name": "Ben's", "lines": [], "notes": "" }),
        )
        .unwrap();
    let pending = t.computers[1].pending(usize::MAX).unwrap();
    // Cleo's computer passing on Ben's revision: Ben does not sign in there.
    let cleos = t.computers[2].device().unwrap();
    let result = t.host.accept(cleos, pending.clone()).unwrap();
    assert_eq!(result.refused[0].1, Refusal::NotAllowed);
    // Changed on the way.
    let mut changed = pending.clone();
    if let Item::Revision(r) = &mut changed[0] {
        r.ciphertext[0] ^= 1;
    }
    let bens = t.computers[1].device().unwrap();
    assert_eq!(
        t.host.accept(bens, changed).unwrap().refused[0].1,
        Refusal::BadSignature
    );
    // A computer the host does not know.
    assert!(matches!(
        t.host.accept(Uuid::new_v4(), pending.clone()),
        Err(Error::Revoked)
    ));
    // As it was, it is taken, and taken again the same when pushed twice.
    let first = t.host.accept(bens, pending.clone()).unwrap();
    let again = t.host.accept(bens, pending).unwrap();
    assert_eq!(first.accepted, again.accepted);
}

#[test]
fn events_made_together_are_taken_together_or_not_at_all() {
    let mut t = team();
    // Ana takes Dee's role away: the grant removed, a new key, and everyone's grants sealed
    // again. Ben's computer passes it on, which it may not, so none of it is taken.
    t.computers[0].set_role(t.dee, t.shared, None).unwrap();
    let pending = t.computers[0].pending(usize::MAX).unwrap();
    assert!(pending.len() > 3);
    let mut forged = pending.clone();
    let bens = t.computers[1].device().unwrap();
    let result = t.host.accept(bens, std::mem::take(&mut forged)).unwrap();
    assert!(result.accepted.is_empty());
    assert_eq!(result.refused.len(), pending.len());
    assert_eq!(result.refused[0].1, Refusal::NotAllowed);
    // From Ana's own computer, all of it is.
    let result = sync(&mut t.computers[0], &mut t.host);
    assert!(result.refused.is_empty(), "{:?}", result.refused);
    assert_eq!(result.accepted.len(), pending.len());
}

#[test]
fn an_admin_changes_the_directory_from_their_computer() {
    let mut t = team();
    let glazes = t.computers[0].create_collection("Glazes").unwrap().id;
    t.computers[0].set_role(t.ben, glazes, Some(Role::Chemist)).unwrap();
    let result = sync(&mut t.computers[0], &mut t.host);
    assert!(result.refused.is_empty(), "{:?}", result.refused);
    sync(&mut t.computers[1], &mut t.host);
    let collections = t.computers[1].collections();
    let glazes = collections.iter().find(|c| c.id == glazes).unwrap();
    assert_eq!((glazes.name.as_str(), glazes.role), ("Glazes", Role::Chemist));
    // Cleo's computer knows nothing of it.
    sync(&mut t.computers[2], &mut t.host);
    assert!(t.computers[2].collections().iter().all(|c| c.name != "Glazes"));
    assert_eq!(
        count(
            &t.computers[2],
            "SELECT count(*) FROM collections WHERE name = 'Glazes'"
        ),
        0
    );
}

#[test]
fn a_directory_change_waits_until_its_computer_holds_the_directory() {
    let mut t = team();
    t.host.guard_directory();
    t.computers[0].create_collection("Glazes").unwrap();
    assert!(t.computers[0].directory_waiting().unwrap());
    // Another computer holds it: the collection waits, not set aside.
    let device = t.computers[1].device().unwrap();
    t.host.set_directory_holder(Some(device));
    let result = sync(&mut t.computers[0], &mut t.host);
    assert!(
        result.refused.iter().all(|(_, why)| *why == Refusal::DirectoryNotHeld),
        "{:?}",
        result.refused
    );
    assert!(t.computers[0].directory_waiting().unwrap());
    let ana = t.computers[0].device().unwrap();
    t.host.set_directory_holder(Some(ana));
    let result = sync(&mut t.computers[0], &mut t.host);
    assert!(result.refused.is_empty(), "{:?}", result.refused);
    assert!(!t.computers[0].directory_waiting().unwrap());
    assert_eq!(t.computers[0].waiting().unwrap(), 0);
}

#[test]
fn both_computers_list_the_version_the_host_took_last_first() {
    let mut t = team();
    let shino = head(&t.computers[0], t.recipe).revision_id;
    // Ben saves first by the clock, but reaches the host last.
    t.computers[1]
        .save(
            Kind::Recipe,
            Some(shino),
            &json!({ "name": "Ben's", "lines": [], "notes": "" }),
        )
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    t.computers[0]
        .save(
            Kind::Recipe,
            Some(shino),
            &json!({ "name": "Ana's", "lines": [], "notes": "" }),
        )
        .unwrap();
    sync(&mut t.computers[0], &mut t.host);
    sync(&mut t.computers[1], &mut t.host);
    sync(&mut t.computers[0], &mut t.host);
    assert_eq!(head(&t.computers[0], t.recipe).content["name"], "Ben's");
    assert_eq!(head(&t.computers[1], t.recipe).content["name"], "Ben's");
}

#[test]
fn a_collection_pulled_again_keeps_what_was_saved_here_and_not_sent() {
    let mut t = team();
    let shino = head(&t.computers[1], t.recipe).revision_id;
    let saved = t.computers[1]
        .save(
            Kind::Recipe,
            Some(shino),
            &json!({ "name": "Offline", "lines": [], "notes": "" }),
        )
        .unwrap();
    // As when the host says what Ben holds there changed.
    let device = t.computers[1].device().unwrap();
    let (_, levels) = t.computers[1].sync_state().unwrap();
    let mut welcome = t.host.hello(device, &levels).unwrap();
    welcome.reset.push(Scope::Collection(t.shared));
    t.computers[1].apply_welcome(&welcome).unwrap();
    assert_eq!(t.computers[1].waiting().unwrap(), 1);
    let result = sync(&mut t.computers[1], &mut t.host);
    assert!(
        result.accepted.iter().any(|(id, _)| *id == saved.revision_id),
        "{result:?}"
    );
    assert_eq!(head(&t.computers[1], t.recipe).content["name"], "Offline");
}

#[test]
fn with_photos_on_demand_a_computer_fetches_only_those_opened() {
    let mut t = team();
    // A computer brings every photo until told otherwise; a phone would not.
    assert!(!t.computers[0].photos_on_demand().unwrap());
    t.computers[0].set_photos_on_demand(true).unwrap();
    let first = t.computers[1]
        .add_attachment(Kind::Firing, t.firing, "image/jpeg", b"first")
        .unwrap();
    let second = t.computers[1]
        .add_attachment(Kind::Firing, t.firing, "image/jpeg", b"second")
        .unwrap();
    sync(&mut t.computers[1], &mut t.host);
    sync(&mut t.computers[0], &mut t.host);
    assert!(matches!(t.computers[0].attachment(first.id), Err(Error::NotFetched)));
    assert!(matches!(t.computers[0].attachment(second.id), Err(Error::NotFetched)));
    assert!(t.computers[0].missing_bytes().unwrap().is_empty());

    t.computers[0].want_photo(first.id).unwrap();
    assert_eq!(t.computers[0].missing_bytes().unwrap(), vec![(first.id, 0)]);
    sync(&mut t.computers[0], &mut t.host);
    assert_eq!(&t.computers[0].attachment(first.id).unwrap().1[..], b"first");
    assert!(matches!(t.computers[0].attachment(second.id), Err(Error::NotFetched)));

    // All of them again, the one opened first.
    t.computers[0].set_photos_on_demand(false).unwrap();
    t.computers[0].want_photo(second.id).unwrap();
    assert_eq!(t.computers[0].missing_bytes().unwrap()[0].0, second.id);
}

#[test]
fn a_photo_comes_in_pieces_after_its_firing() {
    let mut t = team();
    let big: Vec<u8> = (0..(2 * CHUNK_BYTES + 1000)).map(|i| (i % 251) as u8).collect();
    let photo = t.computers[1]
        .add_attachment(Kind::Firing, t.firing, "image/jpeg", &big)
        .unwrap();
    // Sent whole, as the core's helper does, and pulled by Ana's computer without its bytes.
    sync(&mut t.computers[1], &mut t.host);
    let device = t.computers[0].device().unwrap();
    let (_, levels) = t.computers[0].sync_state().unwrap();
    t.computers[0]
        .apply_welcome(&t.host.hello(device, &levels).unwrap())
        .unwrap();
    let (cursors, _) = t.computers[0].sync_state().unwrap();
    let batch = t.host.pull(device, &cursors, usize::MAX).unwrap();
    t.computers[0].apply_batch(&batch).unwrap();
    assert!(matches!(t.computers[0].attachment(photo.id), Err(Error::NotFetched)));
    let missing = t.computers[0].missing_bytes().unwrap();
    assert_eq!(missing, vec![(photo.id, 0)]);

    // A piece out of order is refused; then it comes, a piece at a time.
    let first = t.host.chunk(device, photo.id, 0).unwrap().unwrap();
    assert_eq!(first.bytes.len(), CHUNK_BYTES);
    let mut skipped = t.host.chunk(device, photo.id, CHUNK_BYTES as u64).unwrap().unwrap();
    assert!(t.computers[0].take_chunk(&skipped).is_err());
    assert!(!t.computers[0].take_chunk(&first).unwrap());
    assert_eq!(
        t.computers[0].missing_bytes().unwrap(),
        vec![(photo.id, CHUNK_BYTES as u64)]
    );
    assert!(!t.computers[0].take_chunk(&skipped).unwrap());
    skipped = t.host.chunk(device, photo.id, 2 * CHUNK_BYTES as u64).unwrap().unwrap();
    assert!(t.computers[0].take_chunk(&skipped).unwrap());
    assert_eq!(*t.computers[0].attachment(photo.id).unwrap().1, big);
    assert!(t.computers[0].missing_bytes().unwrap().is_empty());

    // Cleo's computer, which has no firings, is sent none of it.
    let cleo = t.computers[2].device().unwrap();
    assert!(t.host.chunk(cleo, photo.id, 0).unwrap().is_none());
}

#[test]
fn a_photo_whose_pieces_were_changed_on_the_way_is_not_kept() {
    let mut t = team();
    let big: Vec<u8> = (0..(CHUNK_BYTES + 500)).map(|i| (i % 13) as u8).collect();
    let photo = t.computers[1]
        .add_attachment(Kind::Firing, t.firing, "image/jpeg", &big)
        .unwrap();
    sync(&mut t.computers[1], &mut t.host);
    let device = t.computers[0].device().unwrap();
    let (_, levels) = t.computers[0].sync_state().unwrap();
    t.computers[0]
        .apply_welcome(&t.host.hello(device, &levels).unwrap())
        .unwrap();
    let (cursors, _) = t.computers[0].sync_state().unwrap();
    let batch = t.host.pull(device, &cursors, usize::MAX).unwrap();
    t.computers[0].apply_batch(&batch).unwrap();

    // The host reads the last piece from the middle of its BLOB, and nothing past its end.
    let total = t.host.chunk(device, photo.id, 0).unwrap().unwrap().total;
    let past = t.host.chunk(device, photo.id, total).unwrap().unwrap();
    assert!(past.bytes.is_empty());

    let first = t.host.chunk(device, photo.id, 0).unwrap().unwrap();
    let mut last = t.host.chunk(device, photo.id, CHUNK_BYTES as u64).unwrap().unwrap();
    assert_eq!(last.offset + last.bytes.len() as u64, total);
    last.bytes[0] ^= 1;
    assert!(!t.computers[0].take_chunk(&first).unwrap());
    assert!(matches!(t.computers[0].take_chunk(&last), Err(Error::BadSignature)));
    // It is still missing, from the start, and comes whole when it is sent right.
    assert_eq!(t.computers[0].missing_bytes().unwrap(), vec![(photo.id, 0)]);
    last.bytes[0] ^= 1;
    assert!(!t.computers[0].take_chunk(&first).unwrap());
    assert!(t.computers[0].take_chunk(&last).unwrap());
    assert_eq!(*t.computers[0].attachment(photo.id).unwrap().1, big);
}

#[test]
fn an_attachment_sent_in_pieces_is_taken_once_they_have_all_come() {
    let mut t = team();
    let bytes: Vec<u8> = (0..(CHUNK_BYTES + 10)).map(|i| (i % 7) as u8).collect();
    let photo = t.computers[1]
        .add_attachment(Kind::Firing, t.firing, "image/png", &bytes)
        .unwrap();
    let device = t.computers[1].device().unwrap();
    let pending = t.computers[1].pending(usize::MAX).unwrap();
    let stripped: Vec<Item> = pending
        .iter()
        .cloned()
        .map(|item| match item {
            Item::Attachment(mut a) => {
                a.ciphertext = Vec::new();
                Item::Attachment(a)
            }
            other => other,
        })
        .collect();
    // Without its bytes it is not taken, but not refused for good either.
    let result = t.host.accept(device, stripped.clone()).unwrap();
    assert_eq!(result.refused, vec![(photo.id, Refusal::BytesMissing)]);
    t.computers[1].apply_push_result(&result, &stripped).unwrap();
    assert_eq!(t.computers[1].waiting().unwrap(), 1);

    let ciphertext = t.computers[1].attachment_bytes(photo.id).unwrap();
    let piece = |offset: usize| crate::sync::Chunk {
        id: photo.id,
        offset: offset as u64,
        total: ciphertext.len() as u64,
        bytes: ciphertext[offset..(offset + CHUNK_BYTES).min(ciphertext.len())].to_vec(),
    };
    // Pieces that do not hash right, as when the photo was sealed again under a new key
    // at the same length, are let go when it is refused, so the right ones can come.
    let wrong = |offset: usize| {
        let mut chunk = piece(offset);
        chunk.bytes[0] ^= 1;
        chunk
    };
    t.host.take_chunk(device, &wrong(0)).unwrap();
    t.host.take_chunk(device, &wrong(CHUNK_BYTES)).unwrap();
    let result = t.host.accept(device, stripped.clone()).unwrap();
    assert_eq!(result.refused, vec![(photo.id, Refusal::BytesMissing)]);
    assert_eq!(t.host.take_chunk(device, &piece(0)).unwrap(), CHUNK_BYTES as u64);
    // Sent again after a break, the host says how far it got.
    assert_eq!(t.host.take_chunk(device, &piece(0)).unwrap(), CHUNK_BYTES as u64);
    // Another computer cannot add to it.
    let ana = t.computers[0].device().unwrap();
    assert!(t.host.take_chunk(ana, &piece(CHUNK_BYTES)).is_err());
    assert_eq!(
        t.host.take_chunk(device, &piece(CHUNK_BYTES)).unwrap(),
        ciphertext.len() as u64
    );
    let result = t.host.accept(device, stripped.clone()).unwrap();
    assert_eq!(result.accepted.len(), 1);
    t.computers[1].apply_push_result(&result, &stripped).unwrap();
    assert_eq!(t.computers[1].waiting().unwrap(), 0);
    sync(&mut t.computers[0], &mut t.host);
    assert_eq!(*t.computers[0].attachment(photo.id).unwrap().1, bytes);
}

#[test]
fn a_record_checked_out_elsewhere_cannot_be_saved_until_it_is_taken_over() {
    let mut t = team();
    let (ana, ben) = (t.computers[0].device().unwrap(), t.computers[1].device().unwrap());
    // Ben's computer cannot check out for Ana, nor Cleo's change a recipe.
    assert!(t.host.check_out(ben, t.ana, t.recipe, false).is_err());
    let cleo = t.computers[2].device().unwrap();
    assert!(t.host.check_out(cleo, t.cleo, t.recipe, false).is_err());

    let held = t.host.check_out(ana, t.ana, t.recipe, false).unwrap();
    assert_eq!(held.len(), 1);
    // Ben asks, and Ana still has it.
    let seen = t.host.check_out(ben, t.ben, t.recipe, false).unwrap();
    assert_eq!(seen[0].person, t.ana);
    t.computers[1].set_checkouts(seen);
    let shino = head(&t.computers[1], t.recipe).revision_id;
    let content = json!({ "name": "Ben's", "lines": [], "notes": "" });
    match t.computers[1].save(Kind::Recipe, Some(shino), &content) {
        Err(Error::CheckedOut(by)) => assert_eq!(by, "Ana"),
        other => panic!("saved anyway: {:?}", other.map(|r| r.revision_id)),
    }
    // Ana's own computer saves as before; Cleo's sees nothing of the recipe.
    t.computers[0].set_checkouts(t.host.checkouts(ana).unwrap());
    let anas = head(&t.computers[0], t.recipe).revision_id;
    t.computers[0].save(Kind::Recipe, Some(anas), &content).unwrap();
    assert!(t.host.checkouts(cleo).unwrap().is_empty());

    let taken = t.host.check_out(ben, t.ben, t.recipe, true).unwrap();
    assert_eq!(taken[0].person, t.ben);
    t.computers[1].set_checkouts(taken);
    t.computers[1].save(Kind::Recipe, Some(shino), &content).unwrap();
    assert!(t.host.release(ben, t.ben, t.recipe).unwrap().is_empty());
}

#[test]
fn a_resolution_cannot_set_aside_another_records_revision() {
    let mut t = team();
    let recipe = head(&t.computers[1], t.recipe).revision_id;
    let other = t.computers[1]
        .save_in(
            Kind::Recipe,
            t.shared,
            &json!({ "name": "Other", "lines": [], "notes": "" }),
        )
        .unwrap();
    sync(&mut t.computers[1], &mut t.host);
    // As if a computer had saved a resolution that names a revision of another record.
    let resolution = t.computers[1]
        .add_revision(
            Kind::Recipe,
            Some(recipe),
            None,
            &json!({ "name": "Shino", "lines": [], "notes": "" }),
            false,
            &[other.revision_id],
        )
        .unwrap();
    let result = sync(&mut t.computers[1], &mut t.host);
    assert!(matches!(
        result.refused.iter().find(|(id, _)| *id == resolution.revision_id),
        Some((_, Refusal::Invalid { .. }))
    ));
}

/// Sets when a computer last synced, as if it were `days` ago.
fn synced_days_ago(vault: &Vault, days: i64) {
    let at = now_ms() - days * 24 * 60 * 60 * 1000 - 1000;
    vault.set_meta("offline_last_synced", &at.to_string()).unwrap();
}

#[test]
fn a_computer_away_too_long_takes_no_changes_until_an_extension_code() {
    let mut t = team();
    let policy = crate::vault::OfflinePolicy {
        nag_days: 3,
        limit_days: Some(7),
        by_role: Vec::new(),
    };
    // Only an admin sets the rule, and it reaches the other computers.
    assert!(t.computers[1].set_offline_policy(&policy).is_err());
    t.computers[0].set_offline_policy(&policy).unwrap();
    sync(&mut t.computers[0], &mut t.host);
    sync(&mut t.computers[1], &mut t.host);
    let ben = &mut t.computers[1];
    assert_eq!(ben.offline_policy(), policy);

    synced_days_ago(ben, 4);
    let status = ben.offline_status().unwrap();
    assert!(status.nag && !status.read_only);
    synced_days_ago(ben, 8);
    assert!(ben.offline_status().unwrap().read_only);
    let shino = head(ben, t.recipe).revision_id;
    let content = json!({ "name": "Away", "lines": [], "notes": "" });
    assert!(matches!(
        ben.save(Kind::Recipe, Some(shino), &content),
        Err(Error::OfflineTooLong)
    ));
    // Drafts are still kept.
    ben.save_draft(&json!({ "recipe": null })).unwrap();

    // A code from the host, for this computer, with the secret they share from pairing.
    let device = ben.device().unwrap();
    ben.set_meta(super::super::offline::SECRET, &hex::encode(b"shared at pairing"))
        .unwrap();
    t.host.set_offline_secret(device, b"shared at pairing").unwrap();
    let code = t.host.extension_code(device, 5).unwrap();
    let other = t.computers[2].device().unwrap();
    t.host.set_offline_secret(other, b"another secret").unwrap();
    let ben = &mut t.computers[1];
    assert!(matches!(
        ben.extend(&t.host.extension_code(other, 5).unwrap()),
        Err(Error::WrongExtensionCode)
    ));
    assert!(!ben.extend(&code).unwrap().read_only);
    ben.save(Kind::Recipe, Some(shino), &content).unwrap();

    // A clock set back more than a day counts as too long.
    synced_days_ago(ben, 0);
    ben.set_meta("offline_extended_until", "0").unwrap();
    let ahead = now_ms() + 3 * 24 * 60 * 60 * 1000;
    ben.set_meta("offline_latest_seen", &ahead.to_string()).unwrap();
    assert!(ben.offline_status().unwrap().clock_back);
    assert!(ben.offline_status().unwrap().read_only);
}

#[test]
fn a_revoked_computer_is_told_so_and_a_lost_ones_people_get_new_keys() {
    let mut t = team();
    let ben = t.computers[1].device().unwrap();
    let cleo = t.computers[2].device().unwrap();
    let retired = t.host.revoke_device(cleo, false).unwrap();
    assert!(retired.revoked && !retired.lost);
    let (_, levels) = t.computers[2].sync_state().unwrap();
    let welcome = t.host.hello(cleo, &levels).unwrap();
    assert!(matches!(t.computers[2].apply_welcome(&welcome), Err(Error::Revoked)));

    assert!(t.host.revoke_device(ben, true).unwrap().lost);
    let epoch = t.computers[0]
        .collections()
        .iter()
        .find(|c| c.id == t.shared)
        .map(|_| t.computers[0].directory.collection(t.shared).unwrap().epoch)
        .unwrap();
    // Ana's computer has only her own key file entry, and resets Ben all the same.
    let passwords = t.computers[0].secure_after_lost(&[t.ben]).unwrap();
    assert_eq!(passwords.iter().map(|p| p.0).collect::<Vec<_>>(), vec![t.ben]);
    assert!(t.computers[0].directory.collection(t.shared).unwrap().epoch > epoch);
    // Production, which Ben could not read, keeps its key.
    assert_eq!(t.computers[0].directory.collection(t.production).unwrap().epoch, 1);
    // Ben cannot sign in on Ana's computer while his new entry waits there for the host.
    let dir = t.computers[0].dir.clone();
    assert!(Vault::people_in(&dir).unwrap().iter().all(|p| p.id != t.ben));
    assert!(Vault::unlock_as(&dir, Some(t.ben), &passwords[0].1).is_err());
    let result = sync(&mut t.computers[0], &mut t.host);
    assert!(result.refused.is_empty(), "{:?}", result.refused);
    // It reached the host, for his computers, and went from Ana's.
    assert!(t.computers[0].keyring.user(&t.ben).is_err());
    let entry: String = t
        .host
        .conn
        .query_row(
            "SELECT entry FROM key_entries WHERE person_id = ?1",
            params![t.ben.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(serde_json::from_str::<PersonEntry>(&entry).unwrap().must_set_password);
}

#[test]
fn a_key_file_entry_from_the_host_must_be_signed_by_its_person_or_an_admin() {
    let t = team();
    let ben = &t.computers[1];
    let entry = items::entry_item(&t.host.conn, &ben.me().id.to_string()).unwrap();
    let take = |item: &EntryItem| {
        let trust = Trust::load(&ben.conn, ben.keyring.vault_id).unwrap();
        let mut keyring = ben.keyring.clone();
        take_entry(&ben.conn, &trust, &mut keyring, &ben.database_key().unwrap(), item)
    };
    take(&entry).unwrap();
    let mut forged = entry.clone();
    forged.signature[0] ^= 1;
    assert!(matches!(take(&forged), Err(Error::BadSignature)));
    // Cleo is neither Ben nor an admin.
    let by_cleo = EntryItem {
        signer: t.computers[2].me().id,
        ..entry
    };
    assert!(matches!(take(&by_cleo), Err(Error::BadSignature)));
}

#[test]
fn a_backup_of_the_host_kept_elsewhere_goes_back_to_it() {
    let mut t = team();
    let kept = tempfile::tempdir().unwrap();
    let file = kept.path().join("host.gvhost");
    let made = t.host.export_backup(&file).unwrap();
    // Ana's computer, with the organization's key, knows it; Ben's does not.
    assert_eq!(t.computers[0].check_host_backup(&file).unwrap(), made);
    assert!(t.computers[1].check_host_backup(&file).is_err());

    let shino = head(&t.computers[1], t.recipe).revision_id;
    let saved = t.computers[1]
        .save(
            Kind::Recipe,
            Some(shino),
            &json!({ "name": "After", "lines": [], "notes": "" }),
        )
        .unwrap();
    sync(&mut t.computers[1], &mut t.host);

    // A file changed anywhere is refused.
    let mut changed = fs::read(&file).unwrap();
    let last = changed.len() - 1;
    changed[last] ^= 1;
    let bad = kept.path().join("changed.gvhost");
    fs::write(&bad, &changed).unwrap();
    assert!(matches!(
        HostStore::import_backup(t.host.dir(), t.host.vault_id(), &bad),
        Err(Error::NotABackup)
    ));
    assert!(t.host.backups().unwrap().is_empty());

    let name = HostStore::import_backup(t.host.dir(), t.host.vault_id(), &file).unwrap();
    assert_eq!(t.host.backups().unwrap()[0].name, name);
    // The daily backups do not prune one sent, though it sorts before them.
    let daily = t.host.dir().join(super::super::BACKUPS);
    for _ in 0..crate::vault::host::BACKUPS_KEPT + 2 {
        t.host.back_up(&daily).unwrap();
    }
    assert!(t.host.backups().unwrap().iter().any(|b| b.name == name));
    assert_eq!(t.host.backups().unwrap().len(), crate::vault::host::BACKUPS_KEPT + 1);
    t.host.ask_restore(&name).unwrap();
    assert!(t.host.ask_restore("../elsewhere").is_err());
    let dir = t.host.dir().to_owned();
    let asked = fs::read_to_string(dir.join(super::super::RESTORE_FILE)).unwrap();
    drop(t.host);
    HostStore::restore(&dir, Path::new(&asked)).unwrap();
    t.host = HostStore::open(&dir).unwrap();
    assert!(!items::exists(&t.host.conn, "revisions", &saved.revision_id).unwrap());
    let result = sync(&mut t.computers[1], &mut t.host);
    assert!(result.accepted.iter().any(|(id, _)| *id == saved.revision_id));
}

#[test]
fn a_host_moves_to_another_computer_from_its_file_and_computers_carry_on() {
    let mut t = team();
    let kept = tempfile::tempdir().unwrap();
    let file = kept.path().join("host.gvhost");
    t.host.export_backup(&file).unwrap();
    let old = t.host.generation().unwrap();
    // Ben saves after the file was made, and only the old host has it.
    let shino = head(&t.computers[1], t.recipe).revision_id;
    let saved = t.computers[1]
        .save(
            Kind::Recipe,
            Some(shino),
            &json!({ "name": "After", "lines": [], "notes": "" }),
        )
        .unwrap();
    sync(&mut t.computers[1], &mut t.host);

    // Only an admin opens it, and not into a store already there.
    let staging = kept.path().join("staging");
    assert!(matches!(
        t.computers[1].unpack_host_backup(&file, &staging, false),
        Err(Error::NotAllowed)
    ));
    assert!(!staging.exists());
    assert!(matches!(
        t.computers[0].unpack_host_backup(&file, t.host.dir(), false),
        Err(Error::VaultExists)
    ));

    let moved = t.computers[0].unpack_host_backup(&file, &staging, false).unwrap();
    assert_eq!(moved.identity(), t.host.identity());
    assert_ne!(moved.generation().unwrap(), old);
    drop(moved);
    t.host = HostStore::open(&staging).unwrap();
    for computer in &t.computers {
        assert!(computer.host_certified(&t.host.identity()).unwrap());
    }
    // Ben's computer sends again what the old host had and the file did not.
    let result = sync(&mut t.computers[1], &mut t.host);
    assert!(result.accepted.iter().any(|(id, _)| *id == saved.revision_id));
    sync(&mut t.computers[0], &mut t.host);
    assert_eq!(head(&t.computers[0], t.recipe).content["name"], "After");

    // A computer that pinned another host's key does not take this one's file.
    let pinned = t.computers[0].host_key().unwrap();
    t.computers[0].set_meta("host_key", &hex::encode([7u8; 32])).unwrap();
    let elsewhere = kept.path().join("elsewhere");
    assert!(matches!(
        t.computers[0].unpack_host_backup(&file, &elsewhere, false),
        Err(Error::NotABackup)
    ));
    assert!(!elsewhere.exists());
    t.computers[0].set_meta("host_key", &hex::encode(pinned)).unwrap();
}

#[test]
fn a_host_file_from_before_a_revocation_is_refused_unless_used_anyway_and_then_revokes_again() {
    let mut t = team();
    let kept = tempfile::tempdir().unwrap();
    let file = kept.path().join("host.gvhost");
    t.host.export_backup(&file).unwrap();
    // Cleo's computer is revoked as lost after the file was made; Ana's computer saw it.
    let cleo = t.computers[2].device().unwrap();
    t.host.revoke_device(cleo, true).unwrap();
    t.computers[0].note_revocations(&t.host.devices().unwrap()).unwrap();
    assert_eq!(t.computers[0].known_revocations().unwrap(), vec![(cleo, true)]);

    let staging = kept.path().join("staging");
    assert!(matches!(
        t.computers[0].unpack_host_backup(&file, &staging, false),
        Err(Error::HostBackupStale)
    ));
    assert!(!staging.exists());
    let moved = t.computers[0].unpack_host_backup(&file, &staging, true).unwrap();
    let again = moved.devices().unwrap().into_iter().find(|d| d.id == cleo).unwrap();
    assert!(again.revoked && again.lost);
    drop(moved);

    // A file made after it is taken as it is.
    let newer = kept.path().join("newer.gvhost");
    t.host.export_backup(&newer).unwrap();
    let staging = kept.path().join("staging-newer");
    t.computers[0].unpack_host_backup(&newer, &staging, false).unwrap();
}

#[test]
fn a_host_file_this_computer_is_not_in_is_refused() {
    let mut t = team();
    let kept = tempfile::tempdir().unwrap();
    let file = kept.path().join("host.gvhost");
    let me = t.computers[0].device().unwrap();
    // As a computer that joined after the file was made.
    t.computers[0].set_meta("device", &Uuid::new_v4().to_string()).unwrap();
    t.host.export_backup(&file).unwrap();
    let staging = kept.path().join("staging");
    assert!(matches!(
        t.computers[0].unpack_host_backup(&file, &staging, true),
        Err(Error::NotInHostBackup)
    ));
    assert!(!staging.exists());
    t.computers[0].set_meta("device", &me.to_string()).unwrap();
    // Or one revoked in it.
    t.host.revoke_device(me, false).unwrap();
    t.host.export_backup(&file).unwrap();
    assert!(matches!(
        t.computers[0].unpack_host_backup(&file, &staging, true),
        Err(Error::NotInHostBackup)
    ));
}

#[test]
fn unpacking_into_a_folder_of_the_callers_leaves_it_and_what_is_in_it() {
    let mut t = team();
    let kept = tempfile::tempdir().unwrap();
    let file = kept.path().join("host.gvhost");
    t.host.export_backup(&file).unwrap();
    let theirs = kept.path().join("theirs");
    fs::create_dir(&theirs).unwrap();
    fs::write(theirs.join("notes.txt"), b"mine").unwrap();
    assert!(matches!(
        t.computers[0].unpack_host_backup(&file, &theirs, false),
        Err(Error::VaultExists)
    ));
    assert_eq!(fs::read(theirs.join("notes.txt")).unwrap(), b"mine");

    // An empty one that fails stays, empty.
    let empty = kept.path().join("empty");
    fs::create_dir(&empty).unwrap();
    let pinned = t.computers[0].host_key().unwrap();
    t.computers[0].set_meta("host_key", &hex::encode([7u8; 32])).unwrap();
    assert!(t.computers[0].unpack_host_backup(&file, &empty, false).is_err());
    assert!(empty.is_dir());
    assert_eq!(fs::read_dir(&empty).unwrap().count(), 0);
    t.computers[0].set_meta("host_key", &hex::encode(pinned)).unwrap();
    t.computers[0].unpack_host_backup(&file, &empty, false).unwrap();
}

#[test]
fn a_host_file_written_while_the_store_is_written_and_checkpointed_elsewhere_unpacks() {
    let mut t = team();
    let kept = tempfile::tempdir().unwrap();
    let dir = t.host.dir().to_owned();
    // The serving host, as hostd export finds it: another connection, writing and checkpointing.
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let writer = {
        let stop = stop.clone();
        let serving = HostStore::open(&dir).unwrap();
        std::thread::spawn(move || {
            let mut n = 0u64;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                serving
                    .conn
                    .execute(
                        "INSERT INTO meta (name, value) VALUES (?1, ?2)",
                        params![format!("filler-{n}"), "x".repeat(4000)],
                    )
                    .unwrap();
                if n.is_multiple_of(8) {
                    serving
                        .conn
                        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
                        .ok();
                }
                n += 1;
            }
        })
    };
    for round in 0..6 {
        let file = kept.path().join(format!("host-{round}.gvhost"));
        t.host.export_backup(&file).unwrap();
        let staging = kept.path().join(format!("staging-{round}"));
        t.computers[0].unpack_host_backup(&file, &staging, false).unwrap();
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    writer.join().unwrap();
}

#[test]
fn a_host_file_whose_database_is_damaged_before_it_was_hashed_is_refused() {
    let mut t = team();
    let kept = tempfile::tempdir().unwrap();
    let file = kept.path().join("host.gvhost");
    let copy = t.host.copy_for_export(&file).unwrap();
    // A page in the middle changed, as a torn copy would have it, and then hashed as it is.
    let path = file.with_extension("db.tmp");
    let mut bytes = fs::read(&path).unwrap();
    let page = 4096;
    assert!(bytes.len() >= 3 * page);
    let at = bytes.len() / page / 2 * page + 100;
    for b in &mut bytes[at..at + 64] {
        *b ^= 0x5a;
    }
    fs::write(&path, &bytes).unwrap();
    copy.write().unwrap();
    let staging = kept.path().join("staging");
    assert!(t.computers[0].unpack_host_backup(&file, &staging, false).is_err());
    assert!(!staging.exists());
}

#[test]
fn after_the_host_is_restored_each_computer_sends_again_what_its_people_saved() {
    let mut t = team();
    let backups = tempfile::tempdir().unwrap();
    let backup = t.host.back_up(backups.path()).unwrap();
    let shino = head(&t.computers[1], t.recipe).revision_id;
    let saved = t.computers[1]
        .save(
            Kind::Recipe,
            Some(shino),
            &json!({ "name": "After", "lines": [], "notes": "" }),
        )
        .unwrap();
    sync(&mut t.computers[1], &mut t.host);

    // The host goes back to before Ben's save, with a new generation.
    let dir = t.host.dir().to_owned();
    let old = t.host.generation().unwrap();
    drop(t.host);
    HostStore::restore(&dir, &backup).unwrap();
    t.host = HostStore::open(&dir).unwrap();
    assert_ne!(t.host.generation().unwrap(), old);
    assert!(!items::exists(&t.host.conn, "revisions", &saved.revision_id).unwrap());

    let result = sync(&mut t.computers[1], &mut t.host);
    assert!(result.accepted.iter().any(|(id, _)| *id == saved.revision_id));
    sync(&mut t.computers[0], &mut t.host);
    assert_eq!(head(&t.computers[0], t.recipe).content["name"], "After");

    // Backups past the fourteenth go.
    for _ in 0..20 {
        t.host.back_up(backups.path()).unwrap();
    }
    assert_eq!(
        fs::read_dir(backups.path()).unwrap().count(),
        crate::vault::host::BACKUPS_KEPT
    );
}
