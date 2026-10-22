//! The LAN host's daemon (docs/adr/0021-transport-and-pairing.md). For now it runs in the
//! foreground only: `hostd run <host-dir>`. Installing it as a service is stage 6 of the plan.

use glaze_vault_core::HostStore;
use glaze_vault_sync::net::{self, DEFAULT_PORT, Server};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage: hostd run <host-dir> [--port N] [--name NAME] [--no-mdns]";

/// Writes the log to standard error.
struct Stderr;

impl log::Log for Stderr {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("{} {}", record.level(), record.args());
        }
    }

    fn flush(&self) {}
}

struct Options {
    dir: PathBuf,
    port: Option<u16>,
    name: Option<String>,
    mdns: bool,
}

fn options(mut args: impl Iterator<Item = String>) -> Result<Options, String> {
    if args.next().as_deref() != Some("run") {
        return Err(USAGE.into());
    }
    let dir = PathBuf::from(args.next().ok_or(USAGE)?);
    let mut options = Options {
        dir,
        port: None,
        name: None,
        mdns: true,
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                let port = args.next().ok_or(USAGE)?;
                options.port = Some(port.parse().map_err(|_| format!("not a port: {port}"))?);
            }
            "--name" => options.name = Some(args.next().ok_or(USAGE)?),
            "--no-mdns" => options.mdns = false,
            _ => return Err(USAGE.into()),
        }
    }
    Ok(options)
}

#[tokio::main]
async fn main() -> ExitCode {
    let _ = log::set_logger(&Stderr).map(|()| log::set_max_level(log::LevelFilter::Info));
    let options = match options(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    match run(options).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            log::error!("{message}");
            ExitCode::FAILURE
        }
    }
}

async fn run(options: Options) -> Result<(), String> {
    let host = HostStore::open(&options.dir).map_err(|e| format!("the host's store does not open: {e}"))?;
    let port = options.port.or(host.port()).unwrap_or(DEFAULT_PORT);
    let organization_key = host.organization_key().map_err(|e| e.to_string())?;
    log::info!(
        "vault {}, host key {}",
        host.vault_id(),
        net::fingerprint(&host.identity())
    );
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("port {port}: {e}"))?;
    log::info!("listening on port {port}");
    let _advertised = if options.mdns {
        let name = options.name.unwrap_or_else(|| "Glaze Vault host".into());
        match net::advertise(&name, port, &organization_key) {
            Ok(advertised) => {
                log::info!("advertising \"{name}\" by mDNS");
                Some(advertised)
            }
            Err(e) => {
                log::warn!("not advertised by mDNS: {e}");
                None
            }
        }
    } else {
        None
    };
    let server = Server::new(host);
    tokio::select! {
        served = net::serve(listener, server) => served.map_err(|e| e.to_string()),
        _ = tokio::signal::ctrl_c() => {
            log::info!("stopping");
            Ok(())
        }
    }
}
