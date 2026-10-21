# 3. Encryption: SQLCipher, keys per collection, sealed to each user

Proposed, 2026-10-14. Re-encrypting when a grant is removed is replaced by key epochs in
[ADR 17](0017-key-epochs-change-log.md).

## Context

Recipes are trade secrets. A copied vault file, a lost laptop or a stolen backup must reveal
nothing. Users of the same vault see different parts of it (ADR 4), and replicas on laptops
carry only their users' part (ADR 5), so one key for everything is not enough. Users forget
passwords, so there have to be recovery keys. The encryption has to be what US export rules
allow in a general-purpose product, which means standard algorithms, not shorter keys.

## Decision

- **The vault file** is SQLite encrypted with SQLCipher 4 (AES-256, with an HMAC-SHA512 on every
  page), using a random 256-bit database key. That hides everything at rest, the metadata
  included.
- **Collections** (ADR 4) each have a random 256-bit key. The content of every record, names
  included, is encrypted with its collection's key (XChaCha20-Poly1305) inside the database. The
  database alone gives ids, revision numbers and collection ids, not recipes.
- **Users** each have an X25519 key pair. The private key is encrypted with a key derived from
  the password (Argon2id, 64 MiB, 3 passes), so changing a password re-encrypts one small value.
  Giving a user a collection, or the database key, means sealing that key to the user's public
  key (HPKE, RFC 9180). An admin can therefore grant access without the user's password.
- **A keyring file** beside the vault holds what is needed to open it: user names, Argon2
  parameters and salts, public keys, encrypted private keys and sealed keys. It holds no secret
  in the clear.
- **Recovery keys:** every user gets one when the account is made: 256 random bits shown once as
  words, on a sheet to print. It encrypts a second copy of the user's private key.
- **The organization key**, when there is an admin, is a key pair to which every collection key
  is also sealed. Admins hold its private key, encrypted with their own keys, and an organization
  recovery key encrypts one more copy. Holding the organization key is what makes someone an
  admin. Users' private collections are private from other users, not from the organization:
  their keys are sealed to the organization key too, so an admin can recover them and so the vault
  can go back to one person (ADR 6).
- **One person** (ADR 6) is the same design with a single user and no organization key: that user
  holds every key, and their recovery key is the only way back in.
- **Removing a grant** creates a new key for that collection and re-encrypts it, because the
  person removed may have kept the old key, on a replica for example.
- Only well-reviewed libraries (SQLCipher and the RustCrypto crates), and no invented primitives.

## Export

AES-256 and the rest in a general-purpose app are mass-market encryption: ECCN 5D992.c under
License Exception ENC, section 740.17(b)(1), which can mean an annual self-classification report
to BIS. Because the source is public under MIT, the software may instead count as publicly
available and fall outside the EAR. Either way there is no limit on key length. Phase 3 also
means answering Apple's and Google's export-compliance questions. To be confirmed with export
counsel before the first customer release.

## Consequences

- With no admin, a user who loses both password and recovery key loses their private collection
  for good. The setup screens must say so plainly, and require the recovery sheet to be confirmed.
- With an admin, the organization recovery key can restore everything, so it must be kept like a
  master key (in a safe, not on the same machine).
- Search runs over decrypted records in memory; the database cannot index encrypted content.
