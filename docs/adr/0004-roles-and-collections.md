# 4. Access: roles granted on collections, enforced in the core

Proposed, 2026-10-14.

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
- **Keys:** a custom role's grant holds the collection's key, so changing what a role may change
  needs no new keys. Reading batch sheets alone stays the batch operator's, whose grant holds the
  batch key. Exporting, viewing chemistry and managing people are not separate capabilities
  yet: whoever reads a collection may export it, and only admins manage people and collections.
- **The core decides** each change by the kind of record and the person's role on its
  collection, and tells the page what each collection lets the person change, so the page asks
  about that and not about role names.

