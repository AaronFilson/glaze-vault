# 12. A team on one computer: growing a vault, people, roles and collections

Proposed, 2026-10-16. Makes the first part of [ADR 4](0004-roles-and-collections.md) and
[ADR 6](0006-one-person-first.md)'s growing step concrete; the LAN host ([ADR 5](0005-lan-host-and-replicas.md))
comes later. Re-encrypting a collection when someone loses it, or when admin is taken away, is
replaced by key epochs in [ADR 17](0017-key-epochs-change-log.md).

## Context

A vault is made for one person (ADR 6), stored the way a team's will be: a key file with a list of
users, and a database with collections and grants (ADR 3). A studio or factory needs several
people on one install, each with their own password, an admin who decides who sees and changes
what, and a way back when someone leaves. ADR 3 and 4 say how keys and roles work; this record
decides the steps people take and what is built first.

## Decision

- **Growing is a step in Settings,** "Share this vault with others". The person gives the name
  they will be known by and becomes the first admin. The step makes the organization key pair
  and its recovery key, which is shown as a sheet to print and is checked like a person's. Every
  collection key is sealed to the organization key, so admins can open everything. Nothing is
  re-encrypted.
- **Collections:** the recipes and materials already in the vault become a collection named
  "Shared", and every person gets a private one. New recipes and materials go into a collection
  chosen when they are made; a revision stays in its record's collection.
- **Adding a person:** an admin gives a name and a one-time password to pass on. At their first
  sign-in the person chooses their own password and gets their own recovery sheet, so the admin
  never knows the password they use. Until then the account has no recovery key.
- **Unlocking** a team's vault starts by choosing a name from a list on the lock screen; the names
  are in the key file anyway (ADR 3). A one-person vault still asks only for the password.
- **Roles** are fixed sets of capabilities for now: Chemist (view recipes, materials and their
  chemistry), Formulator (also make, change and delete them) and Admin (everything, on every
  collection, including people, collections and backups). An admin gives a person a role on a
  collection, which seals its key to them. Since then, a Tester role and roles admins make
  (ADR 4).
- **Batch operator** is a fourth role, for weighing out. A formulator makes a recipe's **batch
  sheet**: its lines with each material named by an in-house code (M-104) instead, a name, and
  notes for the weighing. The sheet is its own record, of kind `batch`, in the recipe's
  collection, linked to the recipe and the revision it was made from, so the recipe shows when it
  has changed since. Batch sheets are encrypted with the collection's **batch key**, made from the
  collection's key with HKDF; a batch operator's grant holds only the batch key, which does not
  lead back to the collection key, so they can open the sheets and nothing else in it, whatever
  the app does. Everyone else derives the batch key from the collection key. Making someone a
  batch operator who held more gives the collection a new key, as taking a role away does. The
  codes are not kept in a list of their own: the formulator types them, and the app suggests the
  codes already used for each material on sheets they can read.
- **The core checks every command** against the person's capabilities on the record's collection.
  The UI hides what is refused, but does not decide.
- **Removing a person** takes them out of the key file and removes their grants. Every collection
  they could open, and the database, get new keys and are re-encrypted, since they may have kept
  the old ones. Their private collection stays, for admins, under "From name". An admin holds the
  organization key, which opens every collection key, so **taking admin away** gives the
  organization a new key pair and recovery key, seals it to the admins left, and gives every
  collection a new key sealed to it; the person keeps their roles, an admin grant becoming a
  formulator's. The collections' keys and the new organization key, as public and sealed parts
  only, go into the database in one transaction, then into the key file; an unlock finishes a
  change that stopped between them. Removing an admin takes admin away first. A new organization
  recovery sheet can be made for a lost one.
- **Lost passwords:** someone with their recovery sheet uses it as in a one-person vault. For
  someone who lost both, an admin gives them new keys and a one-time password, as when they were
  added; the admin holds every collection key through the organization key, so nothing else is
  needed from them. When every admin is locked out, the organization recovery key does the same
  for an admin of their choosing.
- **Backups and restoring:** only admins back up, since a backup holds every collection. A team's
  backup restores with an admin's password, or the organization recovery key. A team's vault on
  disk is replaced only by one of its own admins: a restore checks the vault already there, and
  switching to a set-aside vault needs an admin signed in to it.
- **Formats:** the key file gains an organization section and per-person fields (format 2), written
  only when a vault grows, so a one-person vault's files stay as they are. The database gains
  collection names, owners and roles (schema 3).
- **Going back to one person** (ADR 6) is a step for an admin: a backup goes in the vault's folder
  first, everyone else is removed, their private collections stay as "From name", the
  organization key goes, and every collection and the database get new keys. Roles are not
  remembered for growing again; the admin's private collection is.
- **Moving a recipe** to another collection takes its firings and batch sheets with it (the page
  names them; the core does not read content). Every revision and attachment is encrypted again
  under the new collection's key and bound to it, in one transaction, and needs the right to
  change records in both collections. This rewrites revisions in place, which is fine on one
  computer; with the LAN host a move becomes an event of its own that replicas apply. A
  material moves alone, by the same command; the page warns how many recipes outside the
  collection it goes to use it, since they find it by name.
- **Signing revisions and the audit log wait for the LAN host** (ADR 5). On one computer, anyone
  who could forge a revision or rewrite a log already holds the database key and their own
  signing key, so signatures there show little; with a host, the host checks each signature
  against keys the organization has signed, and keeps the log where a member cannot rewrite it.
  Both need the same organization-signed keys, so they are built with it.

## Consequences

- The admin who grows a vault holds the only organization recovery sheet until it is printed:
  losing both it and every admin's password loses every collection. The step says so, and the
  sheet must be checked before the vault opens again.
- A person added but never signed in can be locked out by a lost one-time password; an admin
  removes and adds them again.
- Re-encrypting a collection takes a moment per thousand revisions; removing a person shows a
  progress message.
- On one computer, a person with their key could change the database outside the app (ADR 4).
  Signatures, once added, make that visible.
