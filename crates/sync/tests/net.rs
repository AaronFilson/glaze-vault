//! The transport over loopback TLS: syncing with a pinned host, pairing a new computer with a
//! code, and what the host refuses.

use glaze_vault_core::sync::DeviceKey;
use glaze_vault_core::{HostStore, Kind, Role, Vault};
use glaze_vault_sync::net::{self, AdminPairing, Conn, Server};
use glaze_vault_sync::{ClientMsg, Error, HostMsg, PROTOCOL};
use serde_json::json;
use std::path::Path;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsConnector;
use uuid::Uuid;

const PASSWORD: &str = "cone six oxidation";
const ONE_TIME: &str = "pass this on";
const OWN: &str = "their own password";

struct Lan {
    dirs: Vec<TempDir>,
    server: Arc<Server>,
    address: String,
    ana_id: Uuid,
    ben: Uuid,
    /// Ana's computer, a replica, unlocked.
    ana: Vault,
}

/// Ana, an admin, and Ben, a formulator on Shared with a recipe in it, the vault hosted on a
/// server on loopback, and Ana's computer joined to it as the host computer's app would be.
async fn lan() -> Lan {
    let (vault_dir, host_dir, ana_dir) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let (mut vault, _) = Vault::create(vault_dir.path(), PASSWORD).unwrap();
    vault.grow_into_team("Ana").unwrap();
    let shared = vault.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
    let ben = vault
        .add_person("Ben", ONE_TIME, &[(shared, Role::Formulator)])
        .unwrap()
        .id;
    Vault::unlock_as(vault_dir.path(), Some(ben), ONE_TIME)
        .unwrap()
        .set_own_password(OWN)
        .unwrap();
    vault
        .save_in(
            Kind::Recipe,
            shared,
            &json!({ "name": "Shino", "lines": [], "notes": "" }),
        )
        .unwrap();
    let mut host = vault.prepare_host(host_dir.path()).unwrap();
    join_locally(&vault, &mut host, ana_dir.path(), vault.me().id);
    let ana_id = vault.me().id;
    let ana = Vault::unlock_as(ana_dir.path(), Some(ana_id), PASSWORD).unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let server = Server::new(host);
    tokio::spawn(net::serve(listener, server.clone()));
    Lan {
        dirs: vec![vault_dir, host_dir, ana_dir],
        server,
        address,
        ana_id,
        ben,
        ana,
    }
}

/// A computer for `person`, added to the host without pairing.
fn join_locally(admin: &Vault, host: &mut HostStore, dir: &Path, person: Uuid) {
    let device = DeviceKey::generate();
    let certificate = admin
        .certify_device(device.id, "computer", &device.public(), &[person])
        .unwrap();
    host.add_device(&certificate).unwrap();
    Vault::join(dir, &host.join_package(device.id).unwrap(), &device).unwrap();
}

