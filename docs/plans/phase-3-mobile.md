# Phase 3: phones and tablets

Draft for review, 2026-10-29. Nothing here is built yet. It is based on the code at `4d545c1`
(schema 13, protocol as left by stage 8 of [the LAN host plan](phase-2-lan-host.md)) and ADRs 1
to 25, so its new ADRs start at 26. Where it is not sure what Tauri, a crate or a platform does,
it says so, and the first stage exists to find out.

Decisions for Aaron are in [section 8](#8-open-questions-for-aaron), each with a recommended
default. On 2026-10-30 Aaron accepted every default, with backups on and three kept. Stage 1 is built
([ADR 26](../adr/0026-mobile-builds.md)).

## Summary

- **A phone holds a vault of its own, or is a replica; it is never a host.** Some people have
  only a phone, so it has to be a whole vault for one person (ADR 6), set up, used and backed up
  on the phone. Its backups are `.gvbackup` files (ADR 7) that the phone's own backup (iCloud,
  Google) carries off the phone, so a lost phone is not a lost vault.
- **As a replica**, a phone joins a LAN host the way a laptop does ([ADR 23](../adr/0023-client-mode.md)), with the people an admin names when
  pairing, the offline rules of [ADR 24](../adr/0024-offline-limits-and-revocation.md), and
  revocation when it is lost. ADR 5 already says "Phase 3 mobile is another client of the same
  protocol". Nothing in the core or `hostd` has to change for either.
- **One app, the same code.** Tauri 2 builds the existing Rust and React for iOS and Android
  ([ADR 1](../adr/0001-tauri-rust-react.md)). The work is in the edges: what a phone cannot do
  (host, update itself, open a file dialog, print from the webview), what it does differently
  (pairing by QR code, local network permission, being suspended in the background) and what it
  does better (a camera on the shop floor).
- **Built for the shop floor, not for running the vault.** A phone reads recipes and batch sheets,
  logs mixes and firings, and takes photos of test tiles. Running the team, hosting, importing,
  backups and the audit log stay on a computer, and the phone says so.
- **Pairing by QR code.** The admin's "Pair a computer" screen shows a QR code with the host's
  address, its key fingerprint and the pairing code. The phone scans it. That avoids typing, and
  avoids mDNS on iOS, which needs an entitlement from Apple.
- **App stores are last, and wait for Aaron.** Every stage before the last builds and tests on CI
  (Android emulator, iOS simulator) with no developer accounts. Signing, store listings and the
  export questions come at the end, like the desktop release work in docs/releasing.md.
- Delivery is 8 stages, plus the store release.

---

## 1. Gap analysis

### 1.1 What already fits

- **The core and sync crates are plain Rust** with no system dependencies beyond SQLCipher.
  `rusqlite` uses `bundled-sqlcipher-vendored-openssl`, so OpenSSL is built from source for each
  target; that should cross-compile to `aarch64-apple-ios` and the Android targets, but it is the
  likeliest thing to break (section 7, stage 1).
- **Client mode is a background thread with its own runtime** (`crates/app/src/syncing.rs`), which
  syncs only while unlocked. That matches how phones behave: an app in the background is
  suspended, and syncing while open is all ADR 23 asks for.
- **Photos on demand** ([ADR 25](../adr/0025-host-backups-from-the-app.md)) already exist. A phone
  should default to them.
- **The offline rules and revocation** (ADR 24) are what a lost phone needs: an admin revokes it as
  lost, its people's keys are reset, and the collections it could read get new key epochs.
- **The window already goes down to 420 px** (`minWidth` in `tauri.conf.json`), and
  `ui/styles.css` has breakpoints at 520 and 900 px. A phone at 375–430 px is close, not there.
- **The protocol has a version**, and a host refuses a computer that speaks another
  (`crates/sync/src/proto.rs`). Good for safety; a problem for store review lag (section 3.5).

### 1.2 What does not fit

- **Crate types.** `crates/app/Cargo.toml` builds `rlib` only, with a note that mobile needs
  `staticlib` and `cdylib` back. `main.rs` needs the `mobile_entry_point` split that Tauri's
  mobile template uses.
