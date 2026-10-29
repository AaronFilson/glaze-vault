//! Syncing through the sessions and frames, in one process: a host and computers that each sync
//! when they like, as laptops that come and go do.

use glaze_vault_core::sync::{DeviceKey, Item};
use glaze_vault_core::{HostStore, Kind, Revision, Role, Vault};
use glaze_vault_sync::{ClientMsg, Error, Frames, HostMsg, HostSession, PROTOCOL, frame, sync_in_process};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use tempfile::TempDir;
use uuid::Uuid;

const PASSWORD: &str = "cone six oxidation";
const ONE_TIME: &str = "pass this on";
const OWN: &str = "their own password";

struct Team {
    _dirs: Vec<TempDir>,
    host: HostStore,
    shared: Uuid,
    people: Vec<Uuid>,
    computers: Vec<Vault>,
}

/// Ana, an admin, and others with `roles` on Shared, a recipe saved, the vault hosted, and a
/// computer each for Ana and the first two of the others, synced once.
fn team(others: &[(&str, Role)]) -> Team {
    let (vault_dir, host_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (mut ana, _) = Vault::create(vault_dir.path(), PASSWORD).unwrap();
    ana.grow_into_team("Ana").unwrap();
    let shared = ana.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
    let mut people = vec![ana.me().id];
    for (name, role) in others {
        people.push(ana.add_person(name, ONE_TIME, &[(shared, *role)]).unwrap().id);
    }
    for person in &people[1..] {
        Vault::unlock_as(vault_dir.path(), Some(*person), ONE_TIME)
            .unwrap()
            .set_own_password(OWN)
            .unwrap();
    }
    ana.save_in(
        Kind::Recipe,
        shared,
        &json!({ "name": "Shino", "lines": [], "notes": "" }),
    )
    .unwrap();
    let mut host = ana.prepare_host(host_dir.path()).unwrap();
    let mut dirs = vec![vault_dir, host_dir];
    let mut computers = Vec::new();
    for (index, person) in people.iter().take(3).enumerate() {
        let dir = tempfile::tempdir().unwrap();
        computers.push(join(
            &ana,
            &mut host,
            dir.path(),
            *person,
            if index == 0 { PASSWORD } else { OWN },
        ));
        dirs.push(dir);
    }
    Team {
        _dirs: dirs,
        host,
        shared,
        people,
        computers,
    }
}

/// A computer for `person`, certified by Ana, joined, unlocked and synced.
fn join(ana: &Vault, host: &mut HostStore, dir: &Path, person: Uuid, password: &str) -> Vault {
    let device = DeviceKey::generate();
    let certificate = ana
        .certify_device(device.id, "computer", &device.public(), &[person])
        .unwrap();
    host.add_device(&certificate).unwrap();
    Vault::join(dir, &host.join_package(device.id).unwrap(), &device).unwrap();
    let mut computer = Vault::unlock_as(dir, Some(person), password).unwrap();
    sync_in_process(&mut computer, host).unwrap();
    computer
}

#[test]
fn messages_cross_in_frames_split_anywhere() {
    let mut t = team(&[("Ben", Role::Formulator)]);
    let head = t.computers[1].heads(Kind::Recipe).unwrap().remove(0);
    t.computers[1]
        .save(
            Kind::Recipe,
            Some(head.revision_id),
            &json!({ "name": "Shino 2", "lines": [], "notes": "" }),
        )
        .unwrap();
    t.computers[1]
        .add_attachment(Kind::Recipe, head.record_id, "image/png", &[7; 300_000])
        .unwrap();
    let items = t.computers[1].pending(usize::MAX).unwrap();
    let bytes = frame(&ClientMsg::Push { items }).unwrap();
    let mut frames = Frames::default();
    for piece in bytes.chunks(1000) {
        assert!(frames.read::<ClientMsg>().unwrap().is_none());
        frames.push(piece);
    }
    let Some(ClientMsg::Push { items }) = frames.read::<ClientMsg>().unwrap() else {
        panic!("not the push");
    };
    assert!(matches!(&items[..], [Item::Revision(_), Item::Attachment(a)] if a.ciphertext.len() > 300_000));
    // The attachment's bytes are carried as bytes, not as text.
    assert!(bytes.len() < 310_000);
    assert!(frames.read::<ClientMsg>().unwrap().is_none());

    let mut huge = (64u32 * 1024 * 1024).to_be_bytes().to_vec();
    huge.push(0);
    let mut frames = Frames::default();
    frames.push(&huge);
    assert!(matches!(frames.read::<ClientMsg>(), Err(Error::TooLarge(_))));
}

#[test]
fn a_host_talks_only_to_the_computer_the_transport_vouched_for() {
    let mut t = team(&[("Ben", Role::Formulator)]);
    let ben = t.computers[1].device().unwrap();
    let mut session = HostSession::new(ben);
    let pull = ClientMsg::Pull {
        cursors: Vec::new(),
        max_bytes: 1000,
    };
    assert!(matches!(
        session.handle(&mut t.host, pull).unwrap(),
        Some(HostMsg::Refused { .. })
    ));
    let hello = |protocol, device| ClientMsg::Hello {
        protocol,
        device,
        levels: Vec::new(),
    };
    assert!(matches!(
        session.handle(&mut t.host, hello(PROTOCOL + 1, ben)).unwrap(),
        Some(HostMsg::Refused { .. })
    ));
    assert!(matches!(
        session.handle(&mut t.host, hello(PROTOCOL, Uuid::new_v4())).unwrap(),
        Some(HostMsg::Refused { .. })
    ));
    assert!(matches!(
        session.handle(&mut t.host, hello(PROTOCOL, ben)).unwrap(),
        Some(HostMsg::Welcome(_))
    ));
    assert!(session.handle(&mut t.host, ClientMsg::Bye).unwrap().is_none());
}

#[test]
fn a_sync_reports_what_it_pulled_and_pushed() {
    let mut t = team(&[("Ben", Role::Formulator)]);
    t.computers[1]
        .save_in(
            Kind::Recipe,
            t.shared,
            &json!({ "name": "Tenmoku", "lines": [], "notes": "" }),
        )
        .unwrap();
    let report = sync_in_process(&mut t.computers[1], &mut t.host).unwrap();
    assert_eq!(report.accepted, 1);
    assert!(report.refused.is_empty());
    let report = sync_in_process(&mut t.computers[0], &mut t.host).unwrap();
    assert!(report.pulled >= 1);
    assert_eq!(t.computers[0].heads(Kind::Recipe).unwrap().len(), 2);
    // Nothing new: nothing pulled, nothing pushed.
    let report = sync_in_process(&mut t.computers[0], &mut t.host).unwrap();
    assert_eq!((report.pulled, report.accepted), (0, 0));
}

/// A small random number generator, so the test is the same every run.
struct Rng(u64);

impl Rng {
    fn below(&mut self, n: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 33) % n as u64) as usize
    }
}

