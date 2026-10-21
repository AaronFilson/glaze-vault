# 9. Deleting, and erasing for good

Proposed, 2026-10-15. Erasing leaves a tombstone, and a delete made elsewhere can fork a record,
from [ADR 17](0017-key-epochs-change-log.md).

## Context

Nothing saved could be removed (ADR 8 left it for a decision of its own). Two things pull apart:

- Revisions are only ever added (ADR 5), and a replica that was offline must be able to learn
  that a record went away. A deleted record that simply vanished would come back from the first
  replica that still had it.
- A recipe is a trade secret. "Delete" that only hides it is not what someone means when a recipe
  must leave the vault, for example when a customer takes their formula elsewhere.

## Decision

Both, in two steps.

- **Delete** adds a revision after the record's newest that says it deletes the record, with the
  same content. The record leaves its list and appears under **Deleted**, read-only, where it can
  be restored or erased. Only the newest revision can be deleted from, so a deletion cannot fork
  a record.
  - The deleting revision is marked by a `deleted` column (schema 2), and the mark is bound into
    that revision's associated data (" deleted" at the end), so it cannot be set or cleared
    without the collection key. Revisions saved before stay as they were.
  - **Restore** is an ordinary save after the deleting revision, with its content. A material is
    not restored over another of the same name.
  - A record's history leaves the deleting revision out, since it repeats the one before.
- **Erase permanently** is only offered for a deleted record, after a question that says it cannot
  be undone. It removes every revision of the record. SQLite's `secure_delete` is on, so freed
  pages are zeroed, and the write-ahead log is checkpointed and emptied afterwards.
- The question before deleting a material says how many recipes use it, and whether they fall back
  to a standard material of the same name or will not find it.

## Consequences

- A deleted record still takes space and is in backups until it is erased.
- Erasing does not reach backups made before; the question and the user guide say so.
- With replicas (ADR 5), an erasure will need to travel as well: a list of erased record ids,
  kept by the host, that replicas apply and that stops an offline replica bringing the record
  back. One-person vaults have no replicas, so that waits for phase 2.
- Deleting a material does not change recipes; they find it again when it is restored.