- **Desktop-only code compiled in unconditionally:**
  - Hosting in `crates/app/src/network.rs`: `hostd` beside the app, elevation, services, the
    sidecar. A phone never hosts, so this goes behind `#[cfg(desktop)]`, leaving the client half.
  - The updater (`tauri-plugin-updater`) is desktop only. Stores update the app.
  - File dialogs in `crates/app/src/lib.rs` (`blocking_pick_file`, `blocking_save_file`). The
    dialog plugin's mobile support is partial; saving a file on iOS in particular is not the
    desktop model. Exports go out through the share sheet instead (section 2.5).
  - `window.print()` in `Recipes.tsx`, `MixLog.tsx`, `Blend.tsx` and `RecoverySheet.tsx`. In a
    WKWebView it does nothing, as far as I know; Android's WebView also has no print by default.
- **mDNS.** `crates/sync/src/net/discover.rs` uses `mdns-sd`, which opens multicast sockets
  itself. On iOS 14 and later that needs the `com.apple.developer.networking.multicast`
  entitlement, which Apple grants on request, plus `NSLocalNetworkUsageDescription` and
  `NSBonjourServices` (`_glazevault._tcp`) in `Info.plist`. On Android, receiving multicast needs
  a `WifiManager.MulticastLock`. Hence the QR code (section 4).
- **The local network permission (iOS).** The first connection to a LAN address shows a system
  prompt. If the person says no, every connection fails with an error that does not say why. The
  join screen has to explain before it asks, and spot the refusal after.
- **Being suspended.** iOS suspends an app seconds after it leaves the screen, and may end it.
  The idle lock (`ui/useIdleLock.ts`) counts minutes of no use; a phone needs to lock when it goes
  to the background (or after a short grace), so an unlocked vault does not sit in a suspended
  app. A sync in flight when suspended is cut; the next one starts over, which the protocol
  already allows.
- **The app switcher snapshot.** Both systems keep a picture of the last screen. A recipe would
  show there. iOS needs a cover view put up on `willResignActive`; Android needs `FLAG_SECURE`
  (which also blocks screenshots, see question 6).
- **System backups.** For someone with only a phone, iCloud backup and Android Auto Backup are
  the backup they already have, and the one that survives losing the phone. But copying the live
  vault folder is wrong in two ways: SQLite in WAL mode can be copied mid-write, and a replica
  restored onto a new phone would be a copy of a device key the admin never paired. So the live
  folder is excluded, and a separate backups folder, holding finished `.gvbackup` files, is
  included (section 2.6). Android Auto Backup keeps at most 25 MB per app, which photos pass
  quickly, so Android also needs a backup the person sends somewhere (2.6).
- **Argon2id at 64 MiB and 3 passes** (`crates/core/src/crypto.rs`). Unlocking reads the stored
  parameters, so phones can unlock what desktops made. Speed on an older phone is unmeasured;
  likely around a second. Measured in stage 2; the parameters do not change unless it is much
  worse.
- **Touch.** Hover-only hints, small targets, wide tables (batch sheets, the analysis panel,
  the vitrification chart) and keyboard shortcuts.
- **The dev drivers.** `GLAZE_VAULT_SCREEN` and `GLAZE_VAULT_DRIVE` are environment variables
  read by a desktop process. An emulator needs another way in (section 6).

---

## 2. Architecture

### 2.1 Crates and targets

No new crate. `crates/app` gains:

- `[lib] crate-type = ["staticlib", "cdylib", "rlib"]` and a `lib.rs` `run()` marked
  `#[cfg_attr(mobile, tauri::mobile_entry_point)]`.
- `#[cfg(desktop)]` around hosting, the updater, the dialog commands and the `hostd` sidecar
  config. The page asks a `platform` command what it may show rather than guessing from the
  user agent.
- `crates/app/gen/apple` and `crates/app/gen/android` from `tauri ios init` and
  `tauri android init`, checked in, with the changes in 1.2 (`Info.plist` keys, the manifest's
  permissions, backup exclusion rules, `FLAG_SECURE`).
- A small `mobile` module for what needs native code: the snapshot cover, excluding the folder
  from backups, and the share sheet if no plugin covers it. Tauri 2 mobile plugins (Swift and
  Kotlin) are the way to write these; kept as small as possible.

