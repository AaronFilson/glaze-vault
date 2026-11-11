# Releasing and signing

How a version of Glaze Vault gets from a tag to installed copies, and the three kinds of signing
involved. Only the first is needed for updates to work; the other two stop the operating system
warning people about an unknown developer.

| Signing                    | What it proves                                   | Needed for               | Cost           |
| -------------------------- | ------------------------------------------------ | ------------------------ | -------------- |
| Updater key (Tauri)        | An update came from us, unchanged                | Self-updating, required  | Free           |
| Apple Developer ID         | macOS: who made the app; notarized by Apple      | No Gatekeeper warning    | US$99 a year   |
| Azure Artifact Signing     | Windows: who made the installer                  | Fewer SmartScreen warnings | US$9.99 a month |

Linux packages are not signed; that is normal for AppImage, deb and rpm downloads
([Tauri](https://v2.tauri.app/distribute/sign/linux/)).

## Where the keys live

Every signing secret lives in GitHub, as a secret of the repository's **`release` environment**,
not as a plain repository secret. The environment only runs for `v*` tags, and each release
waits for Aaron to approve it under the run's **Review deployments**. So a branch, a pull request
or a changed workflow cannot read the keys, and nothing is signed without that click. A ruleset
lets only repository admins create, move or delete `v*` tags.

Set this up once, from the repository folder, with `gh` logged in as Aaron:

```sh
bash scripts/release/github-setup.sh
```

Secrets then go in with `scripts/release/set-secrets.sh`, which reads them from the key files and
from hidden prompts, so they never pass through the clipboard or shell history. `bash
scripts/release/set-secrets.sh list` shows which are set.

GitHub keeps secrets write-only: nobody, Aaron included, can read one back. GitHub is where CI
uses the keys, not their backup. Keep each key file and password offline too (an encrypted USB
drive and the password manager); a lost updater key means every installed copy is reinstalled
by hand.

| Secret or variable (environment `release`) | From | Set with |
| ------------------------------------------ | ---- | -------- |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `npx tauri signer generate` | `set-secrets.sh updater` |
| `APPLE_CERTIFICATE` and five more `APPLE_*` | Apple Developer Program | `set-secrets.sh apple certificate.p12` |
| `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`; variables `AZURE_SIGNING_*` | Azure Artifact Signing | `set-secrets.sh azure` |

Phone store keys (an Android upload keystore, an App Store Connect API key) will join the same
environment at phase 3's store release.

## 1. The updater key (do this first)

Installed copies only accept an update signed with this key. The public half goes into the app;
the private half signs each release in CI.

1. Generate the key on your Mac, with a password you keep in your password manager:

   ```sh
   npx tauri signer generate -w ~/.tauri/glaze-vault.key
   ```

   This writes the private key to `~/.tauri/glaze-vault.key` and the public key to
   `~/.tauri/glaze-vault.key.pub`.

2. Put the public key into the app. Copy the contents of `~/.tauri/glaze-vault.key.pub` (one long
   line) into `plugins.updater.pubkey` in `crates/app/tauri.conf.json`, and commit it. The public
   key is not a secret. Until it is there, builds leave the updater out and Settings says so.

3. Give CI the private key: `bash scripts/release/set-secrets.sh updater`. It puts the contents of
   `~/.tauri/glaze-vault.key` into `TAURI_SIGNING_PRIVATE_KEY` and asks for the password, which
   becomes `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, both in the `release` environment. It also prints
   the public key for step 2.

4. Keep a copy of the key file and its password somewhere safe and offline, such as an encrypted
   USB drive. **If the key or its password is lost, installed copies can never update again:** a
   new key means everyone reinstalls by hand.

The app checks `https://github.com/AaronFilson/glaze-vault/releases/latest/download/latest.json`.
It also requires the version inside the signature to match the version announced, so an old
release cannot be passed off as a new one (`requireSignedVersion`).

## 2. macOS: Apple Developer ID and notarization

Without it, macOS refuses to open the app until the person goes to **System Settings → Privacy &
Security** and chooses **Open Anyway** (Control-click → Open no longer works since macOS 15).

1. Join the [Apple Developer Program](https://developer.apple.com/programs/enroll/) as an
   individual: US$99 a year, with an Apple Account that has two-factor authentication, and your
   legal name.
2. Make a **Developer ID Application** certificate
   ([Apple](https://developer.apple.com/help/account/certificates/create-developer-id-certificates)):
   in Keychain Access choose **Certificate Assistant → Request a Certificate From a Certificate
   Authority**, save the request, upload it on the developer site, download the `.cer` and
   double-click it.
3. Export it for CI: in Keychain Access, under **My Certificates**, expand the certificate,
   right-click its private key, choose **Export**, and save a `.p12` with a password. Then:

   ```sh
   openssl base64 -A -in certificate.p12 -out certificate-base64.txt
   ```

4. Make an app-specific password for notarization at [account.apple.com](https://account.apple.com)
   (**Sign-In and Security → App-Specific Passwords**).
5. Run `bash scripts/release/set-secrets.sh apple certificate.p12`. It base64-encodes the `.p12`
   itself (so step 3's `openssl` line is only needed by hand) and asks for the rest. These are
   the `release` environment's secrets it sets:

   | Secret                       | Value                                                          |
   | ---------------------------- | -------------------------------------------------------------- |
   | `APPLE_CERTIFICATE`          | The contents of `certificate-base64.txt`                       |
   | `APPLE_CERTIFICATE_PASSWORD` | The `.p12` password                                            |
   | `APPLE_SIGNING_IDENTITY`     | `Developer ID Application: Your Name (TEAMID)`, as in Keychain |
   | `APPLE_ID`                   | Your Apple Account email                                       |
   | `APPLE_PASSWORD`             | The app-specific password                                      |
   | `APPLE_TEAM_ID`              | The 10-character team ID from the developer site               |

   Then delete `certificate.p12` and `certificate-base64.txt` from your Mac's disk.

The release workflow signs and notarizes when `APPLE_CERTIFICATE` is set, and fails if it is set
but any of the others is missing. Without it, the macOS build is unsigned and the workflow says so.

## 3. Windows: Azure Artifact Signing

Without signing, Windows shows **Windows protected your PC**, and the person has to choose **More
info → Run anyway**; Smart App Control on Windows 11 may block the installer outright. Signed
installers still show a milder warning until enough people have installed them. That
reputation takes weeks to build, and EV certificates no longer skip it
([Microsoft](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).

Azure Artifact Signing (formerly Trusted Signing) is the simplest choice for an individual in the
US or Canada: Basic is US$9.99 a month, and the keys live in Microsoft's HSMs, so there is no USB
token. A certificate from a certificate authority also works, but since June 2023 its key must be
on a hardware token or a cloud HSM, which is awkward in CI.

1. Make an Azure account with a paid subscription and an **Individual** billing account whose
   name and address match your photo ID
   ([quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)).
2. Create an Artifact Signing account, then an **identity validation** (Individual). It is checked
   with your government photo ID through Microsoft Authenticator.
3. Create a **Public Trust** certificate profile.
4. Create an app registration (service principal) with a client secret, and give it the
   **Artifact Signing Certificate Profile Signer** role on the signing account.
5. Run `bash scripts/release/set-secrets.sh azure`. It sets the secrets `AZURE_CLIENT_ID`,
   `AZURE_CLIENT_SECRET` and `AZURE_TENANT_ID`, and these **variables** (not secrets), all in the
   `release` environment:
   - `AZURE_SIGNING_ENDPOINT`: the account's endpoint, such as
     `https://eus.codesigning.azure.net`.
   - `AZURE_SIGNING_ACCOUNT`: the signing account's name.
   - `AZURE_SIGNING_PROFILE`: the certificate profile's name.

When `AZURE_CLIENT_ID` is set, the release workflow installs `artifact-signing-cli` and signs the
app and both installers with it (`bundle.windows.signCommand`,
[Tauri](https://v2.tauri.app/distribute/sign/windows/)).

## Making a release

1. Set the new version in `package.json` (`npm version --no-git-tag-version 0.2.0`) and in
   `Cargo.toml`'s `[workspace.package]`, then run `cargo check` so `Cargo.lock` follows. Commit.
2. Tag and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. Approve the run: open it under **Actions** and choose **Review deployments → release →
   Approve**. Until then the build jobs wait and cannot see any key. Before that, the workflow
   has checked that the tag, `package.json` and `Cargo.toml` agree and that the updater's public
   key is in the app; each build job then checks its private key is set. It then builds on macOS (one universal app for Intel and Apple silicon),
   Windows and Linux into a **draft** GitHub Release, with `latest.json` for the updater.
4. Try the draft's installers. Nothing reaches installed copies yet: the updater reads the latest
   *published* release.
5. Write the release notes into the draft and publish it. Installed copies that check for updates
   then offer it. The notes are shown in Settings.

If a release is bad, publish a fixed one with a higher version. Do not delete the bad release
without publishing another: copies that installed it would then be told about an older version,
which they refuse.

### What gets built

| System  | Files                          | An installed copy updates with           |
| ------- | ------------------------------ | ---------------------------------------- |
| macOS   | `.dmg` (universal)             | the signed `.app.tar.gz`                 |
| Windows | `-setup.exe` (NSIS) and `.msi` | the same kind of installer it came from  |
| Linux   | `.AppImage`, `.deb`, `.rpm`    | the same kind of package it came from    |

The `-setup.exe` installs for the current user, so its updates need no administrator: suggest it
to most people. The `.msi` installs for the whole computer, so its updates ask for an
administrator; it suits IT departments, which often turn update checks off in Settings and
deploy new versions themselves. On Linux, updating a `.deb` or `.rpm` install asks for the
computer's password; an AppImage updates in place.

Every push also builds unsigned installers for each system in CI (the **Installers** jobs). Find
them under the run's **Artifacts**, for trying on a computer before a release.
