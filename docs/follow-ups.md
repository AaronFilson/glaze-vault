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

## Teams ([ADR 12](adr/0012-teams-on-one-computer.md)), in this order

- Sign each revision with its author's key ([ADR 4](adr/0004-roles-and-collections.md)), so changes
  made outside the app show.
- The audit log: who viewed, printed, exported or changed what.
- Going back to one person ([ADR 6](adr/0006-one-person-first.md)).
- The batch operator role, with materials named by in-house codes.
- Taking admin away from someone without removing them: needs a new organization key.
- Roles that admins can change, and moving a recipe to another collection.

## Engineering

- Nobody has installed the app on Windows or Linux yet: the end-to-end tests run the development
  app there in CI, but the installers from a CI run's artifacts are untried. The first real
  release also tests the updater end to end.
- Stream backups instead of holding the database in memory, before vaults hold attachments.
- End-to-end tests of a release build ([ADR 11](adr/0011-end-to-end-tests.md) tests the
  development app): before the first release, a check that each installer opens and unlocks a
  vault.
