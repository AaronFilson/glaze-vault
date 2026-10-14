# How your recipes are protected

## What is encrypted

Everything in your vault: every recipe's name, materials, amounts and notes, and the list of
recipes itself.

- The vault's database is encrypted as a whole with **AES-256** (SQLCipher), so a copy of the
  file shows nothing, not even how many recipes there are.
- Inside it, each recipe is encrypted again with **XChaCha20-Poly1305**, tied to its place in the
  vault, so a recipe cannot be swapped or moved without Glaze Vault noticing.
- Your password is never stored. It is stretched with **Argon2id**, which makes each guess slow
  and memory-hungry, into the key that unlocks your keys.
- Your recovery key is another way to unlock those keys.

These are standard, published algorithms, and Glaze Vault's source code is public, so anyone can
check how it works. The protection comes from your password and your recovery key, not from
keeping the method secret.

## What it does not protect against

- **Someone using your computer while the vault is open.** Lock it or quit it when you step away.
- **A weak password,** or one you also use elsewhere.
- **Malicious software on your computer,** which could read what is on your screen or what you
  type.
- **Printouts.** A printed recipe is no longer encrypted.

## Backups

> Coming later: encrypted backups from inside the app.

Until then, you can copy the whole `vault` folder (see
[where your vault is kept](installing.md#where-your-vault-is-kept)) while Glaze Vault is
**closed**. The copy is as well protected as the original, and opens with the same password
and recovery key.
