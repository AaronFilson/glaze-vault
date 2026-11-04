# 35. Each installer opens and unlocks a vault on CI

Proposed, 2026-11-03. The follow-up "end-to-end tests of a release build" in
docs/follow-ups.md, on [ADR 11](0011-end-to-end-tests.md), whose suites drive the development
app only.

## Context

CI builds unsigned installers for macOS (a disk image), Windows (NSIS setup and MSI) and Linux
(deb, rpm and AppImage), and nobody had installed one. A release build has no dev screen or
driver: they are compiled out, and adding them back would test something other than what ships.
What can go wrong only in an installed copy is mostly about packaging: SQLCipher and OpenSSL
linked into the release binary, the built page bundled and loading in the system webview, and the
hostd sidecar put beside the app.

## Decision

- **A self-test in the app itself.** Started with `GLAZE_VAULT_SMOKE=<file>` and
  `GLAZE_VAULT_DIR=<empty folder>`, the app (`crates/app/src/smoke.rs`) makes a vault in that
  folder, saves a recipe, locks it, unlocks it and reads the recipe back; waits for its page's
  first `vault_status` call, which shows the bundled page loaded and reaches the core; checks that
  hostd is beside it; then writes `ok` or what failed to the file and quits with 0 or 1. It runs
  in release builds too. It needs both variables, refuses a folder that already holds a vault,
  and touches nothing else.
- **CI installs each installer and runs the installed copy** (`.github/smoke-installer.cjs`,
  after "Build installers"): the disk image is mounted and its app copied out; the NSIS setup
  runs with `/S` and the MSI with `msiexec /qn`; the deb is installed with apt and the AppImage
  run as it is, both under Xvfb. The rpm is left out: the runner has no rpm-based system.

## Consequences

- A broken bundle (a missing sidecar, a page that does not load, a database that does not open)
  fails the push that made it, before anyone downloads it.
- The page is not driven: setup, unlock and the screens are the development suites' job. The
  self-test shows only that the page loads and reaches the core.
- The installers are unsigned, so this says nothing about Gatekeeper, SmartScreen or the updater;
  those wait for signing (docs/releasing.md).
- Anyone can run the self-test on an installed copy by hand to check it.
