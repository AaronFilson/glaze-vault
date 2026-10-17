# 11. End-to-end tests through the development screen and driver

Proposed, 2026-10-16.

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
