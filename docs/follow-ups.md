# Follow-ups

Work decided on but not done yet, with the reason it waits.

## Waiting on something

- **Replace the chemistry copy with a git submodule** ([ADR 2](adr/0002-chemistry-copy.md)).
  Waits for Glazecalc's chemistry to settle. Then: `git rm -r vendor/glazecalc`,
  `git submodule add https://github.com/AaronFilson/glazecalc.git vendor/glazecalc`, check out a
  tag, make CI check submodules out and run Glazecalc's chemistry tests, and remove
  `vendor/glazecalc/SOURCE.md`. Glazecalc's own `package.json` has no `"type"`, so the
  `vendor/glazecalc/package.json` added here (`"type": "commonjs"`) goes away with no change
  needed. Later still: an npm package, after user acceptance testing.
- **Export classification** ([ADR 3](adr/0003-encryption-and-keys.md)): confirm with export
  counsel before the first customer release.
- **Signing** ([docs/releasing.md](releasing.md)): generate the updater key and put its public
  half in `tauri.conf.json` (needed before the first release, or installed copies cannot
  update); an Apple Developer ID with notarization and Azure Artifact Signing for Windows, before
  builds go to anyone else.
- **iOS builds** need a newer Xcode than macOS 12 runs: a macOS CI runner or a newer Mac, by
  phase 3.

## Next for one person ([ADR 6](adr/0006-one-person-first.md))

- More import formats ([ADR 10](adr/0010-importing.md)): Digitalfire's material XML (MDT) once a
  real file is at hand to check against, and Glazy's YAML dumps.

## Teams ([ADR 12](adr/0012-teams-on-one-computer.md))

- Phase 2, the LAN host and replicas: [the plan](plans/phase-2-lan-host.md), with every default in
  its section 8 accepted. Stages 1 to 3 are built: key epochs, the change log, tombstones and
  forks ([ADR 17](adr/0017-key-epochs-change-log.md)); the directory as events and shared access
  checks ([ADR 18](adr/0018-directory-events.md)); and signed revisions, key certificates and the
  audit log ([ADR 19](adr/0019-signatures-and-audit-log.md)); and the sync core, a blind host and
  replicas tested without a network ([ADR 20](adr/0020-sync-core.md)); and the transport, pairing
  and `hostd` in the foreground ([ADR 21](adr/0021-transport-and-pairing.md)); and host mode in the
  app ([ADR 22](adr/0022-host-mode.md)); and client mode: joining, the background sync, checkouts
  and photos in pieces ([ADR 23](adr/0023-client-mode.md)); and offline limits, revoking computers
  and the host's backups ([ADR 24](adr/0024-offline-limits-and-revocation.md)). Phase 2 is built.
- Left after stage 8 ([ADR 25](adr/0025-host-backups-from-the-app.md) built the rest): the LAN
  update mirror (ADR 5, after stage 8 in the plan), which needs signed updates first; making someone an
  admin or taking it away from a computer without their key file entry (from the host computer
  for now).
- From the review of 2026-10-29, the rest fixed since: changes to people, roles and collections
  (`network::with_host` in the app) still hold the vault while they wait on the host, since they
  hold the directory there and sync the change at once; other network commands no longer do.
- Left from the transport and host mode (the host key is certified since
  [ADR 34](adr/0034-certified-host-keys.md), and hostd hardened and MSI updates handled since
  [ADR 38](adr/0038-hardening-hostd.md)): trying the Windows service and updates on a real
  install, and an MSI upgrade from an older version; `SMAppService` once macOS 12 support is
  dropped; a new host key when a host moves ([ADR 37](adr/0037-moving-the-host.md) carries the
  old one), which needs computers to take a new certified pin and the old key retired.
- Left from the sync core: the host keeping and signing the audit log (the computers' logs stay
  on them for now); a new organization recovery sheet or key reaching every computer's key file.

## Clay bodies

The ranked list at the end of
[clay body formulation](research/clay-body-formulation.md#12-what-this-means-for-glaze-vault)
is built, and so are the mix log's export and its printed record.

## Engineering

- Nobody has installed the app on Windows or Linux by hand yet: CI installs each installer and
  runs its self-test (ADR 35), but no one has used an installed copy there. The first real
  release also tests the updater end to end.
- Each installer is installed and opens and unlocks a vault on CI
  ([ADR 35](adr/0035-installer-smoke-test.md)); the rpm is not tried, and nothing tests a signed
  installer or the updater yet.
