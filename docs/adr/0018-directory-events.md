# 18. The directory as events, and shared access checks

Proposed, 2026-10-21. Stage 2 of [the LAN host plan](../plans/phase-2-lan-host.md#7-staged-delivery).
Builds [ADR 4](0004-roles-and-collections.md)'s "one access check in the core" so that a store
holding no collection key can run it, and makes [ADR 12](0012-teams-on-one-computer.md)'s "with
the LAN host a move becomes an event" true now. Changes the plan's section 3.10: people's key
file entries do not travel in events.

## Context

After [ADR 17](0017-key-epochs-change-log.md), revisions and attachments are never changed, and
the change log lists them in order. The directory was still rows changed in place:

- Grants were deleted and inserted again, roles updated and deleted, collections renamed, with
  nothing to say it happened. A host could not replay a change, and a replica could not learn of
  one.
- The checks of who may do what were mixed in with key handling in `Vault` (`editable`,
  `managed`, the manager rules in `set_role`, role names), so they needed the keys of whoever
  was signed in. The LAN host is blind (the plan's question 1): it holds no collection key, yet
  must refuse what a device may not do.
- People were only in the key file, which every store keeps for itself.

## Decision

- **Events.** Every change to the directory is an event: a person added, removed or given new
  keys; admin given or taken away; a team formed or gone back to one person; a collection made or
  renamed; a key epoch; a grant set or removed; a collection's key sealed to the organization; a
  role made, changed or deleted. Erasing a record and moving one are events too. Each has an id,
  an actor, a time and a JSON body, for example
  `{"type":"grant-set","person":"…","collection":"…","role":"chemist","epoch":2,"sealed":{…}}`,
  kept in `events` as it was made and never written again.
- **The change log lists them.** Directory events go in the directory's part of the log (no
  collection). A key epoch and an erasure go in their collection's, so they come before what uses
  them, and a move goes in both collections', so those who read only the one it left learn that
  it went. The LAN host will choose what each device gets from these and from the event's
  collection.
- **One apply.** `events::apply` writes an event to the tables and does not check it.
  `events::record` reads the directory, checks the event, and applies it, in the caller's
  transaction. A change made of several events, as removing someone and giving their collections
  new keys, is all or none, and each event is checked against the directory as the ones before it
  left it. On one computer the vault records; the host will check and apply what devices send; a
  replica will apply what the host sends.
- **People are in the database.** `people(id, name, public_key, admin, added_at, removed_at)` is
  written only by events. The key file is still how a store is unlocked, and the lock screen still
  reads names from it before anything is open.
- **Key file entries do not travel in events.** The plan had the event that adds a person carry
  their private key under the one-time password, and a password change make an event. Events are
  kept for good, so the log would keep every password a person ever had, each one opening their
  private key. Events carry public keys only. Changing one's password is not a change to the
  directory and makes no event; new keys (an admin's reset, the organization's recovery key) do.
  How entries reach a person's devices is for the sync protocol (ADR 20).
- **Shared checks.** `access::Directory` is people, collections (owner and epoch), grants (role
  and epoch) and roles, read from the tables, with no key. It answers `may_change`, `may_manage`,
  `held` and `capabilities`, and `check(actor, event)` holds the rules: only an admin changes
  people, admins, collections and roles; someone who manages a collection gives and takes away
  only lesser roles, to others who are not admins; nobody removes themselves or takes their own
  admin; an admin is not removed before admin is taken away; names of people and roles are given
  and not taken; a role that reads without chemistry logs firings and changes nothing else; a
  role in use is not deleted; a key epoch follows the one before, and grants are sealed at the
  current one; erasing and moving need the right to change that kind of record in each
  collection. The vault uses the same answers for saving records and for what it shows, and still
  checks that it holds the keys a change needs.
- **After a new epoch,** whoever started it, an admin or a manager, seals everyone's grant again
  as it was. A manager may do that for an admin's or a manager's grant, and nothing more.
- **A key someone is losing is never sealed to them,** since the log keeps every grant. When a
  role goes to a narrower key, the new epoch's grants leave that person out, and theirs follows,
  sealed for the narrower key only.
- **A one-person vault** has no admin. Its first person adds themselves when it is made, decides
  everything, and makes no change to people or roles until the vault grows into a team's.
- **The key file is written before the database keeps the events** of growing into a team, adding
  someone, making an admin and resetting someone, so a failure between them leaves neither.
  Removing someone and taking admin away keep the order of ADR 12 and 17, which the next try or
  unlock finishes; going back to one person now finishes on a second try too.
- **Vaults from before.** The first unlock at schema 9 makes the events the vault would have
  recorded, from what it holds: each person in its key file (a one-person vault's public key comes
  from whoever unlocks it, since its key file does not keep it), its admins, collections, roles,
  key epochs, grants, and the collections' keys sealed to the organization. They have no actor
  and go first in the change log, the rest moving up. Each erased record's tombstone in the log
  becomes an erasure event in its place, by whoever erased it. When people were added, and who
  left before, cannot be known. Stage 3 vouches for these events, as for the revisions saved
  before signing.
- **Moves** are events, but the mover still encrypts the rows again in place; the event names
  the record and both collections, and the rows follow it in the log. With the host the event will
  carry the rows that replace the old ones (ADR 20).
- Schema 9.

## Consequences

- Nothing changes on screen. Older versions of the app refuse a vault at schema 9.
- The checks the host needs are written and tested without a key or a vault (`access.rs`), and a
  store that applies a vault's events in order ends with the same directory (`events.rs`).
- The directory is read again for each event: a few small tables, so a change of many grants
  takes milliseconds.
- What is still changed in place: a move's rows (until stage 4), the summaries change-over (a
  precondition for hosting), and what stays on one computer: drafts, settings, the last backup.
- The people table and the key file can disagree if the app stops between writing them. Checks
  follow the database and unlocking follows the key file, so someone is never given more by it.
- The log keeps every grant ever sealed. Each was sealed to someone who held that key then, so it
  gives nobody more than they had.
