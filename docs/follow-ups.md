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
- **Code signing:** an Apple Developer ID (notarization) and Azure Trusted Signing for Windows,
  before builds go to anyone else.
- **iOS builds** need a newer Xcode than macOS 12 runs: a macOS CI runner or a newer Mac, by
  phase 3.

## Next for one person ([ADR 6](adr/0006-one-person-first.md))

- Printing a recipe with its analysis, and a batch sheet for a chosen batch size.
- Export as CSV and JSON, and encrypted backups that can be restored.
- Lock the vault after a while with nobody using it.
- Settings: change the password (the core has it), make a new recovery key.
- Custom materials, colorants and additives; a recipe's earlier revisions.

## Engineering

- Installer builds in CI with `tauri-action`. CI (`.github/workflows/ci.yml`) type-checks,
  builds the UI and runs Vitest, clippy and the Rust tests on macOS, Windows and Linux, but
  nobody has run the app on Windows or Linux yet.
- The updater ([ADR 1](adr/0001-tauri-rust-react.md)): signing key, `latest.json` on GitHub
  Releases.
- End-to-end tests. `tauri-driver` (WebDriver) runs on Windows and Linux but not macOS, so they
  would run in CI on those two.
- Sign each revision with its author's key ([ADR 4](adr/0004-roles-and-collections.md)), before
  there is more than one author.
