//! macOS: a LaunchDaemon run as root, kept alive, its store in /Library/Application Support.
//! SMAppService would need macOS 13; the app supports 12.

use super::{path_text, tool, try_tool};
use std::fs;
use std::path::{Path, PathBuf};

const LABEL: &str = "com.glazecalcapp.vault.host";
const PLIST: &str = "/Library/LaunchDaemons/com.glazecalcapp.vault.host.plist";
const LOGS: &str = "/Library/Logs/Glaze Vault";
const FIREWALL: &str = "/usr/libexec/ApplicationFirewall/socketfilterfw";

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

pub fn install(exe: &Path, data: &Path, port: u16, name: &str) -> Result<(), String> {
    let (exe, data) = (path_text(exe)?, path_text(data)?);
    fs::create_dir_all(LOGS).map_err(|e| e.to_string())?;
    let arguments = [exe, "run", data, "--port", &port.to_string(), "--name", name]
        .iter()
        .map(|a| format!("        <string>{}</string>\n", escape(a)))
        .collect::<String>();
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LABEL}</string>
    <key>ProgramArguments</key>
    <array>
{arguments}    </array>
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
    );
    fs::write(PLIST, plist).map_err(|e| format!("writing {PLIST}: {e}"))?;
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

pub fn after_uninstall(_keep_data: bool) {}

pub fn run_as_service(_args: Vec<String>) -> Result<(), String> {
    Err("launchd runs `hostd run`".into())
}