`hostd` and `crates/sync`'s `discover.rs` are not built for mobile (`browse` behind a cfg or a
feature, since it is the only part a client uses).

### 2.2 Where the vault lives

`app_local_data_dir()/vault`, as on desktop. On iOS that is inside the app's container under
`Library`, with `NSFileProtectionComplete` (unreadable while the phone is locked); on Android,
the app's private storage. Excluded from system backups (1.2); the backups folder beside it
(2.6) is not.

### 2.3 Locking

The vault locks when the app goes to the background, after a grace period (default 30 seconds,
for checking a message and coming back). The page hears a `lock` event as it does from the idle
lock. Unlock is the person's password; biometric unlock is question 3.

### 2.4 What a phone shows

| Screen | Phone | Notes |
| --- | --- | --- |
| Recipes (read, revisions, analysis) | yes | One column; the analysis panel below the recipe. |
| Recipe editor | yes | Usable, not the focus. |
| Batch sheets, prices | yes | Scaled batch for the shop floor. |
| Mix log | yes | The main reason to have it. |
| Firing log, photos | yes | With the camera. |
| Materials, data sheets | read only | |
| Blends, fit, limits | read | Charts scroll sideways. |
| Import, backups, restore | own vault only | Import through the file picker; backups as in 2.6. |
| Team, roles, audit log | own vault only | A replica's admin work is done on a computer. |
| Network hosting | no | A phone never hosts. |
| Join, unlock, offline notice, leave | yes | |

Roles still decide what a person may do (ADR 4); this table only decides what the phone offers.

### 2.5 Getting things out

- **CSV** (mix log, firing log, audit): written to a temporary file and handed to the system share
  sheet, so it can go to Files, mail or a printer app.
- **Printing** (recipe, mix record, blend, recovery sheet): the page renders to PDF on the Rust
  side, or through the native print controller (`UIPrintInteractionController`,
  Android `PrintManager`) given the webview. Stage 7 picks one after trying both. The recovery
  sheet matters most on a phone that is the only copy; it is also offered as a PDF to save.

### 2.6 A phone's own vault, and its backups

- **Setup on a phone** offers both "Start a vault" (ADR 6's one-person vault, with its recovery
  sheet) and "Join a vault on this network". A phone's vault can grow into a team on the phone
  (ADR 12), but cannot host; to share it on a LAN, it moves to a computer by a backup restored
  there (ADR 7), and the phone then joins as a replica.
- **Automatic backups.** A phone's own vault writes a `.gvbackup` (ADR 7's format, under the
  person's password) into `backups/` beside the vault each day it is changed, keeping the newest
  three. Writing a backup reads through SQLite, so the file is always whole; the system backup
  copies finished files only.
- **iCloud**: the `backups/` folder is in the app's container and included in the device backup,
  with no size limit beyond the person's iCloud storage. Restoring a phone brings the folder back,
  and the app offers "Restore from a backup on this phone" at setup.
- **Android**: Auto Backup rules include `backups/` and exclude the vault. When the newest backup
  is over 25 MB, Auto Backup would drop the app's whole backup, so the rules then hold only a
  backup without photos, and the app asks the person to also save a full one through the system
  file picker (Storage Access Framework), e.g. to Google Drive, and reminds them as ADR 7 does.
- **The setting.** "Back up with this phone's backup" is on by default for a phone's own vault, and
  can be turned off by someone who does not want even ciphertext in a cloud. What it means is said
  plainly on screen: the file is encrypted under the password, so its safety in the cloud is the
  password's strength (Argon2id, ADR 3), and the recovery key still opens it.
- **A replica** never writes these: the host backs up (phase 2 question 12).

---

## 3. Joining and syncing from a phone

### 3.1 Pairing by QR code

