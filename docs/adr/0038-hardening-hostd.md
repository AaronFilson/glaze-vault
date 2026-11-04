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
  run as root, gives what it wrote to the folder's owner after. Every such chown, run as root
  over a tree the service's user can change, walks by open file descriptor (`openat` with
  `O_NOFOLLOW`, then `fchown` on what was opened), changes only what the expected owner (root, or
  on uninstall the service's user) owns, and skips a file with more than one hard link, so a
  link planted in the store cannot turn it onto a file elsewhere.
  - A host installed before this ran as root from a LaunchDaemon an update leaves as it was. As
  `hostd run` starts as root for the installed store, it moves itself over: makes the user,
  gives it the store and log, writes the LaunchDaemon as `install` now does (used from the next
  boot), and gives up root for that user (`setgroups`, `setgid`, `setuid`, checked) before it
  opens the store. On Linux the old unit already ran as a dynamic user; it gains the newer
  sandboxing only when hosting is set up again (Stop serving, then serve).
- **Restoring under a running service.** `hostd restore` copies a backup folder from outside the
  store into the store's `restore-copy` (the service's user cannot read elsewhere), writes the
  request beside its name, gives it to the service's user and then renames it in place, so the
  service never finds it half written or unreadable. The service restores as it starts, removes
  the request whether or not that worked (a bad one is logged and the store serves as it was,
  rather than stopping every few seconds for it), and writes `restore-result`: `ok` or why not.
  `hostd restore` waits up to a minute for it and fails with what it says.
- **Windows: DPAPI with the machine's key.** hostd moves `host.key` to `host.key.dpapi`
  (`CryptProtectData` with `CRYPTPROTECT_LOCAL_MACHINE` and a fixed entropy) at install and as
  it starts, so a host from before is migrated, and the plain file goes once the protected one
  opens again. The machine's key, not the account's: the service's virtual account and an
  administrator's elevated `hostd export` or `restore` both need to read it, and a user-scope
  blob would open only for the account that made it. The folder's ACL already keeps other users
  out; what DPAPI adds is that a copy of the folder taken off this computer (a file backup, a
  synced ProgramData) does not carry a usable key. Through `windows-sys`, already in the lock
  file. A `.gvhost` file holds the key sealed to the organization's key, not under DPAPI, so a
  host still moves (ADR 37). `hostd install --from` takes a folder with either key file, so a
  store kept by `uninstall --keep-data` installs again.
- **Linux**: the unit keeps `DynamicUser=yes` and gains what is cheap and fits a network daemon:
  `UMask=0077`, private devices, the kernel, clock, hostname and control groups protected,
  `ProtectProc=invisible`, no capabilities, only IP, Unix and netlink sockets (netlink for mDNS
  to list the interfaces), no namespaces, realtime or set-id, `MemoryDenyWriteExecute`, native
  system calls and the `@system-service` filter.
- **MSI updates** (`crates/app/windows/host-service.wxs`, linked by `componentRefs` in
  `tauri.sidecar.conf.json`): deferred custom actions, elevated, whose failure is ignored, stop
  the service with PowerShell's `Stop-Service`, which waits, just after `RemoveExistingProducts`,
  and start it again before `InstallFinalize`; removing the app (but not the old version an
  upgrade removes) deletes the service, as the NSIS setup does. Tauri's MSI removes the old
  version just after `InstallInitialize`, and Windows Installer refuses any action that writes
  the install script before that (error 2613, every install failing with 1603), so the stop
  cannot go before it. It need not: in a major upgrade the old version's own uninstall, which
  `RemoveExistingProducts` runs, stops the service before removing `hostd.exe` (keeping the
  service, as `UPGRADINGPRODUCTCODE` is set); a repair or reinstall of the same version replaces
  files only later, at `InstallFiles`. A rollback action, before the stop, starts the service
  again if the install fails after it; in a failed major upgrade the old version's own rollback
  starts it once its files are back. Not WiX's `ServiceControl`: hostd makes the service, not
  the MSI, so ServiceControl's start fails an install where there is none. An upgrade from an
  MSI without these actions (none was released) would not stop the service first.
- **CI**: the host service job checks the service runs as `_glazevault` with the store its alone,
  as a user that is not root on Linux (and prints `systemd-analyze security`), and with only
  `host.key.dpapi` on Windows; then moves the host by `hostd export` and `dev-client unpack`
  (ADR 37), syncs again, and checks the user is gone after uninstalling. The installer self-test
  (ADR 35) on Windows installs the dev client's team store as a service with the MSI's hostd,
  then a second MSI, the same build one patch version later (ci.yml makes it, rebuilding only
  the app crate), as a major upgrade, and requires exit 0, not 3010 (a restart needed), a sync
  after, and the updated app's self-test.

## Consequences

- A bug in hostd on macOS reaches only the store, not root. A copy of a Windows host's folder
  is no use elsewhere; the computer itself still opens it, so disk encryption still matters.
- The MSI test upgrades between two builds of the same source; an upgrade from an MSI built from
  older source is first tried by the first release after this one.
- Nobody has run any of this on a real install by hand yet: CI does, on its runners.
