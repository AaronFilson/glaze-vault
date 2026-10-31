# 27. Phones: the vault's folder, locking and what the page offers

Proposed, 2026-10-30. Stage 2 of [the phase 3 plan](../plans/phase-3-mobile.md#7-staged-delivery),
on [ADR 26](0026-mobile-builds.md)'s mobile builds. Changes ADR 26's "Stage 2 checks [the mobile
projects] in". A phone's own vault and its backups are [ADR 28](0028-a-phones-own-vault.md) (stage 3);
joining from a phone comes in stage 4.

## Context

A phone can be lost with the app open, keeps a picture of the last screen for its app switcher,
and backs itself up to iCloud or Google. The vault on it must survive none of those as readable
recipes. Stage 1 left the page guessing it was on a phone from flags meant for other things
(`canHost`, `updatesConfigured`).

## Decision

- **The platform**: `vault_status` says `"desktop"`, `"ios"` or `"android"`. The page uses it for
  what it offers (hosting, updates) and for locking. The plan's separate `platform` command is
  this field instead, since the page reads the status before anything else.
- **The vault's folder** stays `app_local_data_dir()/vault`. On iOS, at start, the app marks the
  folder as excluded from backups (`NSURLIsExcludedFromBackupKey`), and gives it and everything
  already in it `NSFileProtectionComplete`, so its files cannot be read while the phone is locked;
  new files take their folder's protection (`crates/app/src/phone.rs`). On Android the app's own
  storage is private to it already.
- **System backups** take only a `backups` folder beside the vault, which stage 3 fills with
  finished backups: on iOS by the exclusion above; on Android by backup rules that include only
  `backups/` (`android:fullBackupContent` for Android 11 and before, `android:dataExtractionRules`
  for cloud backup and moving to a new phone on 12 and later). Naming what to include leaves
  everything else, the live vault and the preferences, out.
- **The app switcher**: on iOS a plain cover with the app's name goes over the window when the
  app stops being active, and comes off when it is active again (`SnapshotCover.m`). On Android
  the window is `FLAG_SECURE`, which also blocks screenshots (the plan's question 6).
- **Locking in the background**: the page locks the vault once the app has been in the background
  for 30 seconds (`useBackgroundLock`), keeping unsaved changes as a draft, as the idle lock does.
  A suspended app runs no timers, so coming back checks the wall clock too, and locks before
  anything is shown. The unlock screen says it locked while in the background.
- **The mobile projects are still not checked in.** `tauri android init` and `tauri ios init` need
  SDKs the dev Mac lacks, so the projects cannot be made or tried here. Instead
  `crates/app/mobile/patch.cjs` changes what `tauri init` makes, after it: the manifest's backup
  attributes and rule files, `FLAG_SECURE` in `MainActivity.kt`, and `SnapshotCover.m` beside
  `main.mm` with the Xcode project generated again. CI runs it after each init; anyone building
  for a phone by hand runs it too. Running it twice changes nothing more.
- **Argon2id stays at 64 MiB and 3 passes.** One password hash takes about 0.16 seconds on the
  dev Mac (Intel, release build); unlocking is mostly that. The ignored test
  `password_hash_time` in `crates/core/src/crypto.rs` measures it. Phones are not measured yet:
  stage 8's emulator and simulator runs are the first chance, and the settings only change if a
  phone takes several seconds.

## Consequences

- While the app is suspended, its keys stay in its memory until it comes back and the page locks.
  Another app cannot read that memory, and iOS may end a suspended app, which locks it for good;
  a lock from the native side would need more native code than this stage carries.
- With `NSFileProtectionComplete`, a save during the 30 seconds after the phone itself locks fails
  with a file error. Syncing stops in the background anyway (plan section 3.3).
- The snapshot cover and `FLAG_SECURE` are only checked by the builds compiling: nobody has looked
  at a phone's app switcher yet.
- Some people will want to screenshot a batch sheet on Android; turning `FLAG_SECURE` off by a
  setting can come later.
- Desktop behaviour is unchanged.
