# 38. hostd under a user of its own, its key protected, and MSI updates

Proposed, 2026-11-03. The follow-ups left from the transport and host mode
([ADR 21](0021-transport-and-pairing.md), [ADR 22](0022-host-mode.md)): hostd under a user of its
own on macOS, `host.key` under DPAPI on Windows, and MSI updates on a computer that serves. No new
schema.

## Context

hostd holds the host's key, which opens the host's store (never the recipes, ADR 20). On macOS
the LaunchDaemon ran as root. On Windows the service already runs as its own virtual account,
`NT SERVICE\GlazeVaultHost`, with ProgramData's folder closed to everyone else, but `host.key`
sat there as plain bytes, so any copy of the folder carried it. On Linux the unit already ran
with `DynamicUser=yes` and `ProtectSystem=strict`. Only the NSIS setup stopped the service while
`hostd.exe` was replaced; the MSI did not, and Windows does not replace a running program.

## Decision

- **macOS: `_glazevault`.** `hostd install` makes a hidden user and group of that name, with the
  lowest id from 300 to 499 free as both a user and a group id (by `dscl . -list`), no shell
  (`/usr/bin/false`), `/var/empty` as its home and no password. One made before is used again.
  The store is chowned to it and stays 0700 (files 0600); the log file is its, the folders above
  stay root's. The plist runs hostd with `UserName`, `GroupName` and a 077 `Umask`. The port is
  above 1024 and mDNS needs no root. `hostd uninstall` deletes the user and group; a store kept
  goes back to root, so no file is left to an id the system may give another. `hostd restore`,
  run as root, gives what it wrote to the folder's owner after.
- **Windows: DPAPI with the machine's key.** hostd moves `host.key` to `host.key.dpapi`
  (`CryptProtectData` with `CRYPTPROTECT_LOCAL_MACHINE` and a fixed entropy) at install and as
  it starts, so a host from before is migrated, and the plain file goes once the protected one
  opens again. The machine's key, not the account's: the service's virtual account and an
  administrator's elevated `hostd export` or `restore` both need to read it, and a user-scope
  blob would open only for the account that made it. The folder's ACL already keeps other users
  out; what DPAPI adds is that a copy of the folder taken off this computer (a file backup, a
  synced ProgramData) does not carry a usable key. Through `windows-sys`, already in the lock
  file. A `.gvhost` file holds the key sealed to the organization's key, not under DPAPI, so a
  host still moves (ADR 37).
- **Linux**: the unit keeps `DynamicUser=yes` and gains what is cheap and fits a network daemon:
  `UMask=0077`, private devices, the kernel, clock, hostname and control groups protected,
  `ProtectProc=invisible`, no capabilities, only IP, Unix and netlink sockets (netlink for mDNS
  to list the interfaces), no namespaces, realtime or set-id, `MemoryDenyWriteExecute`, native
  system calls and the `@system-service` filter.
- **MSI updates** (`crates/app/windows/host-service.wxs`, linked by `componentRefs` in
  `tauri.sidecar.conf.json`): deferred custom actions, elevated, whose failure is ignored, stop
  the service with PowerShell's `Stop-Service`, which waits, before `RemoveExistingProducts`, and
  start it again before `InstallFinalize`; removing the app (but not the old version an upgrade
  removes) deletes the service, as the NSIS setup does. Not WiX's `ServiceControl`: hostd makes
  the service, not the MSI, so ServiceControl's start fails an install where there is none, and
  its stop comes after the old version's files are already being removed. This relies on Tauri's
  MSI removing the old version just after `InstallInitialize`.
- **CI**: the host service job checks the service runs as `_glazevault` with the store its alone,
  as a user that is not root on Linux (and prints `systemd-analyze security`), and with only
  `host.key.dpapi` on Windows; then moves the host by `hostd export` and `dev-client unpack`
  (ADR 37), syncs again, and checks the user is gone after uninstalling. The installer self-test
  (ADR 35) on Windows installs the dev client's team store as a service with the MSI's hostd,
  installs the MSI again with every file replaced, and requires exit 0, not 3010 (a restart
  needed), and a sync after.

## Consequences

- A bug in hostd on macOS reaches only the store, not root. A copy of a Windows host's folder
  is no use elsewhere; the computer itself still opens it, so disk encryption still matters.
- The MSI test reinstalls the same version; an upgrade from an older MSI is first tried by the
  first release after this one.
- Nobody has run any of this on a real install by hand yet: CI does, on its runners.
