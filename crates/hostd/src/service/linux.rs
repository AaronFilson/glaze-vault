//! Linux: a systemd unit with a user of its own made at each start (DynamicUser), its store in
//! the unit's state folder. Hosting needs the .deb or .rpm: an AppImage has no fixed path.

use super::{path_text, tool, try_tool};
use std::fs;
use std::path::{Path, PathBuf};

const UNIT: &str = "glaze-vault-host.service";
const UNIT_FILE: &str = "/etc/systemd/system/glaze-vault-host.service";
/// Where a DynamicUser unit's StateDirectory really is; /var/lib/glaze-vault links to it.
const PRIVATE: &str = "/var/lib/private/glaze-vault";

pub fn data_dir() -> PathBuf {
    Path::new(PRIVATE).join("host")
}

pub fn installed() -> bool {
    Path::new(UNIT_FILE).exists()
}

pub fn running() -> bool {
    try_tool("systemctl", &["is-active", "--quiet", UNIT])
}

pub fn install(exe: &Path, _data: &Path, port: u16, name: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let exe = path_text(exe)?;
    if exe.contains("/tmp/.mount_") {
        return Err("an AppImage cannot host: install the .deb or .rpm".into());
    }
    // systemd wants /var/lib/private closed to others, and gives the files to the unit's user.
    fs::set_permissions("/var/lib/private", fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let quoted = |text: &str| {
        format!(
            "\"{}\"",
            text.replace('\\', "\\\\").replace('"', "\\\"").replace('%', "%%")
        )
    };
    let unit = format!(
        "[Unit]
Description=Glaze Vault host
After=network-online.target
Wants=network-online.target

[Service]
ExecStart={} run /var/lib/glaze-vault/host --port {port} --name {}
DynamicUser=yes
StateDirectory=glaze-vault
StateDirectoryMode=0700
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
",
        quoted(exe),
        quoted(name)
    );
    fs::write(UNIT_FILE, unit).map_err(|e| format!("writing {UNIT_FILE}: {e}"))?;
    tool("systemctl", &["daemon-reload"])?;
    tool("systemctl", &["enable", "--now", UNIT])
}

pub fn uninstall(_exe: &Path) -> Result<(), String> {
    try_tool("systemctl", &["disable", "--now", UNIT]);
    if Path::new(UNIT_FILE).exists() {
        fs::remove_file(UNIT_FILE).map_err(|e| format!("removing {UNIT_FILE}: {e}"))?;
    }
    try_tool("systemctl", &["daemon-reload"]);
    Ok(())
}

pub fn after_uninstall(keep_data: bool) {
    if !keep_data {
        let _ = fs::remove_dir_all(PRIVATE);
        let _ = fs::remove_file("/var/lib/glaze-vault");
    }
}

pub fn run_as_service(_args: Vec<String>) -> Result<(), String> {
    Err("systemd runs `hostd run`".into())
}
