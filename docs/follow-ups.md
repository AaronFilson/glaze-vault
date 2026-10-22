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
  and `hostd` in the foreground ([ADR 21](adr/0021-transport-and-pairing.md)). Stage 6, host mode
  in the app, is next.
- Left from the transport: the organization certifying the host key at conversion (stage 6); the
  offline secret from pairing (stage 8).
- Left from the sync core, for the stages that need them: the host keeping and signing the audit
  log (the computers' logs stay on them for now); a new organization recovery sheet or key reaching
  every computer's key file; resetting someone, or making or taking an admin, from a computer that
  does not have their key file entry (stage 6, from the host computer); directory changes on a
  replica waiting for the host (stage 7, the plan's question 5), since one the host refuses leaves
  the replica apart; listing a record's newest revisions by the host's order; and the host
  checking that what a revision supersedes is its record's.
- The audit log notes opening recipes, materials, batch sheets and firings; mixes, limit sets and
  price lists could be noted too. Signatures of attachments are kept but not shown anywhere yet.
- Before replicas (stage 7): the fork notice in the firing log, mix log, batch sheets, limit sets
  and price lists, which show a forked record's newest for now; and a user guide page on forks.

## Clay bodies

The ranked list at the end of
[clay body formulation](research/clay-body-formulation.md#12-what-this-means-for-glaze-vault)
is built. Small things left from the mix log ([ADR 16](adr/0016-mix-log.md)):

- Mixes in the CSV export, as the firing log has.
- A printed mix record for the shop floor: the batch sheet with blank rows for the slip's steps.

## Engineering

- Nobody has installed the app on Windows or Linux yet: the end-to-end tests run the development
  app there in CI, but the installers from a CI run's artifacts are untried. The first real
  release also tests the updater end to end.
- End-to-end tests of a release build ([ADR 11](adr/0011-end-to-end-tests.md) tests the
  development app): before the first release, a check that each installer opens and unlocks a
  vault.