"Pair a computer" on the host (and on any admin's computer that pairs) also shows a QR code of a
`glazevault:` URI holding the host's addresses and port, its key fingerprint and the SPAKE2 code.
The phone scans it with `tauri-plugin-barcode-scanner` (official, mobile only). The fingerprint
in the code is checked against the key the host shows over TLS, so a QR code also stops a wrong
host on the same network, which the typed flow leaves to the person comparing fingerprints. The
rest is ADR 23's join, unchanged: the phone makes its key, the admin sees its fingerprint and
names its people.

Typing an address and code stays, for a phone whose camera is refused.

### 3.2 Discovery

None on phones at first: the QR code carries the address. A host whose address changes (DHCP)
would leave a phone unable to find it; desktops have mDNS for that. Options, in stage 4: ask the
admin to give the host a fixed address (written up in docs/user), or browse with the system's own
service (`NWBrowser` on iOS, which needs only the Bonjour key, not the multicast entitlement;
`NsdManager` on Android). Recommend the system browsers, behind the same `browse` signature.

### 3.3 When it syncs

While the app is on screen and unlocked, as ADR 23. No background sync: iOS gives an app about
30 seconds when it leaves the screen, which is used to finish a push in flight, and Background
App Refresh would need the device key without the person's password (question 6 of phase 2 said
no to that).

### 3.4 Photos

Photos on demand by default on a phone (ADR 25), so a phone with years of test tiles does not fill
up. Photos taken on the phone are sent with the next push, in ADR 23's 1 MiB pieces.

### 3.5 Versions between the store and the host

Store review means a phone may run a newer or older app than the host for days. A host that
refuses every phone after it updates (or every phone after the phone updates) is a bad week.
Proposal: the hello carries the lowest and highest protocol versions each side speaks; a host
keeps speaking the previous version for one release after a change. This is a protocol change,
the only one in this phase, and lands in stage 4 so desktops get it too.

---

## 4. The camera and photos

