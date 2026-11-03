# 11. End-to-end tests through the development screen and driver

Proposed, 2026-10-16. A second suite, on the LAN, with two apps and a host, is in
[ADR 23](0023-client-mode.md). Changed 2026-11-03 for a third, on phones (below).

## Context

The UI tests (Vitest, jsdom) run each screen against a fake core, and the Rust tests run the core
alone. Neither shows that the two work together in a real window: the commands' names and
arguments, the file dialogs, locking and unlocking, a restore that moves the vault folder.

Tauri's way is WebDriver through `tauri-driver`, which runs on Windows and Linux but not macOS,
where the app is written, and needs a WebDriver client and a native driver for each system.
Development builds already write a text picture of the screen to a file and run scripts from
another file (`ui/devTools.ts`), for working on the app without seeing it.

## Decision

- **The tests drive the development app through those files.** `npm run e2e` (`e2e/run.ts`)
  starts `tauri dev` with a new vault in a temporary folder, writes scripts to the driver file and
  reads the screen file back. The same commands work by hand and for a coding agent, so a test is
  written by doing it once.
- **Scripts check themselves:** the driver's `expect "text"` waits for text in the screen file, or
  for it to go, and fails the script. The runner fails a scenario when a script fails or the page
  reports an error or a React warning, and prints the screen as it was.
- **File dialogs are answered ahead:** the driver's `pick` names the file the next open or save
  dialog chooses, so backups, restores, imports and exports run with no dialog shown.
- **One vault, in order:** the scenarios go from setting up a vault to recovering it, each
  starting where the one before left off, as a person's first weeks would. The run stops at the
  first failure. Starting a vault once keeps the whole run to about 30 seconds after the build.
- **CI runs them on macOS, Windows and Linux** (Linux under Xvfb), after the other checks.

## Consequences

- The tests use what only development builds have: the dev commands are compiled out of release
  builds (`#[cfg(debug_assertions)]`), so the installers themselves are not what is tested. Trying
  the installers stays a step before each release.
- The screen file is a description of the page, not a picture: layout, colours and printing are
  not checked, and a person still looks at new screens.
- A scenario that fails leaves the later ones unrun; its output says how many.
- WebKit slows the timers of a page whose window is hidden, and on macOS stops answering it after
  a few minutes with the display asleep. The dev tools wait by asking the core (`dev_wait`), whose
  answers are not slowed, and on macOS the runner keeps the display awake with `caffeinate` for
  as long as it runs. A screen locked by the person still hides the window, so run the tests on
  a Mac that is not locked.

## Phones (2026-11-03, phase 3 stage 8)

- **`npm run e2e -- --suite android` or `--suite ios`** (`e2e/phone.ts`) installs a development
  build of the app (`E2E_PHONE_APP`, an .apk or .app) on a running Android emulator or booted iOS
  simulator. It joins a `hostd` run on the same machine by the typed address and pairing code
  (the QR scan is left out), Ben signs in and sets his password, a recipe goes each way, and he
  logs a mix that reaches the host.
- **The admin is the dev client** (`crates/hostd/examples/dev-client.rs`): it makes the team
  vault, prepares the host's store, pairs and approves the phone, and saves and lists records
  through Ana's replica, so the suite needs no second app.
- **The driver by file:** a phone's app is started with no environment from the runner, so in a
  development build on a phone the screen and driver files are always `dev/screen.txt` and
  `dev/drive.txt` beside the vault folder, and secrets are shown. The runner reads and writes
  them with `adb exec-out run-as` / `adb exec-in run-as` on Android (a debug APK is debuggable)
  and straight from the simulator's data container on iOS.
- **The page's dev tools** load in a built page when it is built with `VITE_GLAZE_DEV_TOOLS=1`, as
  a phone loads the built page, not Vite's. CI builds the phone suite's apps that way, and never
  the APK it uploads.
- **CI** runs it in the Mobile jobs: an API 34 emulator through
  `reactivecircus/android-emulator-runner` on Linux, and the first available iPhone simulator on
  macOS. The emulator reaches the runner as `10.0.2.2`, the simulator as `127.0.0.1`.
