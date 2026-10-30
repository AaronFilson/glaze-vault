//! The LAN host's daemon (docs/adr/0021-transport-and-pairing.md, 0022-host-mode.md).
//!
//!   hostd run <host-dir> [--port N] [--port-file FILE] [--name NAME] [--no-mdns]
//!   hostd install --from <staging-dir> [--port N] [--name NAME]     elevated
//!   hostd uninstall [--keep-data]                                   elevated
//!   hostd status
//!   hostd backups [--dir <host-dir>]
//!   hostd restore <backup-folder | file.gvhost> [--dir <host-dir>]  elevated
//!
//! `run` serves in the foreground. `install` moves a host's store, made by the app, into the
//! system's data folder and runs this same binary there as a service from boot.

mod log_to;
mod serve;
mod service;

use serve::Options;
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage: hostd run <host-dir> [--port N] [--port-file FILE] [--name NAME] [--no-mdns]
       hostd install --from <staging-dir> [--port N] [--name NAME]
       hostd uninstall [--keep-data]
       hostd status
       hostd backups [--dir <host-dir>]
       hostd restore <backup-folder | file.gvhost> [--dir <host-dir>]";

/// The name the host is advertised by when none is given.
pub const DEFAULT_NAME: &str = "Glaze Vault host";

fn port(text: Option<String>) -> Result<u16, String> {
    let text = text.ok_or(USAGE)?;
    text.parse().map_err(|_| format!("not a port: {text}"))
}

/// `run`'s options, after the folder.
pub fn run_options(dir: PathBuf, mut args: impl Iterator<Item = String>) -> Result<Options, String> {
    let mut options = Options {
        dir,
        port: None,
        port_file: None,
        name: None,
        mdns: true,
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => options.port = Some(port(args.next())?),
            "--port-file" => options.port_file = Some(PathBuf::from(args.next().ok_or(USAGE)?)),
            "--name" => options.name = Some(args.next().ok_or(USAGE)?),
            "--no-mdns" => options.mdns = false,
            _ => return Err(USAGE.into()),
        }
    }
    Ok(options)
}

/// `--dir`, or where the installed service keeps the store.
fn host_dir(args: &mut impl Iterator<Item = String>) -> Result<PathBuf, String> {
    match (args.next().as_deref(), args.next()) {
        (None, _) => Ok(service::data_dir()),
        (Some("--dir"), Some(dir)) => Ok(PathBuf::from(dir)),
        _ => Err(USAGE.into()),
    }
}

/// Puts the host's store back as a backup had it. A running service is asked to, and restarts
/// itself to; otherwise it is done now.
fn restore(dir: &std::path::Path, backup: &std::path::Path) -> Result<(), String> {
    let mut backup = backup
        .canonicalize()
        .map_err(|e| format!("{}: {e}", backup.display()))?;
    // A file an admin's computer saved goes in among the backups first; it must be this host's.
    if backup.is_file() {
        let host = glaze_vault_core::HostStore::open(dir).map_err(|e| e.to_string())?;
        let name = host.import_backup(&backup).map_err(|e| e.to_string())?;
        backup = dir.join(serve::BACKUPS).join(name);
    }
    if service::running() && dir == service::data_dir() {
        std::fs::write(dir.join(serve::RESTORE_FILE), backup.to_string_lossy().as_bytes())
            .map_err(|e| e.to_string())?;
        println!("the service restores it as it starts again, in a few seconds");
        return Ok(());
    }
    glaze_vault_core::HostStore::restore(dir, &backup).map_err(|e| e.to_string())?;
    println!("restored: computers send again what the backup lacks when they next sync");
    Ok(())
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    let done = match command.as_str() {
        "run" => {
            log_to::stderr();
            args.next()
                .ok_or_else(|| USAGE.to_owned())
                .and_then(|dir| run_options(PathBuf::from(dir), args))
                .and_then(|options| {
                    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
                    runtime.block_on(serve::serve(options, async {
                        let _ = tokio::signal::ctrl_c().await;
                    }))
                })
        }
        "service" => service::run_as_service(args.collect()),
        "install" => {
            let mut from = None;
            let (mut port_arg, mut name) = (None, None);
            let mut bad = false;
            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--from" => from = args.next().map(PathBuf::from),
                    "--port" => port_arg = Some(args.next()),
                    "--name" => name = args.next(),
                    _ => bad = true,
                }
            }
            match (from, bad) {
                (Some(from), false) => port_arg.map(port).transpose().and_then(|port| {
                    service::install(
                        &from,
                        port.unwrap_or(glaze_vault_sync::net::DEFAULT_PORT),
                        name.as_deref().unwrap_or(DEFAULT_NAME),
                    )
                }),
                _ => Err(USAGE.into()),
            }
        }
        "uninstall" => match args.next().as_deref() {
            None => service::uninstall(false),
            Some("--keep-data") => service::uninstall(true),
            Some(_) => Err(USAGE.into()),
        },
        "status" => service::status().map(|status| println!("{status}")),
        "backups" => host_dir(&mut args).and_then(|dir| {
            let mut made: Vec<_> = std::fs::read_dir(dir.join(serve::BACKUPS))
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.is_dir())
                .collect();
            made.sort();
            made.iter().for_each(|p| println!("{}", p.display()));
            Ok(())
        }),
        "restore" => match args.next() {
            Some(backup) => host_dir(&mut args).and_then(|dir| restore(&dir, &PathBuf::from(backup))),
            None => Err(USAGE.into()),
        },
        _ => Err(USAGE.into()),
    };
    match done {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            log::error!("{message}");
            ExitCode::FAILURE
        }
    }
}
