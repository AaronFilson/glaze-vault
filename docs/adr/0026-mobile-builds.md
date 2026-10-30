# 26. Mobile builds: the same app for phones and tablets

The mobile projects are still made by `tauri init`, and changed after it: see [ADR 27](0027-phones.md).

Proposed, 2026-10-30. Stage 1 of [the phase 3 plan](../plans/phase-3-mobile.md#7-staged-delivery).
Builds on [ADR 1](0001-tauri-rust-react.md)'s "Tauri 2 can build the same app for iOS and
Android", and undoes the desktop-only library of the lean-build change.

## Context

Phase 3 puts Glaze Vault on phones and tablets, as a vault of its own or a replica of a LAN host,
never as a host. Before any screen work, the existing Rust and React have to build for iOS and
Android, and what a phone cannot do has to stay out of those builds. Until now the app crate
built only an `rlib`, the updater and file dialogs were compiled in everywhere, hosting assumed
`osascript`, `pkexec` or PowerShell, and discovery used `mdns-sd`'s own multicast sockets, which
iOS allows only with an entitlement Apple grants on request.

The dev Mac runs macOS 12, with no Xcode and no Android SDK, and too little disk for the NDK.
iOS builds need a newer Xcode than macOS 12 runs anyway.

## Decision

- **Crate types**: `crates/app` builds `staticlib`, `cdylib` and `rlib` again. The Tauri CLI links
  the static library into the iOS app and loads the shared one on Android; `run()` is the mobile
  entry point (`#[cfg_attr(mobile, tauri::mobile_entry_point)]`). Cargo has no crate types per
  target, so desktop builds make the two extra libraries too, at some cost in disk and link time.
- **Desktop only**, by Tauri's `desktop` and `mobile` cfgs in the app, and by `target_os` in
  `crates/sync`:
  - The updater: `tauri-plugin-updater` is a dependency for desktops only. On phones,
    `check_for_update` and `install_update` answer that the app store updates the app, and
    `vault_status` says updates are not configured, so the page shows what it shows for a build
    without an updater key.
  - Hosting: no `hostd` on a phone, so `can_host` is false and starting or stopping hosting says
    so. Running something as an administrator does not exist there.
  - A file dialog's parent window: phones have none. The dialogs themselves stay; what they give
    back on a phone is the next point.
  - mDNS: `mdns-sd` is a dependency for desktops only. On phones `browse` finds nothing, and a
    phone is paired by address until stage 4 browses with the system's own service.
- **The mobile projects** (`crates/app/gen/android`, `gen/apple`) are made by `tauri android init`
  and `tauri ios init` on CI each time, not checked in, while nothing in them differs from Tauri's
  own. Stage 2 checks them in when it changes them (the `Info.plist` keys, backup rules,
  `FLAG_SECURE`), and `.gitignore` then ignores only `gen/schemas`.
- **SQLCipher** keeps `bundled-sqlcipher-vendored-openssl` on every target, OpenSSL built from
  source. The fallback, if a target will not build, is SQLCipher with CommonCrypto on Apple
  platforms and features per target in `crates/core/Cargo.toml`.
- **CI** (`mobile` in `.github/workflows/ci.yml`): `core` and `sync` built for
  `aarch64-linux-android`, `aarch64-apple-ios` and `aarch64-apple-ios-sim`, so a dependency that
  stops building for phones fails on the push that adds it; then an unsigned Android APK
  (`aarch64` and `x86_64`, the second for the emulator later) kept as a build artifact, and an iOS
  app for the simulator. Nothing is signed (the plan's stage 9).

## Consequences

- Every mobile build is checked on CI only, until there is a newer Mac and disk for the Android
  tools. A failure there cannot be tried locally.
- Files picked on a phone are not always paths: Android gives `content://` addresses, which the
  dialog helpers (`open_dialog`, `save_dialog`) turn into an "A file could not be read" error.
  Choosing a photo, a backup or an import works on desktops only until stage 6 (photos) and
  stage 7 (files out and in) read and write through the system instead. HEIC photos from a phone
  also need converting before the page can shrink them (ui/photos.ts); stage 6.
- A phone's computer name comes from `hostname`, which phones lack, so joining offers "A computer"
  until stage 4 asks the system for the device's name.
- Desktop behaviour is unchanged.
