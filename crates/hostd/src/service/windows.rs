//! Windows: a service run by its own virtual account, NT SERVICE\GlazeVaultHost, its store in
//! ProgramData closed to everyone else, and a firewall rule for the program on private networks.

use super::{path_text, tool, try_tool};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

const SERVICE: &str = "GlazeVaultHost";
const ACCOUNT: &str = r"NT SERVICE\GlazeVaultHost";
const RULE: &str = "name=Glaze Vault host";

pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("ProgramData").unwrap_or_else(|| OsString::from(r"C:\ProgramData"));
    PathBuf::from(base).join("Glaze Vault").join("host")
}

pub fn installed() -> bool {
    try_tool("sc.exe", &["query", SERVICE])
}

pub fn running() -> bool {
    std::process::Command::new("sc.exe")
        .args(["query", SERVICE])
        .output()
        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains("RUNNING"))
}

pub fn install(exe: &Path, data: &Path, port: u16, name: &str) -> Result<(), String> {
    let (exe, data) = (path_text(exe)?, path_text(data)?);
    let command = format!("\"{exe}\" service \"{data}\" --port {port} --name \"{name}\"");
    tool(
        "sc.exe",
        &[
            "create",
            SERVICE,
            "binPath=",
            &command,
            "start=",
            "auto",
            "obj=",
            ACCOUNT,
            "DisplayName=",
            "Glaze Vault host",
        ],
    )?;
    try_tool(
        "sc.exe",
        &[
            "description",
            SERVICE,
            "Serves a Glaze Vault to computers on this network.",
        ],
    );
    try_tool(
        "sc.exe",
        &["failure", SERVICE, "reset=", "86400", "actions=", "restart/5000"],
    );
    tool(
        "icacls",
        &[
            data,
            "/inheritance:r",
            "/grant:r",
            "SYSTEM:(OI)(CI)F",
            "/grant:r",
            "Administrators:(OI)(CI)F",
            "/grant:r",
            &format!("{ACCOUNT}:(OI)(CI)M"),
        ],
    )?;
    tool(
        "netsh",
        &[
            "advfirewall",
            "firewall",
            "add",
            "rule",
            RULE,
            "dir=in",
            "action=allow",
            &format!("program={exe}"),
            "enable=yes",
            "profile=private,domain",
        ],
    )?;
    tool("sc.exe", &["start", SERVICE])
}

pub fn uninstall(_exe: &Path) -> Result<(), String> {
    try_tool("sc.exe", &["stop", SERVICE]);
    // The service takes a moment to stop and let go of its files.
    for _ in 0..20 {
        if !running() {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    try_tool("sc.exe", &["delete", SERVICE]);
    try_tool("netsh", &["advfirewall", "firewall", "delete", "rule", RULE]);
    Ok(())
}

pub fn after_uninstall(_keep_data: bool) {}

define_windows_service!(ffi_service_main, service_main);

/// What the service control manager starts: `hostd service <dir> [run's options]`.
pub fn run_as_service(_args: Vec<String>) -> Result<(), String> {
    service_dispatcher::start(SERVICE, ffi_service_main).map_err(|e| e.to_string())
}

fn service_main(_arguments: Vec<OsString>) {
    // The arguments from binPath, not those the manager passes to service_main.
    let mut args = std::env::args().skip(2);
    let Some(dir) = args.next().map(PathBuf::from) else {
        return;
    };
    crate::log_to::file(&dir.join("hostd.log"));
    if let Err(e) = serve_as_service(dir, args) {
        log::error!("{e}");
    }
}

fn serve_as_service(dir: PathBuf, args: impl Iterator<Item = String>) -> Result<(), String> {
    let options = crate::run_options(dir, args)?;
    let (stop, stopped) = mpsc::channel::<()>();
    let handler = service_control_handler::register(SERVICE, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = stop.send(());
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })
    .map_err(|e| e.to_string())?;
    let status = |state, accept| ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: accept,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::from_secs(5),
        process_id: None,
    };
    handler
        .set_service_status(status(
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        ))
        .map_err(|e| e.to_string())?;
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let served = runtime.block_on(crate::serve::serve(options, async move {
        let _ = tokio::task::spawn_blocking(move || stopped.recv()).await;
    }));
    let _ = handler.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty()));
    served
}
