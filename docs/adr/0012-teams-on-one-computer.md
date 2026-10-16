# 12. A team on one computer: growing a vault, people, roles and collections

Proposed, 2026-10-16. Makes the first part of [ADR 4](0004-roles-and-collections.md) and
[ADR 6](0006-one-person-first.md)'s growing step concrete; the LAN host ([ADR 5](0005-lan-host-and-replicas.md))
comes later.

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
  collection, which seals its key to them. Batch operator, which needs materials named by in-house
  codes to keep the chemistry back (ADR 4), comes with that feature. Roles editable by admins come
  later.
- **The core checks every command** against the person's capabilities on the record's collection.
  The UI hides what is refused, but does not decide.
- **Removing a person** takes them out of the key file and removes their grants. Every collection
  they could open gets a new key and is re-encrypted, since they may have kept the old one. Their
  private collection stays, for admins, under "From name".
- **Backups and restoring:** only admins back up, since a backup holds every collection. A team's
  backup restores with an admin's password, or the organization recovery key.
- **Formats:** the key file gains an organization section and per-person fields (format 2), written
  only when a vault grows, so a one-person vault's files stay as they are. The database gains
  collection names, owners and roles (schema 3).
- **Later in this work, in order:** signing each revision with its author's key (ADR 4), the audit
  log, going back to one person (ADR 6), then the batch operator.

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
