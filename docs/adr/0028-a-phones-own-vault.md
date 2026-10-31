# 28. A phone's own vault, backed up by the phone's own backup

Proposed, 2026-10-30. Stage 3 of [the phase 3 plan](../plans/phase-3-mobile.md#7-staged-delivery)
(its section 2.6), on [ADR 27](0027-phones.md)'s backup rules. Adds to [ADR 7](0007-backups-locking-updates.md):
where a phone keeps backups, and a backup without photos.

## Context

Some people have only a phone, so it has to hold a whole vault for one person (ADR 6), and a lost
phone must not be a lost vault. A phone has a backup of its own, iCloud or Google, that people
already rely on; ADR 27 left a `backups` folder beside the vault for it to take, and the live
vault out. A phone has nowhere like a USB drive to save to, and ADR 7's backups are saved through
a file dialog. Android's own backup takes at most 25 MB of an app, and none of it when there is
more; a vault with photos passes that quickly.

## Decision

- **Setup on a phone** offers what a desktop does: start a vault, restore one, or join one on the
  network. A phone's own vault can grow into a team (ADR 12); it cannot host.
- **Backups of itself**: on a day its vault changed, a phone's own vault writes an ADR 7 backup
  into `backups/` beside the vault's folder, named `backup-<milliseconds>.gvbackup`, and keeps the
  newest three (`Vault::back_up_own`, `crates/core/src/vault/own_backups.rs`). One is due once
  the change log has grown since the last and the last is 20 hours old, so opening the app at
  about the same time each day makes one. The page asks when the vault opens, when the app goes
  into the background, and hourly; the core decides. Each is written as `backup.partial` and
  renamed when whole, so the system's backup never takes half of one.
- **Who makes them**: only a vault of its own, never a replica (the host backs up, phase 2
  question 12); in a team, only while an admin is signed in, as with any backup (ADR 12). They are
  on by default, and **Back up with this phone's backup** in Settings turns them off, for someone
  who wants not even ciphertext in a cloud. The setting is the person's, beside their other
  settings.
- **A whole one counts as backed up** for ADR 7's reminder; Settings shows when the last was made.
- **Android's 25 MB**: the folder may hold 24 MB in all on Android. A backup over that is made
  again without its photos: a copy of the database with every attachment's bytes taken out, as a
  replica holds one it has not fetched (`length(ciphertext) = 0`, ADR 23), so it still restores,
  and a photo it lacks says it is not here. Its name ends `-no-photos`. Older backups go before
  the folder passes 24 MB, so on Android often only the newest stays. One without photos does not
  count for the reminder, so after the reminder's days the person is asked to save a whole one,
  and Settings says why. iCloud has no limit beyond the person's storage.
- **Saving a whole one on Android**: **Back up now…** opens the system's file picker, which hands
  back a `content://` address, not a path. The backup is written in the app's cache under the
  chosen name and copied there through `tauri-plugin-fs`, which opens such addresses (Android
  builds only), so it can go to Google Drive or a USB drive.
- **Restoring on a phone**: after the phone itself is restored from its own backup, the vault is
  gone but `backups/` came back. Setup then reads **Restore from a backup on this phone**, and the
  restore screen lists those backups, newest first, before the file picker.
- **The recovery sheet as a PDF** is left for stage 7, with printing.

## Consequences

- A backup in iCloud or Google is as safe as the password is strong: it is encrypted under it
  (Argon2id, ADR 3), and the recovery key also opens it. Settings says so beside the choice.
- On Android a vault whose backup without photos is still over 24 MB has none in Google's backup
  that fits, and the newest is kept anyway; Google then backs up none of the app. Only saving one
  elsewhere covers it.
- A backup is made at most once a day, so a day's work since the last is not in the phone's
  backup until the next. ADR 7's backups by hand stay for that.
- Picking a backup file to restore, and picking photos and imports, still fail on Android, which
  hands those back as `content://` addresses too; stages 6 and 7 take them.
- Nothing here has run on a phone yet: the folder rules, the save through the file picker and the
  restore after a phone restore are checked only by builds and by tests on the dev Mac.
- Desktops are unchanged: they make no backups of themselves, and offer none on the restore
  screen.
