//! The installers' self-test (docs/adr/0035-installer-smoke-test.md). An installed copy started
//! with GLAZE_VAULT_SMOKE=<file> and GLAZE_VAULT_DIR=<empty folder> makes a vault there, saves a
//! recipe, locks and unlocks it, waits for its page to ask the core for the vault's state, checks
//! that hostd came with it, writes "ok" or what failed to the file, and quits. Release builds have
//! no dev driver (ADR 11), so this is how CI sees that what it installed opens and unlocks a vault.
//! It touches only the folder GLAZE_VAULT_DIR names.

use glaze_vault_core::{Kind, Vault};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// Set when the page first asks for the vault's state: the webview loaded the page and its calls
/// reach the core.
static PAGE_ASKED: AtomicBool = AtomicBool::new(false);

pub(crate) fn page_asked() {
    PAGE_ASKED.store(true, Ordering::SeqCst);
}

/// The result file, if this run is the self-test.
pub(crate) fn requested() -> Option<PathBuf> {
    std::env::var_os("GLAZE_VAULT_SMOKE").map(PathBuf::from)
}

/// Runs the self-test away from the main thread, then quits the app with its result.
pub(crate) fn start(app: AppHandle, dir: PathBuf, result: PathBuf) {
    std::thread::spawn(move || {
        let outcome = run(&dir);
        let text = match &outcome {
            Ok(()) => "ok\n".to_owned(),
            Err(e) => format!("failed: {e}\n"),
        };
        let _ = std::fs::write(&result, text);
        app.exit(if outcome.is_ok() { 0 } else { 1 });
    });
}

fn run(dir: &Path) -> Result<(), String> {
    const PASSWORD: &str = "installer smoke test";
    if std::env::var_os("GLAZE_VAULT_DIR").is_none() {
        return Err("GLAZE_VAULT_DIR must name a folder for the test vault".into());
    }
    if Vault::exists(dir) {
        return Err(format!("{} already holds a vault", dir.display()));
    }
    let (mut vault, _) = Vault::create(dir, PASSWORD).map_err(|e| format!("creating the vault: {e}"))?;
    let shared = vault
        .collections()
        .first()
        .map(|c| c.id)
        .ok_or("the new vault has no collection")?;
    vault
        .save_in(
            Kind::Recipe,
            shared,
            &serde_json::json!({ "name": "Smoke test", "lines": [], "notes": "" }),
        )
        .map_err(|e| format!("saving a recipe: {e}"))?;
    drop(vault);
    let vault = Vault::unlock(dir, PASSWORD).map_err(|e| format!("unlocking the vault: {e}"))?;
    let names: Vec<String> = vault
        .heads(Kind::Recipe)
        .map_err(|e| format!("reading recipes: {e}"))?
        .iter()
        .filter_map(|r| r.content["name"].as_str().map(str::to_owned))
        .collect();
    if names != ["Smoke test"] {
        return Err(format!("the recipe saved did not come back: {names:?}"));
    }
    drop(vault);

    let deadline = Instant::now() + Duration::from_secs(120);
    while !PAGE_ASKED.load(Ordering::SeqCst) {
        if Instant::now() > deadline {
            return Err("the page never reached the core in two minutes".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    #[cfg(desktop)]
    if crate::network::hostd().is_none() {
        return Err("hostd is not beside the app".into());
    }
    Ok(())
}
