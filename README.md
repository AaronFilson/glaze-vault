# Glaze Vault

**Encrypted glaze and clay recipes, kept on your own devices.** An app for studios and industrial
users with proprietary recipes, built on [Glazecalc](https://github.com/AaronFilson/glazecalc)'s
glaze and clay-body chemistry. No account, no cloud, nothing to install on a computer but the app.

> Pre-release: feature-complete across solo vaults, shared studio vaults, blind LAN sync (`hostd`),
> and iOS/Android mobile builds, awaiting release signing keys and export-classification review
> ([docs/releasing.md](docs/releasing.md), [docs/follow-ups.md](docs/follow-ups.md)).
>
> Built today: glaze and clay-body chemistry (184 standard materials, 41 additives, zero-flux bodies
> and slips), your own materials with clay data sheets and side-by-side comparison, revisions and
> recipe comparison, line and triaxial blends, limit formulas, target-formula fitting and material
> selection, costing, firing logs with test-bar vitrification curves, glaze fit and signed photos,
> mix logs with material lots and slip ageing steps, roles and collections (including coded batch
> sheets for operators and chemistry-free roles), Ed25519-signed revisions and chained audit logs,
> encrypted backups (personal, LAN host, and phone), import/export, auto-lock, and printing (or PDF
> export on phones). See the [user guide](docs/user/README.md) and
> [decision records](docs/adr/README.md).

| Part      | Built with                                                                         |
| --------- | ---------------------------------------------------------------------------------- |
| App       | [Tauri 2](https://tauri.app): native desktop (macOS, Windows, Linux) and mobile (iOS, Android) |
| Core      | Rust: SQLCipher (rusqlite), Argon2id, XChaCha20-Poly1305, HPKE (RFC 9180), Ed25519, BIP 39 |
| Sync      | Rust: TLS 1.3 (`rustls`), SPAKE2 pairing, mDNS discovery, blind `hostd` LAN service |
| UI        | React 19, TypeScript, Vite                                                         |
| Chemistry | `@glazecalc/core` (`lib/core`) and `@glazecalc/catalog` (`lib/catalog`) git submodules ([ADR 2](docs/adr/0002-chemistry-copy.md)) |
| Tests     | Rust unit tests, Vitest, Node submodule tests, desktop/LAN/mobile end-to-end suites |

## Layout

    crates/core/        the trusted core: keys, encryption, access control, storage (no Tauri in it)
    crates/sync/        encrypted sync protocol, TLS pairing, mDNS discovery
    crates/hostd/       the blind LAN host daemon and system service installer
    crates/app/         the Tauri app: commands over the core, dialogs, mobile hooks, updater
    ui/                 the React UI; ui/chemistryHost.ts and ui/chemistry.ts wrap Glazecalc's chemistry
    lib/core/           @glazecalc/core git submodule: stateless glaze and clay-body chemistry
    lib/catalog/        @glazecalc/catalog git submodule: tables, English wording and standard materials
    e2e/                end-to-end test runner and scenarios (desktop, LAN and mobile)
    docs/adr/           architecture decision records
    docs/user/          the user guide
    docs/follow-ups.md  work decided on but not done yet

## Run it

You need:

| Tool                                               | Check            | Notes                                                    |
| -------------------------------------------------- | ---------------- | -------------------------------------------------------- |
| [Node.js](https://nodejs.org/) 24 with npm 11      | `node --version` | `nvm use` reads `.nvmrc`                                 |
| [Rust](https://rustup.rs/) (stable)                | `cargo --version`| `curl https://sh.rustup.rs -sSf \| sh`                   |
| macOS: Xcode Command Line Tools                    | `xcode-select -p`| `xcode-select --install`                                 |
| Windows: Microsoft C++ Build Tools and WebView2    |                  | [Tauri's prerequisites](https://tauri.app/start/prerequisites/) |
| Linux: WebKitGTK 4.1 and build tools               |                  | [Tauri's prerequisites](https://tauri.app/start/prerequisites/) |

Then:

    nvm use
    git submodule update --init
    npm install
    npm run dev          # builds the core and opens the app, with live reload of the UI

The first build compiles SQLCipher and OpenSSL from source: about 7 minutes for development and
30 for a release build on an older Intel Mac. Later builds take seconds. To keep development vaults away from the real one, point the app at another
folder:

    GLAZE_VAULT_DIR=/tmp/test-vault npm run dev

To follow and drive the app without looking at it, such as from a script or a coding agent, name
a file for a text picture of the screen, and one for scripts to run:

    GLAZE_VAULT_DIR=/tmp/test-vault GLAZE_VAULT_SCREEN=/tmp/screen.txt \
      GLAZE_VAULT_DRIVE=/tmp/drive.txt npm run dev
    printf '%s\n' 'type "Recipe name" "Shino"' 'click "Save"' > /tmp/drive.txt
    cat /tmp/screen.txt

The screen file is rewritten whenever the screen changes, with the page's errors and the last
script's results at the end. A script is taken and run once; `ui/devDriver.ts` lists its
commands. Both are only in development builds. The screen file holds what is on screen in plain
text, so use them with a throwaway vault. Passwords and recovery words are left out unless
`GLAZE_VAULT_SHOW_SECRETS=1` is set too, which a script needs to get past checking the recovery key.

The end-to-end tests work the same way: `npm run e2e` opens the development app with a new vault
in a temporary folder and drives every user workflow—setting up, glaze and clay-body recipes,
materials and clay data sheets, comparing, blends, limit formulas and target fitting, deleting,
importing, exporting, backups and restoring, passwords and recovery keys, teams, coded batch
sheets, firing logs with vitrification curves and photos, and mix logs
([ADR 11](docs/adr/0011-end-to-end-tests.md)). `npm run e2e -- --suite lan` runs two app instances
against a live `hostd` to test pairing, syncing, checkouts, offline limits and host backups.
Scenarios live under `e2e/`. `E2E_VERBOSE=1` prints what each command did, and how long the slow
ones took.

## Scripts

    npm run dev              the app in development, with the Vite dev server on port 1420
    npm run build            installers for this system, in target/release/bundle
    npm test                 UI and chemistry tests (Vitest)
    npm run test:submodules  @glazecalc/core and @glazecalc/catalog tests with coverage
    npm run e2e              end-to-end tests: desktop (or -- --suite lan | ios | android)
    npm run typecheck        TypeScript for the UI, submodules, Vite config and end-to-end tests
    npm run test:core        the Rust tests (cargo test --workspace)
    npm run test:all         unit, submodule, typecheck and Rust tests

`cargo fmt` and `cargo clippy --workspace --all-targets` keep the Rust tidy.

Every test starts clean, so tests can run side by side. After each UI test, `ui/testSetup.ts`
unmounts what it rendered and clears the fake Rust commands, local storage, fake clocks and
stubs. Tests of plain functions share workers. Each screen's test file gets its own page, so a
long one is better split by what it covers: the Recipes screen's tests are split across focused
files that share `ui/screens/recipesTestKit.tsx`. Each Rust test makes its vaults in temporary
folders. Under `cargo test`, new passwords use the lightest Argon2id settings, and the dependencies
that encrypt and store data are built optimized, as they are for `tauri dev`.

## CI and releases

Every push runs the checks and end-to-end suites above on macOS, Windows and Linux, installs and
exercises `hostd` as a real system service on all three, builds and tests the mobile apps on an
Android emulator and iOS simulator, and builds + smoke-tests unsigned desktop installers, which
are kept for two weeks as run artifacts. Pushing a `v*` tag builds a signed draft release with the
updater's `latest.json`. [docs/releasing.md](docs/releasing.md) covers the updater key, Apple and
Windows signing, and the release steps.

## License

[MIT](LICENSE). `@glazecalc/core` (`lib/core`) and `@glazecalc/catalog` (`lib/catalog`) are MIT too,
by the same author; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for third-party notices in
the catalog.