/// What a computer shows of the recipes: each record's newest revisions (more than one for a
/// fork), the deleted ones apart.
fn view(vault: &Vault) -> (BTreeMap<Uuid, BTreeSet<Uuid>>, BTreeMap<Uuid, BTreeSet<Uuid>>) {
    let heads = |list: Vec<Revision>| {
        list.into_iter()
            .map(|r| {
                let mut ids: BTreeSet<Uuid> = r.forks.iter().map(|f| f.revision_id).collect();
                ids.insert(r.revision_id);
                (r.record_id, ids)
            })
            .collect()
    };
    (
        heads(vault.heads(Kind::Recipe).unwrap()),
        heads(vault.deleted(Kind::Recipe).unwrap()),
    )
}

#[test]
fn computers_that_save_delete_and_sync_at_random_end_up_the_same() {
    let mut t = team(&[
        ("Ben", Role::Formulator),
        ("Eve", Role::Formulator),
        ("Cleo", Role::Chemist),
    ]);
    let cleo = t.people[3];
    let mut cleo_has_role = true;
    let mut rng = Rng(20261021);
    for step in 0..240 {
        let at = rng.below(3);
        let computer = &mut t.computers[at];
        match rng.below(10) {
            0..=3 => {
                let heads = computer.heads(Kind::Recipe).unwrap();
                if !heads.is_empty() {
                    let head = &heads[rng.below(heads.len())];
                    computer
                        .save(
                            Kind::Recipe,
                            Some(head.revision_id),
                            &json!({ "name": format!("step {step}"), "lines": [], "notes": "" }),
                        )
                        .unwrap();
                }
            }
            4 => {
                computer
                    .save_in(
                        Kind::Recipe,
                        t.shared,
                        &json!({ "name": format!("new {step}"), "lines": [], "notes": "" }),
                    )
                    .unwrap();
            }
            5 => {
                let heads = computer.heads(Kind::Recipe).unwrap();
                if !heads.is_empty() {
                    computer
                        .delete(Kind::Recipe, heads[rng.below(heads.len())].revision_id)
                        .unwrap();
                }
            }
            6..=8 => {
                let report = sync_in_process(computer, &mut t.host).unwrap();
                assert!(report.refused.is_empty(), "step {step}: {:?}", report.refused);
            }
            _ => {
                // Ana, connected, gives Cleo (who has no computer here) a role on Shared or takes
                // it away, which gives Shared a new key: whatever was saved away under the old one
                // is sealed again before it is pushed.
                let ana = &mut t.computers[0];
                sync_in_process(ana, &mut t.host).unwrap();
                let role = if cleo_has_role { None } else { Some(Role::Chemist) };
                ana.set_role(cleo, t.shared, role).unwrap();
                cleo_has_role = !cleo_has_role;
                let report = sync_in_process(ana, &mut t.host).unwrap();
                assert!(report.refused.is_empty(), "step {step}: {:?}", report.refused);
            }
        }
    }
    for _ in 0..2 {
        for computer in &mut t.computers {
            let report = sync_in_process(computer, &mut t.host).unwrap();
            assert!(report.refused.is_empty(), "{:?}", report.refused);
        }
    }
    let views: Vec<_> = t.computers.iter().map(view).collect();
    assert!(views[0].0.len() > 3, "some recipes were made");
    assert!(
        views.iter().any(|(heads, _)| heads.values().any(|ids| ids.len() > 1)),
        "some forked"
    );
    assert_eq!(views[0], views[1]);
    assert_eq!(views[0], views[2]);
    for computer in &mut t.computers {
        assert!(computer.pending(usize::MAX).unwrap().is_empty());
    }
}

