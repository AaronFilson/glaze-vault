# 24. Offline limits, revoking computers, and the host's backups

Proposed, 2026-10-29. Stage 8 of [the LAN host plan](../plans/phase-2-lan-host.md#7-staged-delivery),
its sections 3.9, 3.11 and 3.12, and the last of phase 2. Makes [ADR 5](0005-lan-host-and-replicas.md)'s
offline limits concrete, and adds backups in host mode to [ADR 7](0007-backups-locking-updates.md).
Schema 13.

## Context

[ADR 23](0023-client-mode.md) left computers that join, sync and work apart. ADR 5 asked for three
more things before a team relies on them: a limit on how long a computer may drift from the
others, a way to take out a computer that is retired or lost, and backups of the one store every
copy comes back to.

## Decision

- **The rule** (the plan's question 10) is the directory's, an `OfflinePolicySet` event an admin
  makes, through the host as any directory change is: remind after `nagDays` without a sync (14
  by default), and stop taking changes after `limitDays` (never, by default). A role can have a
  stricter rule (`byRole`); a person's is the strictest of their roles'. Days run from 1 to 365,
  and changes stop no sooner than the reminder starts. Settings, Network has the vault-wide rule;
  rules by role have no screen yet.
- **What counts as synced**: a sync that pulled everything and left nothing waiting to be sent.
  The replica keeps when that was by its own clock, and the latest time its clock has shown; a
  clock more than a day behind that counts as too long. The host computer's own app, which syncs
  over loopback, is not held to the rule.
- **Too long** is enforced in the core, not the page: `Vault::writable()` refuses saving,
  deleting, erasing, moving and adding photos with `OfflineTooLong`. Reading, printing and drafts
  go on, so nothing typed is lost. Changes to the directory need the host anyway (ADR 23). The
  page shows a reminder that says when changes will stop, then that they have.
- **Extension codes**: an admin's computer asks the host for one for a computer and a number of
  days (1 to 99); the host makes it under the secret it and that computer share. `14-K7Q-F9M2D-XW3PA`
  is the days, the day it was issued as three Crockford base32 characters (days since 1970, which
  wrap every 89 years), and 50 bits of HMAC-SHA256 over
  `glaze-vault v1 extension device {id} issued {day} days {n}`, in ten more. The computer takes it
  offline and takes changes until that day plus the days given; a code also settles a clock set
  back.
- **The offline secret** is HMAC-SHA256 under the SPAKE2 key of pairing, of
  `glaze-vault v1 offline-secret` (ADR 21): neither side sends it. The host keeps it with the
  computer (`devices.offline_secret`), the replica in `meta`, inside SQLCipher. Someone with the
  replica and their password could take it out and make their own codes: the limit is a rule in
  the app, not a lock, as ADR 5 says, and the guide says so.
- **Revoking** (plan section 3.11), from the computers paired list, for an admin, never the
  computer asking:
  - *Retired*: the host marks it revoked, tells watching computers there is news, and drops its
    checkouts. At its next sync the host's welcome says so, and the app writes over and removes
    its copy (the plan's question 7), then shows Setup with a note.
  - *Lost or stolen* (the plan's question 8): the same, marked lost; then the admin's computer,
    holding the directory at the host, gives a new key epoch to every collection any of its people
    could read (all of them for an admin's), and resets each of its people but this admin, with a
    one-time password the screen shows to pass on. Only people whose key file entries this computer
    has can be reset here (ADR 20): the screen names the others, to reset from the host computer.
    Until it reaches the host the lost computer still opens with its people's passwords, as ADR 5
    says.
- **Backups in host mode** (the plan's question 12): hostd copies the store, still encrypted, into
  `backups/` in its own folder a minute after it starts and each day after, keeping 14. A copy is
  the database and `host.json`; it opens with the host's key, which stays where it is. Computers
  do not back up a vault that syncs: the host does.
- **Restoring the host** (plan section 3.9): `hostd backups` lists them, and `hostd restore
  <folder>`, as an administrator, puts one back. A running service is asked to by a file in its
  folder, and stops; the system's service manager starts it again, and it restores before it opens
  the store. The store gets a new `generation`, which every welcome carries. A computer that sees a
  new one pulls everything again and sends again what its own people saved; the host takes what it
  has as it would a push sent twice. What only others' computers had comes back from them in turn;
  what was erased on a computer stays erased there.
- **Tests**: the codes and the rule by role in crates/core's own tests; a computer away too long,
  a code from the host, a clock set back, retiring and losing computers, and a restore that
  computers fill in again, with one host and replicas in one process; the secret from pairing and
  revoking over TLS in crates/sync; and in the LAN suite, Ana retiring Ben's computer, whose copy
  goes.

## Consequences

- Phase 2 is built: a team can serve a vault on its network, work apart on laptops, and take out
  a computer that goes astray.
- A computer revoked while it is away keeps its copy until it reaches the host again: the real
  protection on a lost laptop is its people's passwords, and that it holds only what they read.
- Computers paired after the backup that was restored cannot sync, and pair again.
- An admin's computer downloading a backup of the host (`RequestBackup`), and the app restoring
  one, wait: for now the host's backups are on the host computer, for an administrator there.
- Rules by role, and an admin's computer resetting someone whose key file entry it does not
  have, have no screen yet.
- Older versions of the app refuse a vault at schema 13.
