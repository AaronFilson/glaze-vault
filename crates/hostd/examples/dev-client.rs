//! A client for trying the host by hand, for developers only: the app's own host and client modes
//! are stages 6 and 7. Passwords come from GLAZE_PASSWORD; `--as NAME` picks the person.
//!
//!   dev-client make-team <vault-dir> --as NAME [--add NAME...]
//!                                     a new team vault; others get GLAZE_PASSWORD as a one-time
//!                                     password, formulators on Shared
//!   dev-client prepare <vault-dir> <host-dir> --as NAME     make a host's store from a team vault
//!   dev-client join-local <vault-dir> <host-dir> <dir> --as NAME
//!                                     this person's computer as a replica, without pairing
//!   dev-client sync <dir> <address> --as NAME
//!   dev-client pair-start <dir> <address> --as NAME [--for NAME...]
//!                                     an admin: show a code, wait, and approve the computer
//!   dev-client pair <address> <code> <device-name> <dir>
//!   dev-client discover

use glaze_vault_core::sync::DeviceKey;
use glaze_vault_core::{HostStore, Kind, Role, Vault};
use glaze_vault_sync::net::{self, AdminPairing, DEFAULT_PORT};
use std::path::Path;
use std::time::Duration;
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;

fn password() -> Result<String> {
    std::env::var("GLAZE_PASSWORD").map_err(|_| "set GLAZE_PASSWORD".to_owned())
}

/// The person called `name` in the vault at `dir`.
fn person(dir: &Path, name: &str) -> Result<Uuid> {
    Vault::people_in(dir)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.name == name)
        .map(|p| p.id)
        .ok_or_else(|| format!("no one called {name}"))
}

fn unlock(dir: &Path, name: &str) -> Result<Vault> {
    Vault::unlock_as(dir, Some(person(dir, name)?), &password()?).map_err(|e| e.to_string())
}

/// `--flag value`s, and the rest.
fn split(args: Vec<String>) -> (Vec<String>, Vec<(String, String)>) {
    let (mut plain, mut flags) = (Vec::new(), Vec::new());
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.strip_prefix("--") {
            Some(flag) => flags.push((flag.to_owned(), args.next().unwrap_or_default())),
            None => plain.push(arg),
        }
    }
    (plain, flags)
}

fn flag<'a>(flags: &'a [(String, String)], name: &str) -> Result<&'a str> {
    flags
        .iter()
        .find(|(f, _)| f == name)
        .map(|(_, v)| v.as_str())
        .ok_or_else(|| format!("--{name} is needed"))
}

/// An address with the default port if it names none.
fn address(text: &str) -> String {
    if text.contains(':') {
        text.to_owned()
    } else {
        format!("{text}:{DEFAULT_PORT}")
    }
}

#[tokio::main]
async fn main() {
    let (plain, flags) = split(std::env::args().skip(1).collect());
    let args: Vec<&str> = plain.iter().map(String::as_str).collect();
    let done = match args.as_slice() {
        ["make-team", vault] => make_team(vault, &flags),
        ["prepare", vault, host] => prepare(vault, host, &flags),
        ["join-local", vault, host, dir] => join_local(vault, host, dir, &flags),
        ["sync", dir, to] => sync(dir, to, &flags).await,
        ["pair-start", dir, to] => pair_start(dir, to, &flags).await,
        ["pair", to, code, name, dir] => net::pair(&address(to), code, name, Path::new(dir))
            .await
            .map(|()| println!("joined: sign in with your password"))
            .map_err(|e| e.to_string()),
        ["discover"] => discover(),
        _ => Err("see the top of crates/hostd/examples/dev-client.rs".to_owned()),
    };
    if let Err(message) = done {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

fn make_team(dir: &str, flags: &[(String, String)]) -> Result<()> {
    let (mut vault, _) = Vault::create(Path::new(dir), &password()?).map_err(|e| e.to_string())?;
    vault.grow_into_team(flag(flags, "as")?).map_err(|e| e.to_string())?;
    let shared = vault
        .collections()
        .iter()
        .find(|c| c.owner.is_none())
        .map(|c| c.id)
        .ok_or("no shared collection")?;
    for (_, name) in flags.iter().filter(|(f, _)| f == "add") {
        vault
            .add_person(name, &password()?, &[(shared, Role::Formulator)])
            .map_err(|e| e.to_string())?;
    }
    vault
        .save_in(
            Kind::Recipe,
            shared,
            &serde_json::json!({ "name": "Shino", "lines": [], "notes": "" }),
        )
        .map_err(|e| e.to_string())?;
    println!("made; others sign in once with the same password to set their own");
    Ok(())
}

fn prepare(vault: &str, host: &str, flags: &[(String, String)]) -> Result<()> {
    let mut vault = unlock(Path::new(vault), flag(flags, "as")?)?;
    let host = vault.prepare_host(Path::new(host)).map_err(|e| e.to_string())?;
    println!("host prepared; its key is {}", net::fingerprint(&host.identity()));
    Ok(())
}

fn join_local(vault: &str, host: &str, dir: &str, flags: &[(String, String)]) -> Result<()> {
    let name = flag(flags, "as")?;
    let id = person(Path::new(vault), name)?;
    let vault = unlock(Path::new(vault), name)?;
    let mut host = HostStore::open(Path::new(host)).map_err(|e| e.to_string())?;
    let device = DeviceKey::generate();
    let certificate = vault
        .certify_device(device.id, "dev client", &device.public(), &[id])
        .map_err(|e| e.to_string())?;
    host.add_device(&certificate).map_err(|e| e.to_string())?;
    let package = host.join_package(device.id).map_err(|e| e.to_string())?;
    Vault::join(Path::new(dir), &package, &device).map_err(|e| e.to_string())?;
    println!("joined as {name}");
    Ok(())
}

async fn sync(dir: &str, to: &str, flags: &[(String, String)]) -> Result<()> {
    let mut vault = unlock(Path::new(dir), flag(flags, "as")?)?;
    let report = net::sync(&mut vault, &address(to)).await.map_err(|e| e.to_string())?;
    println!(
        "pulled {}, accepted {}, refused {}",
        report.pulled,
        report.accepted,
        report.refused.len()
    );
    Ok(())
}

async fn pair_start(dir: &str, to: &str, flags: &[(String, String)]) -> Result<()> {
    let dir = Path::new(dir);
    let vault = unlock(dir, flag(flags, "as")?)?;
    let mut pairing = AdminPairing::start(&vault, &address(to))
        .await
        .map_err(|e| e.to_string())?;
    println!("pairing code: {} (10 minutes, one try)", pairing.code);
    let finished = pairing.wait().await.map_err(|e| e.to_string())?;
    println!("\"{}\" used it; its key is {}", finished.name, finished.fingerprint());
    let people = flags
        .iter()
        .filter(|(f, _)| f == "for")
        .map(|(_, name)| {
            vault
                .people()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|p| p.name == *name)
                .map(|p| p.id)
                .ok_or_else(|| format!("no one called {name}"))
        })
        .collect::<Result<Vec<_>>>()?;
    pairing
        .approve(&vault, &finished, &people)
        .await
        .map_err(|e| e.to_string())?;
    println!("approved");
    Ok(())
}

fn discover() -> Result<()> {
    for host in net::browse(Duration::from_secs(3)).map_err(|e| e.to_string())? {
        println!(
            "{}: {:?} port {}, vault tag {}",
            host.name,
            host.addresses,
            host.port,
            host.vault.unwrap_or_default()
        );
    }
    Ok(())
}