#[test]
fn a_photo_travels_in_pieces_both_ways() {
    let mut t = team(&[("Ben", Role::Formulator)]);
    let head = t.computers[1].heads(Kind::Recipe).unwrap().remove(0);
    let photo: Vec<u8> = (0..3_500_000u32).map(|i| (i % 253) as u8).collect();
    let attached = t.computers[1]
        .add_attachment(Kind::Recipe, head.record_id, "image/jpeg", &photo)
        .unwrap();
    // Ben's computer sends it in pieces before the push that holds it.
    let report = sync_in_process(&mut t.computers[1], &mut t.host).unwrap();
    assert_eq!(report.accepted, 1);
    assert!(report.refused.is_empty());
    // Ana's pulls it without its bytes, then fetches them.
    let report = sync_in_process(&mut t.computers[0], &mut t.host).unwrap();
    assert_eq!(report.fetched, 1);
    assert!(!report.more_photos);
    assert_eq!(*t.computers[0].attachment(attached.id).unwrap().1, photo);
    assert!(t.computers[0].missing_bytes().unwrap().is_empty());
}

#[test]
fn each_sync_asks_who_is_changing_what() {
    let mut t = team(&[("Ben", Role::Formulator)]);
    let head = t.computers[1].heads(Kind::Recipe).unwrap().remove(0);
    let ana_device = t.computers[0].device().unwrap();
    t.host
        .check_out(ana_device, t.people[0], head.record_id, false)
        .unwrap();
    sync_in_process(&mut t.computers[1], &mut t.host).unwrap();
    assert_eq!(t.computers[1].checkouts().len(), 1);
    assert!(matches!(
        t.computers[1].save(
            Kind::Recipe,
            Some(head.revision_id),
            &json!({ "name": "Ben's", "lines": [], "notes": "" })
        ),
        Err(glaze_vault_core::Error::CheckedOut(_))
    ));
}
