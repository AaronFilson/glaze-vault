# 7. Backups, export, locking by itself, and updates

Proposed, 2026-10-14. Drafts are replaced by [ADR 8](0008-materials-history-drafts.md). A vault
served on a network is backed up by its host, not its computers: [ADR 24](0024-offline-limits-and-revocation.md).

## Context

ADR 6 makes printing, export and backups first-class for one person. Until now a vault lived in
one folder on one disk: a failed disk, or a lost password and recovery sheet, lost every recipe.
A vault left unlocked on a shared bench computer is open to anyone who walks past. And ADR 1
promises an app that updates itself.

## Decision

### Backups

- **A backup is one file** (`.gvbackup`) holding the key file as it was that day and a copy of the
  SQLCipher database file, written after a WAL checkpoint so the database file is complete.
- **The copy is encrypted again**, with XChaCha20-Poly1305 under a key derived by HKDF from the
  database key and a salt of the backup's own. The file's magic, header and the key file are its
  associated data, so a backup that is cut short or changed anywhere is refused. The database
  pages are SQLCipher's, so the recipes are under two layers.
- **It opens with what opened the vault that day:** the password, or the recovery key with a new
  password. Backups are not re-encrypted when the password or recovery key changes later. The user
  guide says so.
- **Restoring checks before it touches anything:** the backup is decrypted and opened as a database
  in a temporary file first. Only then is a vault already in the folder moved, not deleted, into
  a `replaced-<time>` folder beside it, and the backup put in its place.
- **Reminders:** after a number of days the person chooses (a month by default, or never), the
  open vault shows a reminder until there is a newer backup or they choose Not now.
- Backups and file dialogs go through the Rust side: the page asks for a backup, and Rust shows
  the save dialog and writes the file, so the page never names a path to write.

### Export

- CSV (one row per material, with percentages, UTF-8 with a byte order mark for Excel) and JSON
  (`"format": "glaze-vault-export"`, version 1). Text that a spreadsheet would run as a formula is
  prefixed with an apostrophe.
- **Exports are not encrypted**, and Settings says so beside the buttons. The page makes the file's
  contents; Rust asks where to save it.

### Printing

- A recipe with its percentages, notes and unity formula; or a batch sheet scaled to a batch size
  in g, kg, lb or oz, with a running total, a lot column, tick boxes and sign-off lines. Every line,
  colorants included, is part of the batch size.
- Through the system print dialog, which also saves PDFs. Every page is marked Confidential.

### Locking by itself

- **A per-person setting, on by default** at 15 minutes, which the person can switch off or set
  from 1 minute to 2 hours. It is kept in the vault, so it follows a restored backup.
- The page watches for use and compares wall-clock time, so a computer that slept or a minimized
  window locks on return. It checks before counting the activity that brings someone back.
- **Unsaved edits are kept, not lost:** they are encrypted under the collection key, like a
  revision, and stored as the person's one draft. After unlocking, the editor shows them with a
  note, to save or discard. The vault locks even if keeping the draft fails.

### Updates

- Tauri's updater, with the public key in `tauri.conf.json` and `latest.json` from the latest
  published GitHub Release. The app requires the version inside the update's signature to match
  the one announced, so an old release cannot be served as new.
- **The app checks when it starts** (a preference outside the vault, because it applies before
  unlocking; on by default, and can be switched off), and from Settings. **It never installs on
  its own:** the person chooses Install and restart. Before installing, the vault locks.
- A build without a public key (any build before docs/releasing.md has been followed) leaves the
  updater out rather than failing to start.
- Releases are tag-driven drafts; publishing the draft is what reaches installed copies.

## Consequences

- An old backup and an old recovery sheet can still open an old copy of the recipes. That is what
  a backup is for, but it means retiring a leaked recovery key does not retire backups made
  before; the guide says to make a new backup after making a new recovery key.
- Backups were first one ciphertext of the whole database, held in memory while written or
  restored (format 1). Before attachments, format 2 (2026-10-16) encrypts the database in 1 MiB
  chunks with the STREAM construction: each chunk's nonce has the backup's random prefix, the
  chunk's number and a flag on the last, and every chunk is bound to the header, so a backup cut
  short, reordered or changed does not restore. Neither making nor restoring one holds the vault
  in memory; format 1 backups still restore.
- The update check is the app's only network connection, and it can be switched off. Industrial
  sites with no internet simply hear nothing; ADR 5's LAN update mirror comes later.
- Drafts are kept only when the vault locks by itself, not when the app is closed with unsaved
  changes; that is in docs/follow-ups.md.