- The firing log's "Add photo" gets a "Take photo" on phones. `<input type="file"
  accept="image/*" capture="environment">` should work in both webviews (Tauri's Android webview
  implements the file chooser; to be confirmed in stage 1), with no plugin.
- **HEIC.** iPhones shoot HEIC. Desktop webviews on Windows and Linux cannot show it. Safari
  hands an `<input>` a JPEG unless told it may take HEIC, which is what we want; if not, convert
  on the Rust side before saving. Either way the stored photo is JPEG.
- **Size.** A phone photo is 3–12 MB. Scale to a long edge of 2,560 px and JPEG quality 85 before
  saving (default; question 5). Keeps sync fast and the host's disk small.
- **Location and metadata.** EXIF carries the place the photo was taken. Strip it, keeping the
  orientation and time.

---

## 5. Screens on a phone

- One column under 600 px; the navigation becomes a bottom bar of four: Recipes, Mix log,
  Firing log, More.
- Targets of at least 44 px; nothing that only shows on hover.
- Tables (batch sheet, analysis, prices) scroll sideways inside their own box, the first column
  fixed, never the page.
- The keyboard: number fields use `inputmode="decimal"`, and the page moves the field above the
  keyboard.
- Dark mode as now.

The page decides by width, not by platform, so the same rules help a desktop window made narrow.
What is hidden on a phone (2.4) is decided by platform.

---

## 6. Testing

### 6.1 Rust

Unchanged, plus cross-compiling `core` and `sync` for `aarch64-apple-ios-sim` and
`aarch64-linux-android` on CI (`cargo build`, not the app), so a dependency that stops building
for mobile fails on the push that adds it. The protocol version range (3.5) gets tests in
`crates/sync`.

### 6.2 The page

The Vitest suites run at a phone width too, for the screens in 2.4, and check that hidden screens
are hidden when `platform` says mobile.

### 6.3 End-to-end

ADR 11's suite drives a desktop webview. For mobile, a smoke suite: an Android emulator on the
Linux runner (`reactivecircus/android-emulator-runner`) and an iOS simulator on the macOS runner,
each joining a `hostd` run in the foreground on the runner, syncing a recipe both ways, and
logging a mix. The dev driver reads its commands from a file in the app's folder (pushed with
`adb push` or `xcrun simctl`) instead of environment variables. The QR scan is skipped in tests by
the typed path.

### 6.4 By hand

The dev Mac runs macOS 12, which builds Android and runs the emulator but cannot build for
current iOS (docs/follow-ups.md). iOS by hand needs a newer Mac or a device and TestFlight, once
there is an account.

---

## 7. Staged delivery

Sizes as in the phase 2 plan: S under 500 lines changed, M 500 to 1,500, L 1,500 to 3,000.

| # | Stage | Contents | Useful on its own | Size |
| --- | --- | --- | --- | --- |
| 1 | **Mobile builds** | Crate types and the mobile entry point, `#[cfg(desktop)]` on hosting, updater and dialogs; `tauri android init` and `tauri ios init`; SQLCipher with vendored OpenSSL on all mobile targets (or the fallback, below); CI jobs that build an Android APK and an iOS simulator app, and cross-compile `core` and `sync`. Checks the file input and the camera in both webviews. ADR 26. **Built**: the mobile projects are made by `tauri init` on CI rather than checked in, until stage 2 changes them; mobile builds are checked on CI only; picked files on Android are `content://` addresses, left to stages 6 and 7. | Proves the stack before any screen work. | M |
| 2 | **The vault on a phone** | Folder, file protection, backup exclusion, the snapshot cover and `FLAG_SECURE`, locking in the background, the `platform` command, Argon2 timing on a real or emulated phone. ADR 27. **Built**: the platform is a field of `vault_status`, not a command; the mobile projects stay made by `tauri init`, changed after it by `crates/app/mobile/patch.cjs`; Argon2 measured on the dev Mac only, phones left to stage 8. | The security edges, done first. | M |
| 3 | **A vault of its own** | Setup on a phone, daily `.gvbackup` files in `backups/`, iCloud and Auto Backup rules, the 25 MB fallback and saving a backup through the file picker, the setting, restoring at setup. ADR 28. **Built**: a backup is due when the vault changed and the last is 20 hours old; on Android older backups go first to keep the folder under 24 MB; a whole backup saved through the picker goes by `tauri-plugin-fs`; the recovery sheet as a PDF moves to stage 7. | People with only a phone can use it, safely. | M |
| 4 | **Joining from a phone** | The QR code on "Pair a computer" and the scanner; the fingerprint check; the typed path; the local network permission on iOS, explained and detected; the system browsers for discovery; protocol version ranges (3.5). ADR 29. **Built** ([ADR 29](../adr/0029-phones-as-replicas.md), [ADR 30](../adr/0030-protocol-version-ranges.md)): the QR code carries the host's whole key, which is pinned before pairing; no discovery on phones yet, as the system browsers need native plugins no device here can try; a phone is named by its model on Android, and "An iPhone" or "An iPad" on iOS. | A phone syncs with a host. | M |
| 5 | **Phone screens** | The layout of section 5, the bottom bar, what is hidden (2.4), the shop-floor screens first: recipe, batch sheet, mix log, firing log. ADR 31. **Built**: the More menu holds Materials, Batch sheets, Settings and Lock; printing waits for stage 7; the shop-floor screens keep their layouts in one column. | Usable on the shop floor. | L |
| 6 | **Camera and photos** | "Take photo", HEIC to JPEG, scaling, EXIF stripped, photos on demand by default. | Test tiles from the kiln room. | S |
| 7 | **Getting things out** | CSV through the share sheet; printing by PDF or the native controller. | Parity with desktop's exports. | M |
| 8 | **Mobile end-to-end** | The emulator and simulator smoke suites in CI, the dev driver by file. Change ADR 11. | Keeps it working. | M |
| 9 | **Store release** | Developer accounts, signing, App Store Connect and Play Console listings, privacy labels, export compliance answers, TestFlight and Play internal testing. Waits for Aaron (section 8, question 8). | Customers can install it. | — |

**Fallback for stage 1:** if vendored OpenSSL will not build for a target, SQLCipher can use
CommonCrypto on Apple platforms (`bundled-sqlcipher` with the system crypto) and a prebuilt
OpenSSL on Android. That would mean different features per target in `crates/core/Cargo.toml`.

**Biggest risks:**

- SQLCipher and OpenSSL cross-compiling (stage 1).
- The iOS local network permission: refused once, it is easy to never find again in Settings.
- iOS builds needing a newer Xcode than the dev Mac has: all iOS work is CI-driven until there is
  a newer Mac.
