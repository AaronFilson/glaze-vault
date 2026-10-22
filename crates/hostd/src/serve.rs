//! Serving: the store opened, the port bound, the host advertised, until `shutdown`, or until
//! this binary is replaced by an update, when the service manager starts the new one.

use glaze_vault_core::HostStore;
use glaze_vault_sync::net::{self, DEFAULT_PORT, Server};
use std::future::Future;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

pub struct Options {
    pub dir: PathBuf,
    pub port: Option<u16>,
    /// Where to write the port bound, for `--port 0` in tests.
    pub port_file: Option<PathBuf>,
    pub name: Option<String>,
    pub mdns: bool,
}

pub async fn serve(options: Options, shutdown: impl Future<Output = ()>) -> Result<(), String> {
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
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    if let Some(file) = &options.port_file {
        std::fs::write(file, port.to_string()).map_err(|e| e.to_string())?;
    }
    log::info!("listening on port {port}");
    let _advertised = if options.mdns {
        let name = options.name.unwrap_or_else(|| crate::DEFAULT_NAME.into());
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
        () = shutdown => {
            log::info!("stopping");
            Ok(())
        }
        () = replaced() => {
            log::info!("this program was updated: stopping, for the new one to start");
            Ok(())
        }
    }
}

/// When this binary's file changes, as an update replaces it. Windows locks a running binary, so
/// its installer stops the service instead (crates/app/windows/hooks.nsh).
async fn replaced() {
    let modified = || {
        std::env::current_exe()
            .and_then(std::fs::metadata)
            .and_then(|m| m.modified())
            .ok()
    };
    let started: Option<SystemTime> = modified();
    if cfg!(windows) || started.is_none() {
        return std::future::pending().await;
    }
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        if modified() != started {
            return;
        }
    }
}
