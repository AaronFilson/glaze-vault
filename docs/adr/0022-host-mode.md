# 22. Host mode: hostd as a service, and the host computer's app as its first replica

Proposed, 2026-10-21. Stage 6 of [the LAN host plan](../plans/phase-2-lan-host.md#7-staged-delivery),
its sections 2.3 and 2.5, on [ADR 20](0020-sync-core.md)'s blind host and [ADR 21](0021-transport-and-pairing.md)'s
transport. Notes [ADR 6](0006-one-person-first.md)'s "go back to one person", which needs the
host stopped first. Adds `crates/sync` and `crates/hostd` to [ADR 1](0001-tauri-rust-react.md)'s
crates.

## Context

Stage 5 left a host that developers run by hand. A team needs one an admin starts from the app:
running from boot with nobody signed in, surviving the app being closed, updated with the app,
and stopped again, on macOS 12 and later, Windows and Linux.

## Decision

- **Serving** (Settings, Network, for an admin of a team's vault): the app makes the host's store
  (`Vault::convert_to_host`, which is `prepare_host` and more), and asks the system for an
  administrator to run `hostd install --from <staging> --port <port> --name <name>`. That moves the
  store into the system's data folder, writes the service, adds the firewall rule and starts it.
  The staging copy is removed. If installing fails, the vault is left as it was.
- **The host computer's app is the host's first computer**, a replica over loopback
  (`127.0.0.1:<port>`), as the plan recommends: one code path, and hostd the only writer of the
  host's store. `convert_to_host` certifies a computer key for everyone in the vault, who all sign
  in there today, keeps the host key it pins and everyone's key file entries, and marks every
  change as the host's, under the same number, so it has nothing to push. Its first sync pulls
  what it has already, and skips it.
- **Stopping** is the other way round from the plan's: the app syncs a last time, has the system
  run `hostd uninstall`, which removes the service, its firewall rule and the host's store, and the
  app's own replica becomes a vault on one computer again (`stop_syncing`). It holds everything,
  since an admin's computer gets every scope. The plan moved the host's store back into the app's
  folder instead, which needs the host store's database key sealed to admins, and hostd's files,
  which only an administrator can read. What other computers saved and never synced is lost, as
  the plan says, and the screen says so. If the last sync fails, the admin can stop anyway.
- **Services**, written by hand:

  | | Runs as | Store | Service | Firewall |
  | --- | --- | --- | --- | --- |
  | macOS | root (a hidden `_glazevault` user is left for later) | `/Library/Application Support/Glaze Vault/host`, 0700 | LaunchDaemon `com.glazecalcapp.vault.host`, `KeepAlive`, `launchctl bootstrap system`; log in `/Library/Logs/Glaze Vault` | the application firewall's `socketfilterfw --add`, `--unblockapp`, if it is on |
  | Windows | the virtual account `NT SERVICE\GlazeVaultHost` | `%ProgramData%\Glaze Vault\host`, its ACL closed to all but SYSTEM, Administrators and the account; log beside the store | `sc.exe create`, automatic start, restart on failure; `hostd service` runs under the service manager (`windows-service`) | `netsh advfirewall`, private and domain networks |
  | Linux | systemd's `DynamicUser` | `StateDirectory=glaze-vault` (`/var/lib/private/glaze-vault/host`) | `/etc/systemd/system/glaze-vault-host.service`, `Restart=always`, `ProtectSystem=strict`, `ProtectHome` | none: firewalls differ; the guide says to open the port |

  `host.key` is protected by the folder's permissions on every system: no DPAPI on Windows yet.
  The setup screen advises disk encryption rather than checking for it.
- **Elevation**: `osascript … with administrator privileges` on macOS (SMAppService needs macOS
  13), `pkexec` on Linux, and PowerShell's `Start-Process -Verb RunAs` (a UAC prompt) on Windows.
- **The sidecar**: hostd is built for the installers by `.github/sidecar.cjs`, named with its
  target triple, both Macs joined by `lipo` for the universal build, and bundled by
  `crates/app/tauri.sidecar.conf.json` (`bundle.externalBin`), which CI and the release add with
  `--config`. Tauri checks that a sidecar exists when the app is built, so ordinary builds and
  `tauri dev` leave it out, and find hostd beside the app (`target/debug/hostd`) or at
  `GLAZE_VAULT_HOSTD`.
- **Updates**: on macOS and Linux, hostd stops when its own file changes, and launchd or systemd
  starts the new one. Windows locks a running program, so the NSIS installer's hooks
  (`crates/app/windows/hooks.nsh`) stop the service before replacing hostd.exe and start it after;
  uninstalling the app removes the service and leaves the store. The updater installs with NSIS.
  The MSI has no such hooks: an MSI update on a computer that serves fails to replace hostd.exe.
  Hosting on Linux needs the .deb or .rpm; an AppImage is refused, as it has no fixed path.
- **Pairing in the app**: an admin's computer asks for a code, shows it, waits for a computer to
  use it, shows that computer's name and key fingerprint, and approves it for the people ticked.
  The computers paired are listed (`ListDevices`, for admins). The other computer's side, joining,
  is stage 7; until then, `dev-client pair` does it.
- **Syncing**: a replica's app syncs every 30 seconds while unlocked, and on "Sync now", from the
  page. Stage 7 moves this into a background task in the app.
- **Development**: `GLAZE_VAULT_HOST_NO_SERVICE=1` runs hostd as the app's child, serving the
  staging folder, with no administrator. `hostd run --port 0 --port-file` tells it the port.
- **CI**: a "Host service" job on each system builds hostd and the dev client, makes a team vault
  and its host's store, joins a computer, installs hostd as a real service with sudo (an elevated
  shell on Windows), syncs over TLS, and uninstalls it. The test-kdf check covers hostd too.

## Consequences

- An admin can serve the vault from one computer, pair others, and stop. Other computers join
  from the app in stage 7.
- The organization does not yet certify the host key at conversion; computers trust it from
  pairing (ADR 21).
- Revoking a computer, and a computer that reconnects after the host stopped, are stage 8.
- Going back to one person, on a vault that serves, needs it stopped first.
- The Windows service, the NSIS hooks and the macOS daemon have run only in CI, not on a
  computer in use; the updater replacing a running sidecar has not been tried on a real install.
- No schema change.
