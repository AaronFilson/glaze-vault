# 1. A Tauri desktop app: Rust core, React and TypeScript UI

Proposed, 2026-10-14.

## Context

Glaze Vault keeps an industrial user's proprietary glaze and clay recipes. It installs as an
ordinary application on macOS, Windows and Linux, and the people using it must never install or
look after a runtime, a database or anything else. It updates itself. Later it serves other
machines on the same LAN (phase 2) and runs on phones and tablets (phase 3).

The glaze chemistry already exists, tested, as JavaScript in Glazecalc (ADR 2). The project is
also a way to learn an in-demand stack beyond Glazecalc's Angular and Node.

## Decision

- **Tauri 2** for the application: one native binary that uses the system's webview, with
  installers for each platform (`.dmg`, `.msi` and NSIS `.exe`, `.deb`, `.rpm`, `.AppImage`).
- **Rust** for everything that must be trusted: storage, encryption, access checks, sync and the
  LAN server. It is a Cargo workspace:
  - `crates/core`: the data model, SQLCipher storage, keys, roles and the sync protocol. It has no
    Tauri in it.
  - `crates/app`: the Tauri application, a thin layer of commands over `core`.
  - `crates/hostd`: a headless service that runs `core` as a LAN host (ADR 5).
- **React 19, TypeScript and Vite** for the UI, with TanStack Router and Query. The UI shows
  only what the core gives it, and makes no access decisions (ADR 4).
- **Updates** through Tauri's updater: a manifest and builds signed with an Ed25519 key, published
  as GitHub Releases. They are separate from the operating system's code signing (Apple Developer
  ID with notarization, and Azure Trusted Signing for Windows).
- **CI** with GitHub Actions: a build on macOS, Windows and Linux runners through `tauri-action`.

## Alternatives

- **Electron and React:** reuses everything with the most mature tooling, but each install
  carries Chromium and Node (150 MB and more), Node in the app widens the attack surface, and
  there is no path to mobile.
- **Go and Wails:** a good language, but no mobile, and a smaller ecosystem for the encryption
  and sync work.
- **Python (PySide6 or Briefcase):** bundling an interpreter makes large installs that antivirus
  software flags, the update story is weak, and the chemistry would have to be ported.
- **Flutter, .NET MAUI or Avalonia:** the chemistry would have to be ported, and MAUI has no Linux.

## Consequences

- The installs are small, and Tauri 2 can build the same app for iOS and Android.
- Rust is new to the project, and the core is where most of the risk is.
- Python has no natural place in the shipped app now that the server runs inside it (ADR 5). It
  can still do the tooling: importing a customer's recipe spreadsheets and test or load scripts.
- macOS 12 can build and run the desktop app. iOS store builds need a newer Xcode than macOS 12
  runs, so phase 3 needs a macOS CI runner or a newer Mac.
