# 17. Key epochs, the change log and tombstones

Proposed, 2026-10-20. Stage 1 of [the LAN host plan](../plans/phase-2-lan-host.md#7-staged-delivery).
Replaces [ADR 3](0003-encryption-and-keys.md)'s "Removing a grant … re-encrypts it", the
re-encrypting in [ADR 12](0012-teams-on-one-computer.md) when someone loses a collection and when
admin is taken away, and [ADR 14](0014-firing-log-and-photos.md)'s "Changing a collection's key
re-encrypts its attachments". Changes how [ADR 9](0009-deleting-and-erasing.md)'s erasing ends.

## Context

Replicas ([ADR 5](0005-lan-host-and-replicas.md)) copy rows from a host and send theirs back.
That works only if a row, once made, never changes, and if a store can say what it has in the
order it came. The vault did neither:

- Giving a collection a new key encrypted every revision, summary, attachment and draft in it
  again, in place. Every replica would have had to fetch the whole collection again, and
  signatures over ciphertext (stage 3) would have broken.
- Erasing deleted a record's rows and left nothing, so a replica that was offline would have
  brought the record back.
- Nothing recorded the order things were saved in, so there was no cursor to sync from.
- A record that forked showed its newest revision, and there was no way to end the fork.

Aaron accepted the plan's defaults on 2026-10-20 (its section 8), among them key epochs instead of
re-encrypting (question 2), and keeping an edit when a delete made elsewhere did not see it
(question 14).

## Decision

- **Key epochs.** A collection's key no longer changes by re-encrypting what it holds. Taking a
  role away, removing a person, going to a narrower key and taking admin away start a new
  **epoch** instead: a new random key, sealed to the people who keep their grants and to the
  organization. Today's keys are epoch 1, so the migration encrypts nothing again.
- **Each epoch's key wraps the one before** (`collection_epochs`, from epoch 2), three times: the
  collection key, the batch key and the summary key, each under the same key of the new epoch,
  with associated data naming the collection, both epochs and which key. Someone who holds the
  batch key reaches earlier batch keys and nothing more, as now.
- **Grants are sealed to their epoch.** From epoch 2 a grant's sealed key, and the organization's,
  is bound to its epoch, so an earlier key cannot pass as the current one. Every grant on a
  collection is at its current epoch; one at another is refused as damage.
- **Everything stored keeps the epoch it was stored under:** each revision and attachment has an
  `epoch` column, and a draft carries its epoch. New ones use the current epoch. The keys of every
  earlier epoch are unwrapped at unlock: chains are short and unwrapping takes microseconds, so
  the plan's "lazily" was not needed.
- **What this gives up.** Someone removed who kept their old key, and a copy of the encrypted
  rows, can still open what they could already read. What is saved after they leave they cannot.
  Before, they could open nothing in the vault afterwards, but only because they no longer had
  its rows: the database key changes when a person leaves, as before. On replicas, re-encrypting
  would buy nothing, since the old rows are already on the laptop.
- **The change log.** `changes(seq, host_seq, item, item_id, collection_id, kind)` lists each
  revision, attachment and erased record in the order this store got it, filled at the migration
  from what was there, by when it was saved. A move takes the record's entries out and adds them
  again at the end, under the new collection, as the host will give moved rows new numbers.
  `host_seq` stays empty until there is a host (stage 4). New key epochs and moves become events
  in stage 2.
- **Attachments are hashed:** `sha256` of the nonce and then the ciphertext, filled at the
  migration, so a host without the key can check an upload.
- **Tombstones.** Erasing writes `erased(record_id, kind, collection_id, erased_at, erased_by)`,
  takes the record out of the change log and adds an `erased` item, then deletes the rows as
  before. Nothing of what the record held is kept.
- **Forks.** A record's newest revisions are those with no child that no other revision
  supersedes. With more than one, the record is listed by its newest, except that one that keeps
  the record goes before one that deleted it, and the others come with it as `forks`. So a delete
  made without seeing an edit does not hide the edit, and the record stays in the list, not under
  Deleted, until someone chooses.
- **Ending a fork** (`resolve_fork`) saves a revision after the version kept, with its content and
  deleted mark, whose `supersedes` column lists the others. The list is bound into its associated
  data (only when there is one, so earlier revisions still open). The versions not kept stay in
  the history. The caller names the versions it sets aside, and they must be exactly the other
  newest ones, so a version that arrived while someone chose is not dropped unseen
  (`ForkChanged`). Only someone who may change that kind of record in its collection can choose.
  Deleting is still only from one of the newest.
- **On screen,** the recipe and material editors show a notice on a forked record, with a button
  for each version and, for recipes, Compare with the other version. Nothing is merged. Other kinds
  show their newest until replicas exist (follow-up).
- Schema 8.

## Consequences

- Taking someone off a collection, removing a person and taking admin away no longer depend on
  how much the vault holds: only small keys are written. ADR 12's progress message is not
  needed.
- Older versions of the app refuse a vault at schema 8.
- Rows still changed in place: moves (stage 2 makes them events), grants, roles and collections
  (stage 2's directory events), and the summaries change-over, which becomes a precondition for
  hosting so no replica sees a vault from before it.
- Forks do not come about on one computer through the app, so the notice is checked by component
  tests. It matters from stage 7, when laptops work offline.
