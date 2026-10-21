# 4. Access: roles granted on collections, enforced in the core

Proposed, 2026-10-14. Re-encrypting when a grant is removed is replaced by key epochs in
[ADR 17](0017-key-epochs-change-log.md). The one access check reads a directory of metadata, and
changes to it are events, in [ADR 18](0018-directory-events.md). Signed revisions and the audit log
are built in [ADR 19](0019-signatures-and-audit-log.md).

## Context

People at an industrial user need different things: some weigh batches, some read the
chemistry, some change recipes, and some manage everything. An admin decides what is shared and
what is private, for whom, at what level. This calls for basic role-based access control, not a
general policy engine.

## Decision

- **Collections** are what gets shared: "Production glazes", "R&D", "Clay bodies", one per
  customer line, and so on. Every user also has a private collection. Each collection has its
  own key (ADR 3).
- **Capabilities** are a fixed list in the core, for example: `batch.view`, `batch.print`,
  `batch.log`, `recipe.view`, `chemistry.view`, `recipe.edit`, `recipe.create`, `material.view`,
  `material.edit`, `firing.log`, `export`, `collection.manage` and `user.manage`.
- **Roles** are named sets of capabilities, which admins can change. The defaults are Batch
  operator, Chemist, Formulator and Admin. A role is what the request calls a tier or user level.
- **A grant** gives a user (or later a group) a role on a collection. What a user can do is the
  union of their grants. Read access to a collection also seals its key to the user.
- **Only the core decides.** Every command and every LAN request goes through one access check in
  `crates/core`. The UI hides what is refused, but nothing depends on it hiding it.
- **Separating batches from chemistry:** a batch operator sees a batch sheet for the size asked
  for, with materials named by in-house codes (M-104), and no percentages, unity formula or
  analyses. The materials' names and analyses live in a separate collection, so without it the
  chemistry cannot be worked out, whatever the UI does.
- **Editing** is refused by the core, and in LAN mode by the host, which rejects changes the
  author was not allowed to make (ADR 5). Every revision is signed with the author's key, so the
  history shows who made it.
- **The audit log** is append-only and signed: who viewed, printed, exported, logged or changed
  what, and when.
- **With no admin**, there are no roles: every user has full use of one shared collection and of
  their own private one. An admin can be added later.

## Consequences

- Anyone who weighs a batch in grams can still work out its proportions. Separation protects the
  material identities and the chemistry, the other collections, and the right to edit, not the
  numbers that are on the sheet.
- On a single machine a user could change the vault file directly with a key they hold, outside
  the app. That shows up in signature checks and is refused by the host on sync, but it is
  detected, not prevented.
- Removing a grant means re-encrypting that collection (ADR 3).

## Built

Built in ADR 12 and after, more simply than the capability list above:

- **Built-in roles:** Batch operator, Chemist, Tester (reads, and logs firings), Formulator and
  Admin.
- **Roles admins make** read everything in their collections, as a chemist does, and change the
  kinds of record ticked: recipes, materials, batch sheets, firings, limit formulas, prices. They
  are kept in the database (schema 5) and named in grants as `role:` and their id.
- **Capabilities** of a role admins make, besides what it changes (schema 6): **export**,
  **print**, **chemistry** and **manage**. The built-in roles keep what they could do before:
  all but manage (a batch operator reads no chemistry), and admins manage everything.
  - Export and print are kept by the page, and export also by the command that writes the file
    (refused for someone who may export from no collection). The page has the content, so these
    are guard rails, not locks.
  - **Without chemistry**, a grant holds the collection's **summary key**, made from its key as
    the batch key is. Each recipe revision keeps a summary, its content without `lines` and
    `notes`, under it, and firings and their photos are kept under it too. This is the one place
    the core looks inside content. Such a role may change only firings and may not manage.
    Vaults from before are changed over, all or none, by the first admin (or the one person) to
    unlock; until then nobody can be given such a role.
  - **Manage** lets someone give and take away roles on that collection, other than an admin's
    or a manager's, to anyone but an admin, a manager or themselves, and rename it. They hold the
    collection's key; taking a role away rotates it, sealing the new key to the organization's
    public key, which every key file has. Adding people to the vault stays with admins.
- **Keys:** a custom role's grant holds the collection's key, or its summary key without
  chemistry. Changing what a role may change needs no new keys; taking chemistry away rotates
  the key of every collection it is on, and giving it back seals its grants again with the
  collection's key. Going to a narrower key in a person's grant (to the batch or summary key, or
  from one to the other) rotates the collection's key, as it did for batch operators.
- **The core decides** each change by the kind of record and the person's role on its
  collection, and tells the page what each collection lets the person change, so the page asks
  about that and not about role names.

