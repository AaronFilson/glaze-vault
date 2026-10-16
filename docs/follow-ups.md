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

- Bring back a vault set aside by a restore from inside the app; today the user guide explains
  moving its files.
- Importing materials and recipes from a JSON export, or a supplier's CSV.

## Engineering

- Nobody has run the app on Windows or Linux yet: try the installers from a CI run's
  artifacts. The first real release also tests the updater end to end.
- Stream backups instead of holding the database in memory, before vaults hold attachments.
- End-to-end tests. `tauri-driver` (WebDriver) runs on Windows and Linux but not macOS, so they
  would run in CI on those two.
- Sign each revision with its author's key ([ADR 4](adr/0004-roles-and-collections.md)), before
  there is more than one author.