- Apple's review of an app that is useless without a LAN host. Reviewers need a way in: a demo
  host on the internet would break the LAN-only model (ADR 5), so likely a demo vault built into
  review builds, or a video. Question 7.
- Store review lag against the protocol version (3.5).

---

## 8. Open questions for Aaron

Each has a recommended default. Aaron accepted all of them on 2026-10-30.

1. **A phone's own vault.** *Decided 2026-10-30: yes,* since some people have only a phone. Backed
   up through the phone's own backup, as in 2.6. Aaron chose: on by default for "Back up with this
   phone's backup", and the newest three backups kept.
2. **Tablets.** *Default: the same app; at 768 px and wider the desktop layout comes back.* iPad
   and Android tablets on a stand in the glaze room are a likely use.
3. **Biometric unlock** (Face ID, fingerprint). It would keep a key in the Keychain or Keystore,
   released by the biometric. *Default: not in phase 3.* The password stays the only way in, as
   ADR 3 has it. Worth an ADR of its own if customers ask, since it changes what a stolen,
   unlocked phone gives away.
4. **Lock when the app leaves the screen.** *Default: after 30 seconds away.* Immediately is
   safer and more annoying.
5. **Photo size.** *Default: scaled to 2,560 px on the long edge, JPEG 85, location removed.* The
   alternative is keeping the original, for people who measure crazing from photos.
6. **Screenshots.** Android's `FLAG_SECURE` blocks screenshots as well as the switcher picture.
   *Default: block on Android, cover on iOS* (iOS cannot block screenshots). Some people will want
   to screenshot a batch sheet; an admin setting could turn it off later.
7. **App review.** *Default: a demo mode in review builds only*, a small vault built in, never
   joined to anything. The alternative, a public demo host, goes against ADR 5.
8. **When to start stage 9.** It needs an Apple Developer account ($99 a year), a Google Play
   account ($25 once), and the export counsel check already in docs/follow-ups.md. *Default:
   after stage 8, when Aaron has time*, as with the desktop release.
9. **Phase 3 or 4.** The goals say "3 (maybe 4)". *Default: stages 1 to 8 are phase 3; the store
   release is phase 4.*

## 9. ADRs to write or change

- **New 26. Mobile builds.** Targets, the crate types, what is desktop-only and why, SQLCipher on
  each target, the CI jobs, the dev Mac's limits.
- **New 27. Phones: the vault's folder, locking and what the page offers.** Built in stage 2.
- **New 28. A phone's own vault and its backups** through iCloud and Auto Backup (adds to ADR 7:
  where a phone keeps its backups, and a backup without photos). Built in stage 3.
- **New 29. Phones as replicas.** Pairing by QR code with the host's key, the local network
  permission, a phone's name. Notes ADR 5's "Phase 3 mobile is another client". Built in stage 4.
- **New 30. Protocol version ranges.** Changes ADR 21. Built in stage 4.
- **New, later: store release**, with export compliance (changes ADR 3's export paragraph from
  "to be confirmed" to what was answered).
- **Change ADR 11.** The mobile smoke suites.
- **Change ADR 1.** `crates/app` builds for mobile; its "phase 3 needs a macOS CI runner" comes
  true.
- **docs/follow-ups.md:** the iOS item moves into this plan. Add: biometric unlock (question 3).
- **docs/user:** a guide to a phone's own vault and its backups, joining from a phone, what a phone can and cannot do, and giving the
  host a fixed address.

---

### Critical files for implementation

- crates/app/Cargo.toml, crates/app/src/main.rs and crates/app/src/lib.rs (entry point, cfg gates,
  dialogs, updater)
- crates/app/src/network.rs (split into the client half and the desktop-only hosting half)
- crates/app/tauri.conf.json, plus new crates/app/gen/apple and crates/app/gen/android
- crates/sync/src/net/discover.rs and crates/sync/src/proto.rs (system browsers, version ranges)
- crates/core/Cargo.toml (SQLCipher features per target)
- ui/App.tsx, ui/styles.css, ui/useIdleLock.ts, ui/screens/Network.tsx (QR code), ui/screens/Join.tsx,
  ui/screens/FiringLog.tsx (camera)
- .github/workflows/ci.yml, e2e/
