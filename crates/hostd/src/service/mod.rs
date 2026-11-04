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

/// Moves a host installed before ADR 38's service user over to it as `hostd run` starts, on macOS,
/// where it ran as root; elsewhere nothing (docs/adr/0038-hardening-hostd.md).
pub fn harden(dir: &Path, port: u16, name: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return os::harden(dir, port, name);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (dir, port, name);
        Ok(())
    }
}

/// Moves the store the app made in `from` into the system's data folder, and starts serving it
/// from boot on `port`, advertised as `name`. The copy in `from` is left for the app to remove.
pub fn install(from: &Path, port: u16, name: &str) -> Result<(), String> {
    // On Windows a store that served keeps its key under DPAPI only, as a kept one does (ADR 38).
    let key = from.join("host.key").is_file() || (cfg!(windows) && from.join("host.key.dpapi").is_file());
    for (file, there) in [
        ("host.key", key),
        ("host.json", from.join("host.json").is_file()),
        ("vault.db", from.join("vault.db").is_file()),
    ] {
        if !there {
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
    glaze_vault_core::HostStore::protect_key(&data).map_err(|e| format!("protecting the host key: {e}"))?;
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

/// Gives what an administrator wrote in the store, such as a restore, to the service's user:
/// what this process's user owns under the folder goes to whoever owns the folder itself.
pub fn own(dir: &Path) -> Result<(), String> {
    if dir == os::data_dir() && os::installed() {
        own_as_folder(dir).map_err(|e| format!("giving {} to the service: {e}", dir.display()))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn own_as_folder(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let folder = fs::metadata(dir)?;
    // SAFETY: geteuid has no preconditions.
    give(dir, unsafe { libc::geteuid() }, folder.uid(), folder.gid())
}

/// Gives `path`, and if a folder everything in it, to `uid` and `gid`, of what `from` owns. Run
/// as root over a tree the service's user can change, so it walks by open file, never following
/// a link, and leaves alone a file with more than one name: a hard link the service's user made
/// to a file elsewhere, or a folder swapped for a link meanwhile, is not given away (ADR 38).
#[cfg(unix)]
fn give(path: &Path, from: u32, uid: u32, gid: u32) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    // SAFETY: a valid C string; the result is checked.
    let fd = unsafe { libc::open(path.as_ptr(), OPEN_FLAGS) };
    give_open(fd, from, uid, gid)
}

#[cfg(unix)]
const OPEN_FLAGS: libc::c_int = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;

/// [`give`] for a file just opened (`fd`, or -1 and errno); closes it.
#[cfg(unix)]
fn give_open(fd: libc::c_int, from: u32, uid: u32, gid: u32) -> std::io::Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: fd was just opened, and is owned here alone.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    // SAFETY: a zeroed stat is valid, and fstat fills it from an open fd.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd.as_raw_fd(), &mut stat) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let kind = stat.st_mode & libc::S_IFMT;
    let is_dir = kind == libc::S_IFDIR;
    let ours = stat.st_uid == from && (is_dir || (kind == libc::S_IFREG && stat.st_nlink == 1));
    // SAFETY: an open fd.
    if ours && unsafe { libc::fchown(fd.as_raw_fd(), uid, gid) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    if !is_dir {
        return Ok(());
    }
    for name in names_in(&fd)? {
        // SAFETY: an open folder and a valid C string; the result is checked by give_open.
        let entry = unsafe { libc::openat(fd.as_raw_fd(), name.as_ptr(), OPEN_FLAGS) };
        if entry < 0 {
            // A link, or something that does not open such as a socket: not given.
            let error = std::io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::ELOOP | libc::ENXIO | libc::EOPNOTSUPP | libc::ENOENT) => continue,
                _ => return Err(error),
            }
        }
        give_open(entry, from, uid, gid)?;
    }
    Ok(())
}

/// The names in an open folder, but `.` and `..`.
#[cfg(unix)]
fn names_in(dir: &std::os::fd::OwnedFd) -> std::io::Result<Vec<std::ffi::CString>> {
    use std::os::fd::AsRawFd;
    // SAFETY: dup of an open fd; fdopendir takes the copy, and closedir closes it.
    let copy = unsafe { libc::dup(dir.as_raw_fd()) };
    if copy < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let stream = unsafe { libc::fdopendir(copy) };
    if stream.is_null() {
        let error = std::io::Error::last_os_error();
        unsafe { libc::close(copy) };
        return Err(error);
    }
    let mut names = Vec::new();
    loop {
        // SAFETY: an open stream; the entry is read before the next readdir.
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() != b"." && name.to_bytes() != b".." {
            names.push(name.to_owned());
        }
    }
    unsafe { libc::closedir(stream) };
    Ok(names)
}

#[cfg(windows)]
fn own_as_folder(_dir: &Path) -> std::io::Result<()> {
    // The folder's ACL is inherited by what is written in it.
    Ok(())
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
pub fn copy_private(from: &Path, to: &Path) -> std::io::Result<()> {
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn only_what_is_inside_and_ours_alone_is_given() {
        let place = tempfile::tempdir().unwrap();
        let (dir, outside) = (place.path().join("store"), place.path().join("outside"));
        fs::create_dir_all(dir.join("backups/one")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(dir.join("vault.db"), "").unwrap();
        fs::write(dir.join("backups/one/vault.db"), "").unwrap();
        fs::write(outside.join("linked"), "").unwrap();
        fs::write(outside.join("pointed"), "").unwrap();
        fs::hard_link(outside.join("linked"), dir.join("hard")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("soft")).unwrap();
        std::os::unix::fs::symlink(outside.join("pointed"), dir.join("soft-file")).unwrap();
        // To another of this user's groups, which needs no root.
        let start = fs::metadata(&dir).unwrap().gid();
        let mut groups = [0 as libc::gid_t; 64];
        // SAFETY: the buffer holds as many as it says.
        let count = unsafe { libc::getgroups(64, groups.as_mut_ptr()) };
        let Some(&other) = groups[..count.max(0) as usize].iter().find(|&&g| g != start) else {
            return;
        };
        // SAFETY: no preconditions.
        let uid = unsafe { libc::geteuid() };
        give(&dir, uid, uid, other).unwrap();
        let gid = |p: &Path| fs::symlink_metadata(p).unwrap().gid();
        assert_eq!(gid(&dir), other);
        assert_eq!(gid(&dir.join("vault.db")), other);
        assert_eq!(gid(&dir.join("backups/one/vault.db")), other);
        assert_eq!(gid(&outside.join("linked")), start, "a hard link is not given");
        assert_eq!(gid(&outside.join("pointed")), start, "a link is not followed");
        assert_eq!(gid(&outside), start);
        // What someone else owns is left as it is.
        give(&dir, uid + 1, uid, start).unwrap();
        assert_eq!(gid(&dir.join("vault.db")), other);
    }
}
