# How your recipes are protected

## What is encrypted

Everything in your vault: every recipe's name, materials, amounts and notes, every revision,
your own materials, your unsaved changes, and the lists of them.

- The vault's database is encrypted as a whole with **AES-256** (SQLCipher), so a copy of the
  file shows nothing, not even how many recipes there are.
- Inside it, each revision of a recipe or material is encrypted again with
  **XChaCha20-Poly1305**, tied to its place in the vault, so one cannot be swapped or moved without
  Glaze Vault noticing.
- Your password is never stored. It is stretched with **Argon2id**, which makes each guess slow
  and memory-hungry, into the key that unlocks your keys.
- Your recovery key is another way to unlock those keys.

These are standard, published algorithms, and Glaze Vault's source code is public, so anyone can
check how it works. The protection comes from your password and your recovery key, not from
keeping the method secret.

## What it does not protect against

- **Someone using your computer while the vault is open.** Lock it or quit it when you step away;
  locking by itself is a backstop, not a replacement.
- **A weak password,** or one you also use elsewhere.
- **Malicious software on your computer,** which could read what is on your screen or what you
  type.
- **Printouts and exports.** A printed or exported recipe is no longer encrypted.

## Backups, exports and printouts

- **Backups** are encrypted twice over: the encrypted database, encrypted again as a whole, so a
  backup that has been changed or cut short is refused. A backup opens with the password or
  recovery key the vault had when it was made. See [Backups and export](backups.md).
- **Exports** (CSV and JSON) are **not encrypted**. Anyone with the file can read your recipes.
- **Printouts** are marked Confidential, but they are paper.

## Who did what

Each revision is signed by whoever saved it, and the vault keeps a log of what everyone did, each
entry signed and chained to the one before. Both show changes made to the vault's files outside
Glaze Vault; on one computer they cannot stop someone who can unlock the vault from making them.
See [Who did what](audit-log.md).

## Locking

The vault [locks by itself](settings.md#locking-by-itself) after 15 minutes without use, unless
you change that. Locking wipes the keys from memory. Unsaved changes are kept encrypted, like
saved recipes.

## The network

Glaze Vault's only network connection is the check for updates, which asks GitHub for the
newest version number: nothing from your vault is sent. You can turn it off in
[Settings](settings.md#updates). Updates are checked against Glaze Vault's own signing key
before they install, so a changed or older download is refused.
