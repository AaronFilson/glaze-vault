//! macOS: a LaunchDaemon kept alive, run as a hidden user of its own, `_glazevault`, made here
//! with no shell and no home (docs/adr/0038-hardening-hostd.md), its store in /Library/Application
//! Support, closed to everyone else. SMAppService would need macOS 13; the app supports 12.

use super::{path_text, tool, try_tool};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const LABEL: &str = "com.glazecalcapp.vault.host";
const PLIST: &str = "/Library/LaunchDaemons/com.glazecalcapp.vault.host.plist";
const LOGS: &str = "/Library/Logs/Glaze Vault";
const FIREWALL: &str = "/usr/libexec/ApplicationFirewall/socketfilterfw";
/// The service's user and group, by the system's convention for daemons: a leading underscore.
pub const USER: &str = "_glazevault";
/// Where a free id for it is looked for: below 500, which the system hides from logins, and
/// above the ids macOS itself hands out.
const IDS: std::ops::Range<u32> = 300..500;

pub fn data_dir() -> PathBuf {
    PathBuf::from("/Library/Application Support/Glaze Vault/host")
}

pub fn installed() -> bool {
    Path::new(PLIST).exists()
}

pub fn running() -> bool {
    try_tool("launchctl", &["print", &format!("system/{LABEL}")])
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The numbers already in use for `attribute` among the directory's `kind` (Users or Groups).
fn ids_in_use(kind: &str, attribute: &str) -> Result<Vec<u32>, String> {
    let output = Command::new("dscl")
        .args([".", "-list", &format!("/{kind}"), attribute])
        .output()
        .map_err(|e| format!("dscl: {e}"))?;
    if !output.status.success() {
        return Err(format!("dscl could not list {kind}"));
    }
    Ok(parse_ids(&String::from_utf8_lossy(&output.stdout)))
}

/// The ids in `dscl -list`'s lines of a name and a number.
fn parse_ids(listed: &str) -> Vec<u32> {
    listed
        .lines()
        .filter_map(|line| line.split_whitespace().last()?.parse().ok())
        .collect()
}

/// The lowest id in [`IDS`] neither in `users` nor in `groups`, so the user and its group share it.
fn free_id(users: &[u32], groups: &[u32]) -> Option<u32> {
    IDS.clone().find(|id| !users.contains(id) && !groups.contains(id))
}

/// The id of `USER`, if it exists.
fn user_id() -> Option<u32> {
    let output = Command::new("dscl")
        .args([".", "-read", &format!("/Users/{USER}"), "UniqueID"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_ids(&String::from_utf8_lossy(&output.stdout)).first().copied()
}

/// Makes `USER` and its group, unless they are there from before.
fn make_user() -> Result<u32, String> {
    if let Some(id) = user_id() {
        return Ok(id);
    }
    let id = free_id(
        &ids_in_use("Users", "UniqueID")?,
        &ids_in_use("Groups", "PrimaryGroupID")?,
    )
    .ok_or("no free user id below 500 for the service's user")?;
    let id_text = id.to_string();
    let group = format!("/Groups/{USER}");
    let user = format!("/Users/{USER}");
    for (path, attribute, value) in [
        (&group, "PrimaryGroupID", id_text.as_str()),
        (&group, "RealName", "Glaze Vault host"),
        (&group, "Password", "*"),
        (&user, "UniqueID", id_text.as_str()),
        (&user, "PrimaryGroupID", id_text.as_str()),
        (&user, "RealName", "Glaze Vault host"),
        (&user, "UserShell", "/usr/bin/false"),
        (&user, "NFSHomeDirectory", "/var/empty"),
        (&user, "Password", "*"),
        (&user, "IsHidden", "1"),
    ] {
        tool("dscl", &[".", "-create", path, attribute, value])?;
    }
    Ok(id)
}

fn remove_user() {
    try_tool("dscl", &[".", "-delete", &format!("/Users/{USER}")]);
    try_tool("dscl", &[".", "-delete", &format!("/Groups/{USER}")]);
}

fn plist(exe: &str, data: &str, port: u16, name: &str) -> String {
    let arguments = [exe, "run", data, "--port", &port.to_string(), "--name", name]
        .iter()
        .map(|a| format!("        <string>{}</string>\n", escape(a)))
        .collect::<String>();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LABEL}</string>
    <key>ProgramArguments</key>
    <array>
{arguments}    </array>
    <key>UserName</key>
    <string>{USER}</string>
    <key>GroupName</key>
    <string>{USER}</string>
    <key>Umask</key>
    <integer>63</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardErrorPath</key>
    <string>{LOGS}/hostd.log</string>
</dict>
</plist>
"#
    )
}

pub fn install(exe: &Path, data: &Path, port: u16, name: &str) -> Result<(), String> {
    let (exe, data_text) = (path_text(exe)?, path_text(data)?);
    let id = make_user()?;
    // The store and the log are the user's alone; the folders above stay root's.
    super::chown_all(data, id, id).map_err(|e| format!("giving the store to {USER}: {e}"))?;
    fs::create_dir_all(LOGS).map_err(|e| e.to_string())?;
    let log = Path::new(LOGS).join("hostd.log");
    if !log.exists() {
        fs::write(&log, "").map_err(|e| e.to_string())?;
    }
    super::chown_all(&log, id, id).map_err(|e| e.to_string())?;
    fs::write(PLIST, plist(exe, data_text, port, name)).map_err(|e| format!("writing {PLIST}: {e}"))?;
    // Lets the program take connections when the application firewall is on; nothing when off.
    try_tool(FIREWALL, &["--add", exe]);
    try_tool(FIREWALL, &["--unblockapp", exe]);
    tool("launchctl", &["bootstrap", "system", PLIST])
}

pub fn uninstall(exe: &Path) -> Result<(), String> {
    try_tool("launchctl", &["bootout", &format!("system/{LABEL}")]);
    if Path::new(PLIST).exists() {
        fs::remove_file(PLIST).map_err(|e| format!("removing {PLIST}: {e}"))?;
    }
    if let Ok(exe) = path_text(exe) {
        try_tool(FIREWALL, &["--remove", exe]);
    }
    Ok(())
}

/// The user goes; a store kept goes back to root, so no file is left to an id the system may give
/// someone else.
pub fn after_uninstall(keep_data: bool) {
    let data = data_dir();
    if keep_data && data.exists() {
        let _ = super::chown_all(&data, 0, 0);
    }
    let _ = super::chown_all(&Path::new(LOGS).join("hostd.log"), 0, 0);
    remove_user();
}

pub fn run_as_service(_args: Vec<String>) -> Result<(), String> {
    Err("launchd runs `hostd run`".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_service_user_gets_an_id_free_for_both_user_and_group() {
        let users = parse_ids("_www   70\nroot 0\n_glazevault_old 300\nnobody -2\n");
        assert_eq!(users, vec![70, 0, 300]);
        assert_eq!(free_id(&users, &[301, 302]), Some(303));
        let all: Vec<u32> = IDS.collect();
        assert_eq!(free_id(&all, &[]), None);
    }

    #[test]
    fn the_daemon_runs_as_its_user_with_a_closed_umask() {
        let plist = plist(
            "/Applications/Glaze Vault.app/Contents/MacOS/hostd",
            "/d",
            47917,
            "A & B",
        );
        assert!(plist.contains("<key>UserName</key>\n    <string>_glazevault</string>"));
        assert!(plist.contains("<key>GroupName</key>\n    <string>_glazevault</string>"));
        assert!(plist.contains("<integer>63</integer>"));
        assert!(plist.contains("<string>A &amp; B</string>"));
    }
}
