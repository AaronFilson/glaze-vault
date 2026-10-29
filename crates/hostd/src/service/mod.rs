//! Installing hostd as a system service, per OS (plan section 2.5). The service files are written
//! here by hand, short enough to read, and run this same binary, from wherever the app installed
//! it. Each `install` and `uninstall` needs an administrator: the app asks the system for one.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as os;
#[cfg(target_os = "macos")]
use macos as os;
#[cfg(windows)]
use windows as os;

pub use os::run_as_service;

/// Moves the store the app made in `from` into the system's data folder, and starts serving it
/// from boot on `port`, advertised as `name`. The copy in `from` is left for the app to remove.
pub fn install(from: &Path, port: u16, name: &str) -> Result<(), String> {
    for file in ["host.key", "host.json", "vault.db"] {
        if !from.join(file).is_file() {
            return Err(format!("{} has no {file}: it is not a host's store", from.display()));
        }
    }
    if os::installed() {
        return Err("a Glaze Vault host is installed here already: uninstall it first".into());
    }
    let data = os::data_dir();
    if data.exists() {
        return Err(format!("{} exists already", data.display()));
    }
    copy_private(from, &data).map_err(|e| format!("copying the store: {e}"))?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    os::install(&exe, &data, port, name)
}

/// Stops the service and removes it, its firewall rule, and, unless `keep_data`, the store.
pub fn uninstall(keep_data: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    os::uninstall(&exe)?;
    let data = os::data_dir();
    if !keep_data && data.exists() {
        fs::remove_dir_all(&data).map_err(|e| format!("removing {}: {e}", data.display()))?;
    }
    os::after_uninstall(keep_data);
    Ok(())
}

/// Where the installed service keeps the host's store.
pub fn data_dir() -> PathBuf {
    os::data_dir()
}

/// Whether the service is installed and running, to restart itself for a restore.
pub fn running() -> bool {
    os::installed() && os::running()
}

pub fn status() -> Result<String, String> {
    Ok(match (os::installed(), os::running()) {
        (false, _) => "not installed".to_owned(),
        (true, false) => format!("installed, not running ({})", os::data_dir().display()),
        (true, true) => format!("running ({})", os::data_dir().display()),
    })
}

/// Copies a folder's files into a new folder only its owner can read.
fn copy_private(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    restrict(to, true)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            let target = to.join(entry.file_name());
            fs::copy(entry.path(), &target)?;
            restrict(&target, false)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn restrict(path: &Path, dir: bool) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(if dir { 0o700 } else { 0o600 }))
}

#[cfg(windows)]
fn restrict(_path: &Path, _dir: bool) -> std::io::Result<()> {
    // The folder's ACL, set once the service's account exists (windows.rs).
    Ok(())
}

/// Runs a system tool, failing with what it said.
fn tool(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{program}: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{program} {} failed: {}{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim(),
            String::from_utf8_lossy(&output.stdout).trim()
        ))
    }
}

/// Runs a system tool, whether or not it works: for steps that may have nothing to undo.
fn try_tool(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .output()
        .is_ok_and(|o| o.status.success())
}

#[allow(dead_code)]
fn path_text(path: &Path) -> Result<&str, String> {
    path.to_str().ok_or_else(|| {
        format!(
            "{} is not a path the service can be given",
            PathBuf::from(path).display()
        )
    })
}
