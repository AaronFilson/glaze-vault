//! Serving: the store opened, the port bound, the host advertised, and a backup made each day,
//! until `shutdown`, or until this binary is replaced by an update, or a restore is asked for,
//! when the service manager starts it again (docs/adr/0024-offline-limits-and-revocation.md).

use glaze_vault_core::HostStore;
use glaze_vault_sync::net::{self, DEFAULT_PORT, Server};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

/// A file in the host's folder naming a backup to restore at the next start, and where the
/// daily backups go, in the host's folder.
pub use glaze_vault_core::{HOST_BACKUPS as BACKUPS, RESTORE_FILE};
const DAY: Duration = Duration::from_secs(24 * 60 * 60);

/// Restores the backup a restore asked for, if one did, before the store opens.
fn restore_asked(dir: &Path) -> Result<(), String> {
    let file = dir.join(RESTORE_FILE);
    let Ok(backup) = std::fs::read_to_string(&file) else {
        return Ok(());
    };
    let _ = std::fs::remove_file(&file);
    let backup = PathBuf::from(backup.trim());
    HostStore::restore(dir, &backup).map_err(|e| format!("restoring {}: {e}", backup.display()))?;
    log::info!(
        "restored the backup {}: computers send again what it lacks",
        backup.display()
    );
    Ok(())
}

pub struct Options {
    pub dir: PathBuf,
    pub port: Option<u16>,
    /// Where to write the port bound, for `--port 0` in tests.
    pub port_file: Option<PathBuf>,
    pub name: Option<String>,
    pub mdns: bool,
}

pub async fn serve(options: Options, shutdown: impl Future<Output = ()>) -> Result<(), String> {
    restore_asked(&options.dir)?;
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
    let backups = options.dir.join(BACKUPS);
    tokio::select! {
        served = net::serve(listener, server.clone()) => served.map_err(|e| e.to_string()),
        () = backing_up(server, backups) => Ok(()),
        () = restore_requested(&options.dir) => {
            // The service manager starts this again, and the backup goes in before the store opens.
            Err("stopping to restore a backup".into())
        }
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

/// A backup a minute after starting, then each day (the plan's question 12).
async fn backing_up(server: Arc<Server>, backups: PathBuf) {
    tokio::time::sleep(Duration::from_secs(60)).await;
    loop {
        // Only the copy holds the store; syncs go on while the rest is done.
        let copied = server.host().copy_for_backup(&backups);
        match copied.and_then(|partial| glaze_vault_core::HostStore::finish_backup(&partial)) {
            Ok(made) => log::info!("backed up to {}", made.display()),
            Err(e) => log::error!("the daily backup failed: {e}"),
        }
        tokio::time::sleep(DAY).await;
    }
}

/// When `hostd restore` asks for a backup to be restored.
async fn restore_requested(dir: &Path) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if dir.join(RESTORE_FILE).exists() {
            return;
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
