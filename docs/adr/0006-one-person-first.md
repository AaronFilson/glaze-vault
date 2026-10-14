# 6. One person first: a plain vault that can grow a team and shrink

Proposed, 2026-10-14.

## Context

Many users will be one person, a potter or a small studio, who needs a private place for recipes,
a calculator, and good printing and export. Admins, roles, collections, devices and a LAN host
(ADR 4 and 5) are what a factory needs, and they would bury that person. A studio can also grow
into a team and later shrink back to one person.

## Decision

- **A new vault is for one person.** Setting up asks for a password (twice), shows the recovery
  key and has it confirmed, and opens. There is no user name, role, collection or network on any
  screen. Unlocking asks only for the password.
- **Underneath, it is the same vault:** one user, who holds every key and can do everything, and
  one collection that the UI never names. So there is no second storage format and no separate
  code path to keep working.
- **Printing and export are first-class** for one person:
  - Print a recipe with its unity formula and analysis, or just a batch sheet for a chosen batch
    size with boxes to tick and a running total, on one page of Letter or A4.
  - Save as PDF through the system print dialog.
  - Export recipes and materials as CSV and JSON (with a warning that these are not encrypted),
    and the whole vault as an encrypted backup file that can be restored, or opened on another
    machine with the password or the recovery key.
- **Growing into a team** is a step in Settings. The person becomes the first admin. The step
  creates the organization key and its recovery key (to be printed and confirmed), seals every
  key to it, and then shows users, roles and collections. Nothing is re-encrypted.
- **Going back to one person** is a step in Settings for an admin. It shows what will happen:
  - Every other user and paired device is removed, and the LAN host stops.
  - Every other user's private collection is kept, under a "From name" heading, or exported, as
    the admin chooses.
  - Roles and collection boundaries are hidden again, but remembered, so growing back restores
    them.
  - The organization key is destroyed, so the remaining person's password and recovery key are
    once more the only ways in.
  
  An encrypted backup is made first, automatically.

## Consequences

- One code path serves both, so the access checks always run, even when they allow everything.
- People who leave when a vault shrinks lose access at once, but a copy they synced before is
  still readable with their old password, as with any revoked device (ADR 5).
- The user guide has a short path for one person and a separate part for teams.
