# Glaze Vault

**Encrypted glaze and clay recipes, kept on your own computer.** A desktop app for studios and
industrial users with proprietary recipes, built on [Glazecalc](https://github.com/AaronFilson/glazecalc)'s
glaze chemistry. No account, no cloud, nothing for users to install but the app.

> Early development. A vault works for one person, or a team on one computer: recipes and their
> unity formula, your own materials, revisions, comparing, printing, backups, import and export,
> and people with roles on shared and private collections, including batch operators who weigh
> from coded batch sheets without the recipe, and recipe details, additions on top of the base,
> and search. See the [user guide](docs/user/README.md) and the
> [decision records](docs/adr/README.md) for what comes next: a firing log with photos, chemistry
> tools, a LAN host with offline laptops, signed revisions, and the first release.

| Part      | Built with                                                                         |
| --------- | ---------------------------------------------------------------------------------- |
| App       | [Tauri 2](https://tauri.app): one native binary on the system's webview             |
| Core      | Rust: SQLCipher (rusqlite), Argon2id, XChaCha20-Poly1305, HPKE (RFC 9180), BIP 39   |
| UI        | React 19, TypeScript, Vite                                                         |
| Chemistry | Glazecalc's `lib/chemistry`, copied into `vendor/glazecalc` for now ([ADR 2](docs/adr/0002-chemistry-copy.md)) |
| Tests     | Rust unit tests, Vitest, end-to-end tests that drive the development app            |

## Layout

    crates/core/        the trusted core: keys, encryption, storage (no Tauri in it)
    crates/app/         the Tauri app: commands over the core, config, icons, permissions
    ui/                 the React UI; ui/chemistry.ts wraps Glazecalc's chemistry
    vendor/glazecalc/   Glazecalc's chemistry and standard materials, copied (see SOURCE.md)
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
in a temporary folder and goes from setting it up to recovering it, through recipes, materials,
comparing, deleting, importing, exporting, backups and restoring, and changing the password and
the recovery key ([ADR 11](docs/adr/0011-end-to-end-tests.md)). Scenarios are in
`e2e/scenarios.ts`. `E2E_VERBOSE=1` prints what each command did, and how long the slow ones took.

## Scripts

    npm run dev          the app in development, with the Vite dev server on port 1420
    npm run build        installers for this system, in target/release/bundle
    npm test             UI and chemistry tests (Vitest)
    npm run e2e          end-to-end tests: the development app, driven (add -- --keep to keep its files)
    npm run typecheck    TypeScript for the UI, the Vite config and the end-to-end tests
    npm run test:core    the Rust tests (cargo test --workspace)
    npm run test:all     all of the above

`cargo fmt` and `cargo clippy --workspace --all-targets` keep the Rust tidy.

## CI and releases

Every push runs the checks above on macOS, Windows and Linux, and builds unsigned installers for
each, which are kept for two weeks as the run's artifacts. Pushing a `v*` tag builds a signed
draft release with the updater's `latest.json`. [docs/releasing.md](docs/releasing.md) covers the
updater key, Apple and Windows signing, and the release steps.

## License

[MIT](LICENSE). Glazecalc's chemistry and data in `vendor/glazecalc` are MIT too, by the same author.