/// A TLS connection to the host with a key of its own, pinning `pin` if given.
async fn raw(
    address: &str,
    pin: Option<Vec<u8>>,
) -> Result<Conn<tokio_rustls::client::TlsStream<TcpStream>>, std::io::Error> {
    let device = DeviceKey::generate();
    let config = Arc::new(net::client_config(device.seed(), pin).unwrap());
    let tcp = TcpStream::connect(address).await?;
    let name = rustls::pki_types::ServerName::try_from("glaze-vault.invalid").unwrap();
    Ok(Conn::new(TlsConnector::from(config).connect(name, tcp).await?))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_computer_syncs_over_tls_with_the_host_it_pinned() {
    let mut lan = lan().await;
    let report = net::sync(&mut lan.ana, &lan.address).await.unwrap();
    assert!(report.pulled > 0);
    assert_eq!(lan.ana.heads(Kind::Recipe).unwrap().len(), 1);

    let head = lan.ana.heads(Kind::Recipe).unwrap().remove(0);
    lan.ana
        .save(
            Kind::Recipe,
            Some(head.revision_id),
            &json!({ "name": "Shino 2", "lines": [], "notes": "" }),
        )
        .unwrap();
    let report = net::sync(&mut lan.ana, &lan.address).await.unwrap();
    assert_eq!(report.accepted, 1);
    assert!(report.refused.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_directory_change_goes_only_while_its_computer_holds_the_directory() {
    let mut lan = lan().await;
    net::sync(&mut lan.ana, &lan.address).await.unwrap();
    lan.ana.create_collection("Glazes").unwrap();
    // Another connection holds the directory, as another computer would.
    let held = net::hold_directory(&lan.ana, &lan.address).await.unwrap();
    let other = Uuid::new_v4();
    lan.server.host().set_directory_holder(Some(other));
    let report = net::sync_holding(&mut lan.ana, &lan.address, &held).await.unwrap();
    assert!(report.refused.is_empty(), "{:?}", report.refused);
    assert!(lan.ana.directory_waiting().unwrap());
    held.release().await;
    // A sync holds it for the change, and lets it go after.
    let report = net::sync(&mut lan.ana, &lan.address).await.unwrap();
    assert!(report.accepted > 0);
    assert!(!lan.ana.directory_waiting().unwrap());
    net::hold_directory(&lan.ana, &lan.address)
        .await
        .unwrap()
        .release()
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_admin_pairs_a_new_computer_with_a_code() {
    let mut lan = lan().await;
    net::sync(&mut lan.ana, &lan.address).await.unwrap();
    let mut pairing = AdminPairing::start(&lan.ana, &lan.address).await.unwrap();
    assert_eq!(pairing.code.len(), 9);
    let code = pairing.code.clone();

    let ben_dir = tempfile::tempdir().unwrap();
    let joining = tokio::spawn({
        let (address, code, dir) = (lan.address.clone(), pairing.code.clone(), ben_dir.path().to_owned());
        async move { net::pair(&address, &code, "Ben's laptop", &dir, &DeviceKey::generate()).await }
    });
    let finished = pairing.wait().await.unwrap();
    assert_eq!(finished.name, "Ben's laptop");
    assert_eq!(finished.fingerprint().len(), 19);
    pairing.approve(&lan.ana, &finished, &[lan.ben]).await.unwrap();
    joining.await.unwrap().unwrap();

    let mut ben = Vault::unlock_as(ben_dir.path(), Some(lan.ben), OWN).unwrap();
    assert_eq!(ben.device().unwrap(), finished.device);
    // It syncs where it paired.
    assert_eq!(ben.host_address().unwrap().as_deref(), Some(lan.address.as_str()));
    net::sync(&mut ben, &lan.address).await.unwrap();
    assert_eq!(ben.heads(Kind::Recipe).unwrap().len(), 1);
    // The host remembers it by its key now; the code is spent.
    assert_eq!(
        lan.server.host().device_with_key(&finished.signing_key).unwrap(),
        Some(finished.device)
    );
    let other = tempfile::tempdir().unwrap();
    assert!(matches!(
        net::pair(&lan.address, &code, "again", other.path(), &DeviceKey::generate()).await,
        Err(Error::Pairing(_))
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_code_ends_the_pairing() {
    let mut lan = lan().await;
    net::sync(&mut lan.ana, &lan.address).await.unwrap();
    let mut pairing = AdminPairing::start(&lan.ana, &lan.address).await.unwrap();
    let wrong = if pairing.code == "1234-5678" {
        "8765-4321"
    } else {
        "1234-5678"
    };
    let dir = tempfile::tempdir().unwrap();
    let tried = net::pair(&lan.address, wrong, "guess", dir.path(), &DeviceKey::generate()).await;
    assert!(
        matches!(tried, Err(Error::Pairing(ref reason)) if reason.contains("wrong")),
        "{tried:?}"
    );
    assert!(!Vault::exists(dir.path()));
    assert!(matches!(pairing.wait().await, Err(Error::Pairing(_))));
    // One attempt only: the right code no longer works either.
    let right = net::pair(&lan.address, &pairing.code, "right", dir.path(), &DeviceKey::generate()).await;
    assert!(matches!(right, Err(Error::Pairing(_))), "{right:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn only_an_admins_computer_starts_a_pairing() {
    let lan = lan().await;
    let ben_dir = tempfile::tempdir().unwrap();
    {
        let vault = Vault::unlock_as(lan.dirs[0].path(), Some(lan.ana_id), PASSWORD).unwrap();
        join_locally(&vault, &mut lan.server.host(), ben_dir.path(), lan.ben);
    }
    let mut ben = Vault::unlock_as(ben_dir.path(), Some(lan.ben), OWN).unwrap();
    net::sync(&mut ben, &lan.address).await.unwrap();
    assert!(AdminPairing::start(&ben, &lan.address).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_host_refuses_a_key_it_does_not_know_and_computers_refuse_a_host_they_did_not_pin() {
    let lan = lan().await;
    let mut stranger = raw(&lan.address, None).await.unwrap();
    stranger
        .send(&ClientMsg::Hello {
            protocol: PROTOCOL,
            device: lan.ana.device().unwrap(),
            levels: Vec::new(),
        })
        .await
        .unwrap();
    assert!(matches!(
        stranger.recv::<HostMsg>().await.unwrap(),
        HostMsg::Refused { .. }
    ));

    let wrong_pin = DeviceKey::generate().public();
    assert!(raw(&lan.address, Some(wrong_pin)).await.is_err());
    assert!(raw(&lan.address, Some(lan.ana.host_key().unwrap())).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_host_computers_own_vault_syncs_with_the_host_it_became_and_lists_its_computers() {
    let (dir, staging) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (mut vault, _) = Vault::create(dir.path(), PASSWORD).unwrap();
    vault.grow_into_team("Ana").unwrap();
    let shared = vault.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
    vault
        .save_in(
            Kind::Recipe,
            shared,
            &json!({ "name": "Shino", "lines": [], "notes": "" }),
        )
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let host = vault.convert_to_host(&staging.path().join("host"), &address).unwrap();
    tokio::spawn(net::serve(listener, Server::new(host)));

    let report = net::sync(&mut vault, &address).await.unwrap();
    assert_eq!(report.accepted, 0);
    let head = vault.heads(Kind::Recipe).unwrap().remove(0);
    vault
        .save(
            Kind::Recipe,
            Some(head.revision_id),
            &json!({ "name": "Shino 2", "lines": [], "notes": "" }),
        )
        .unwrap();
    assert_eq!(net::sync(&mut vault, &address).await.unwrap().accepted, 1);
    assert_eq!(vault.heads(Kind::Recipe).unwrap().len(), 1);

    let devices = net::devices(&vault, &address).await.unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].name, "The host computer");

    vault.stop_syncing().unwrap();
    assert!(net::sync(&mut vault, &address).await.is_err());
    assert_eq!(vault.heads(Kind::Recipe).unwrap().len(), 1);
}

/// Ben's computer, joined without pairing and unlocked.
fn ben_computer(lan: &Lan) -> (TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    {
        let vault = Vault::unlock_as(lan.dirs[0].path(), Some(lan.ana_id), PASSWORD).unwrap();
        join_locally(&vault, &mut lan.server.host(), dir.path(), lan.ben);
    }
    let ben = Vault::unlock_as(dir.path(), Some(lan.ben), OWN).unwrap();
    (dir, ben)
}

struct Shared(std::sync::Mutex<Vault>);

impl net::SharedVault for Shared {
    fn with<T>(&self, work: impl FnOnce(&mut Vault) -> glaze_vault_sync::Result<T>) -> glaze_vault_sync::Result<T> {
        work(&mut self.0.lock().unwrap())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_watching_computer_hears_when_another_pushes() {
    let mut lan = lan().await;
    net::sync(&mut lan.ana, &lan.address).await.unwrap();
    let (_dir, ben) = ben_computer(&lan);
    let ben = Shared(std::sync::Mutex::new(ben));
    net::sync_shared(&ben, &lan.address).await.unwrap();
    let (device, pin) = {
        let ben = ben.0.lock().unwrap();
        (ben.device_key().unwrap(), ben.host_key().unwrap())
    };
    let mut watching = net::watch(&device, pin, &lan.address).await.unwrap();

    let head = lan.ana.heads(Kind::Recipe).unwrap().remove(0);
    lan.ana
        .save(
            Kind::Recipe,
            Some(head.revision_id),
            &json!({ "name": "Shino 2", "lines": [], "notes": "" }),
        )
        .unwrap();
    net::sync(&mut lan.ana, &lan.address).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), watching.next())
        .await
        .expect("news in time")
        .unwrap();
    net::sync_shared(&ben, &lan.address).await.unwrap();
    let names: Vec<String> = ben
        .0
        .lock()
        .unwrap()
        .heads(Kind::Recipe)
        .unwrap()
        .iter()
        .map(|r| r.content["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, ["Shino 2"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn one_computer_at_a_time_holds_the_directory() {
    let mut lan = lan().await;
    net::sync(&mut lan.ana, &lan.address).await.unwrap();
    let (_dir, mut ben) = ben_computer(&lan);
    net::sync(&mut ben, &lan.address).await.unwrap();
    let held = net::hold_directory(&lan.ana, &lan.address).await.unwrap();
    let started = std::time::Instant::now();
    let waiting = async {
        let held = net::hold_directory(&ben, &lan.address).await.unwrap();
        held.release().await;
        started.elapsed()
    };
    let letting_go = async {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        held.release().await;
    };
    let (waited, ()) = tokio::join!(waiting, letting_go);
    assert!(waited >= std::time::Duration::from_millis(300));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_record_is_checked_out_and_released_over_the_network() {
    let mut lan = lan().await;
    net::sync(&mut lan.ana, &lan.address).await.unwrap();
    let (_dir, mut ben) = ben_computer(&lan);
    net::sync(&mut ben, &lan.address).await.unwrap();
    let record = lan.ana.heads(Kind::Recipe).unwrap()[0].record_id;
    let held = net::check_out(&lan.ana, &lan.address, record, false).await.unwrap();
    assert_eq!(held[0].person, lan.ana_id);
    let seen = net::check_out(&ben, &lan.address, record, false).await.unwrap();
    assert_eq!(seen[0].person, lan.ana_id);
    let taken = net::check_out(&ben, &lan.address, record, true).await.unwrap();
    assert_eq!(taken[0].person, lan.ben);
    assert!(net::release(&ben, &lan.address, record).await.unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paired_computer_takes_the_hosts_extension_codes_until_it_is_revoked() {
    let mut lan = lan().await;
    net::sync(&mut lan.ana, &lan.address).await.unwrap();
    let mut pairing = AdminPairing::start(&lan.ana, &lan.address).await.unwrap();
    let ben_dir = tempfile::tempdir().unwrap();
    let joining = tokio::spawn({
        let (address, code, dir) = (lan.address.clone(), pairing.code.clone(), ben_dir.path().to_owned());
        async move { net::pair(&address, &code, "laptop", &dir, &DeviceKey::generate()).await }
    });
    let finished = pairing.wait().await.unwrap();
    pairing.approve(&lan.ana, &finished, &[lan.ben]).await.unwrap();
    joining.await.unwrap().unwrap();
    let mut ben = Vault::unlock_as(ben_dir.path(), Some(lan.ben), OWN).unwrap();
    net::sync(&mut ben, &lan.address).await.unwrap();

    // Both sides have the secret from pairing, so the host's code works here.
    let code = net::extension_code(&lan.ana, &lan.address, finished.device, 5)
        .await
        .unwrap();
    let status = ben.extend(&code).unwrap();
    assert!(status.extended_until.is_some());
    // Only an admin's computer gets one.
    assert!(
        net::extension_code(&ben, &lan.address, finished.device, 5)
            .await
            .is_err()
    );

    let devices = net::revoke_device(&lan.ana, &lan.address, finished.device, false)
        .await
        .unwrap();
    assert!(devices.iter().any(|d| d.id == finished.device && d.revoked && !d.lost));
    assert!(matches!(
        net::sync(&mut ben, &lan.address).await,
        Err(Error::Core(glaze_vault_core::Error::Revoked))
    ));
    // An admin's computer cannot revoke itself.
    let own = lan.ana.device().unwrap();
    assert!(net::revoke_device(&lan.ana, &lan.address, own, false).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_admins_computer_saves_a_backup_of_the_host_and_puts_one_back() {
    let mut lan = lan().await;
    net::sync(&mut lan.ana, &lan.address).await.unwrap();
    assert!(net::host_backups(&lan.ana, &lan.address).await.unwrap().is_empty());
    let kept = tempfile::tempdir().unwrap();
    let file = kept.path().join("studio.gvhost");
    let made = net::download_host_backup(&lan.ana, &lan.address, &file).await.unwrap();
    assert_eq!(lan.ana.check_host_backup(&file).unwrap(), made);
    // Nothing is left behind on the host, once it sees the connection end.
    let host_dir = lan.dirs[1].path();
    let left = || {
        std::fs::read_dir(host_dir)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().path().extension().is_some_and(|x| x == "gvhost"))
            .count()
    };
    for _ in 0..50 {
        if left() == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(left(), 0);

    // Sent back, it becomes one of the host's backups, and hostd is asked to restore it.
    net::restore_host_from_file(&lan.ana, &lan.address, &file)
        .await
        .unwrap();
    let backups = net::host_backups(&lan.ana, &lan.address).await.unwrap();
    assert_eq!(backups.len(), 1);
    let asked = std::fs::read_to_string(host_dir.join(glaze_vault_core::RESTORE_FILE)).unwrap();
    assert!(asked.ends_with(&backups[0].name));
    std::fs::remove_file(host_dir.join(glaze_vault_core::RESTORE_FILE)).unwrap();
    net::restore_host_backup(&lan.ana, &lan.address, &backups[0].name)
        .await
        .unwrap();
    assert!(host_dir.join(glaze_vault_core::RESTORE_FILE).exists());
    assert!(
        net::restore_host_backup(&lan.ana, &lan.address, "backup-1")
            .await
            .is_err()
    );

    // Only an admin's computer.
    let ben_dir = tempfile::tempdir().unwrap();
    {
        let vault = Vault::unlock_as(lan.dirs[0].path(), Some(lan.ana_id), PASSWORD).unwrap();
        join_locally(&vault, &mut lan.server.host(), ben_dir.path(), lan.ben);
    }
    let ben = Vault::unlock_as(ben_dir.path(), Some(lan.ben), OWN).unwrap();
    assert!(net::host_backups(&ben, &lan.address).await.is_err());
    assert!(
        net::download_host_backup(&ben, &lan.address, &kept.path().join("ben.gvhost"))
            .await
            .is_err()
    );
    assert!(net::restore_host_from_file(&ben, &lan.address, &file).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_vault_converted_to_a_host_syncs_with_it_at_once() {
    let vault_dir = tempfile::tempdir().unwrap();
    let staging = tempfile::tempdir().unwrap();
    let mut vault = Vault::create(vault_dir.path(), PASSWORD).unwrap().0;
    vault.grow_into_team("Ana").unwrap();
    let shared = vault.collections().iter().find(|c| c.owner.is_none()).unwrap().id;
    vault
        .add_person("Ben", ONE_TIME, &[(shared, Role::Formulator)])
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let host = vault.convert_to_host(staging.path(), &address).unwrap();
    tokio::spawn(net::serve(listener, Server::new(host)));
    vault.create_collection("Glazes").unwrap();
    assert!(vault.directory_waiting().unwrap());
    let synced = tokio::time::timeout(std::time::Duration::from_secs(20), net::sync(&mut vault, &address)).await;
    assert!(synced.expect("the first sync hangs").is_ok());
}
