# 19. Signed revisions, key certificates and the audit log

Proposed, 2026-10-21. Stage 3 of [the LAN host plan](../plans/phase-2-lan-host.md#7-staged-delivery),
its section 5. Builds what [ADR 4](0004-roles-and-collections.md) deferred ("every revision is
signed", "the audit log") and the follow-up from [ADR 12](0012-teams-on-one-computer.md). Changes
the plan in three places, said below: signing keys are not kept in the key file, certificates are
not issued again when the organization key changes, and a person who joined before signing proves
their key before an admin certifies it. When a certificate is trusted goes by order in the change
log, not by time, from [ADR 20](0020-sync-core.md).

## Context

A revision's associated data binds it to its record, collection and place in the history, but not
to who saved it or when: anyone holding the database key could change `author_id` or
`created_at`. On one computer that person already holds every key, as ADR 12 says. The LAN host
cannot be that relaxed: it holds no collection key (ADR 18), so it must decide what to accept from
a device by checking who made it, from public keys alone. And nothing recorded who opened, printed
or exported what, which ADR 4 promised industrial users.

## Decision

- **Signing keys come from the keys people have.** A person's Ed25519 signing key is made by HKDF
  from their X25519 secret (`glaze-vault v1 signing-key`), and the organization's from its own
  (`glaze-vault v1 organization signing-key`), so the key file holds no new secret
  (`signing.rs`, `ed25519-dalek` 3, which shares `curve25519-dalek` 5 with `x25519-dalek`).
- **What is signed is fixed text,** built by one function each, never serde output: for a revision,
  its ids, kind, collection, epoch, number, parent, deleted mark, what it supersedes, author, time,
  and the hashes of its ciphertext and its summary, so a copy without the content, for a reader
  of summaries, still checks; for an attachment, its ids, kind, collection, epoch, type, size,
  author, time and hash; for an event, its id, type, actor, collection, time and the hash of its
  body as stored. Each names the signer and the capacity they sign in.
- **Three capacities.** The author signs what they save. Whoever moves a record signs its
  revisions and attachments again, since a move encrypts them again (ADR 18); the author stays
  the author. An admin, or a one-person vault's person, vouches for what was saved before
  signing: at their first unlock at schema 10, they sign every revision, attachment and event
  without a signature, as an attester. That needs no collection key: only hashes are signed. The
  summaries change-over, which encrypts firings again, drops their signatures, and the same unlock
  vouches for them.
- **Certificates.** A `certificate-issued` event says a signing key and an encryption key are a
  person's. In a team's vault the organization issues them: when someone is added or given new
  keys, an admin makes the keys and certifies them at once. In a one-person vault the person's key
  certifies itself. The organization's signing key is listed by an `organization-key-added`
  event, signed by that key.
- **Proof for keys made before.** People who were in a team before signing have keys no admin
  made, so an admin cannot work out their signing key. At their next unlock they certify their own
  key, with a proof: a value from an X25519 exchange between their secret and the organization's
  public key, which the admin's unlock works out again from the other side before the
  organization certifies the key. Without the proof, anyone with the database key could put a key
  under someone else's name, and an admin would certify it. Signing alone proves only that one
  holds the signing key.
- **When a certificate is trusted.** Each organization signing key is listed with when it became
  the organization's and when it stopped. A new organization key (taking admin away) retires the
  one before; going back to one person retires them all. A certificate is trusted if it was issued
  while its issuer was the organization's key, or, for a key that certifies itself, while the
  vault had no organization. So what the old key certified stays good, and certificates are not
  issued again under a new key, as the plan had it. A retired key cannot certify anything new that
  the directory accepts, since an admin's certificate must be by the current key.
- **Checking a signature.** A revision's history says, for each, who signed it, as what, and
  whether it is good (a key certified as theirs), unconfirmed (a key no admin has certified yet,
  or one not known), or bad (it does not match what it signs). On one computer a bad signature is
  a warning, not a refusal: whoever could forge one holds the keys anyway (ADR 12). It shows that
  something was changed around the app.
- **Revocation and dates.** A person removed, or given new keys, has their certificates revoked.
  The time a certificate gives for itself, and its revocation, cannot be enforced by one computer
  against someone with the database key, who could write rows of any date. The LAN host will
  enforce both by when things reach it (ADR 20).
- **The audit log** (`audit`): each entry has a time, the person, an action, and the kind, record
  and collection it was about, and a detail, ids only, never content. Each entry's hash covers the
  one before and its own fixed text, and the person signs the hash. It records every save, delete,
  attached file, erasure and move, every change to the directory, sign-ins, password and recovery
  key changes, backups made and restored, and, as the page reports them, a record opened (once a
  sign-in), printed (with the batch size or revision) or exported (format and how many). Erasing a
  record leaves its entries.
- **Who reads it:** an admin, or a one-person vault's person, in Settings, with names put back
  from what they can open, newest first, and a CSV export of all of it. The screen says whether
  the chain is whole and marks entries whose signature is not good.
- Schema 10.

## Consequences

- Who saved each revision, who moved it, and who vouched for it, show in its history in a team's
  vault, with a warning when a signature does not check.
- The host can check every revision, attachment and event it is sent with public keys, and
  vouched-for items let a vault from before become a host.
- Until an admin unlocks once, what people from before save shows as unconfirmed, and items saved
  before signing as unsigned.
- Reading, printing and exporting are what an honest app reports, not proof of what someone saw;
  the guide says so. A failed sign-in cannot be logged: the log is inside the vault it could not
  open.
- On one computer the log can be rewritten by anyone with the database key, and a changed chain
  is only detected. The host keeps the log and signs it (ADR 20).
- Older versions of the app refuse a vault at schema 10.
