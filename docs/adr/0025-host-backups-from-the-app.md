# 25. The phase 2 leftovers: host backups from the app, and the rest

Proposed, 2026-10-29. Finishes what [ADR 23](0023-client-mode.md) and
[ADR 24](0024-offline-limits-and-revocation.md) left for later in
[the LAN host plan](../plans/phase-2-lan-host.md): `RequestBackup` and restoring the host from the
app (the plan's question 12 and section 3.9), rules by role on screen, photos on demand (question
9), checkouts of every kind, the host guarding the directory, and resetting someone from a
computer without their key file entry. No new schema.

## Decision

- **The host's own backups, from an admin's computer**: `ListBackups` names the daily ones hostd
  keeps, and `RestoreBackup { name }` has it put one back. The host writes `restore-from` in its
  folder, as `hostd restore` does; hostd sees it within five seconds and stops, and the service
  manager starts it again, restoring before the store opens (ADR 24). Only a name from the list
  is taken, never a path.
- **A backup kept elsewhere** (`RequestBackup`): the host makes one now as one `.gvhost` file:
  `GVHOST01`, a JSON header, then the SQLCipher database as it is, still under the host's
  database key. The header has `host.json`, whose database key is sealed to the host's key, and the
  host's key itself sealed to the organization's encryption key (HPKE, as every sealed key), from
  the newest `OrganizationKeyAdded`; and the database's length and SHA-256. So the file opens with
  the host computer, or with the organization's key, and nothing else. The admin's computer
  fetches it in 1 MiB pieces (`GetBackupChunk`) to a file the person chooses, and the host removes
  its copy when the connection ends.
- **Putting a kept file back**: the admin's computer checks the file is this vault's and that its
  host key opens with the organization's key, then sends it in pieces (`PutBackupChunk`) and
  `RestoreSent`. The host takes it only if it is this vault's, all there by its hash, and opens
  with its own host key; it goes in among the backups as `backup-<made>-saved`, then back as
  above. `hostd restore` takes such a file too, on the host computer.
- **The directory, guarded**: over the network, the host refuses an event that changes people,
  roles or collections (all but certificates, organization keys, erasures and moves) from a
  computer that does not hold the directory, with `DirectoryNotHeld`, and the rest of its group
  with it. The replica keeps them waiting rather than setting them aside, and a sync with such
  changes waiting holds the directory for itself first. The app's admin changes hold it already
  (ADR 23), and sync while they do (`sync_holding`).
- **Rules by role**: Settings, Network lists a stricter rule for any role, built-in or an admin's,
  under the vault-wide one.
- **Photos on demand**: a computer that syncs can bring photos only when someone opens them.
  Opening a photo that has not come asks for it (`want_photo`) and syncs; with photos on demand
  only those asked for come, and otherwise those asked for come first. Kept in `meta`.
- **Checkouts** on batch sheets, mixes, limit formulas and price lists too; the core already took
  them for any record.
- **Resetting without the entry**: an admin's computer resets someone whose key file entry it does
  not have, from their name and whether they are an admin in the directory. The new entry is kept
  in this computer's key file marked `elsewhere` until it reaches the host, which sends it to their
  computers; nobody signs in with it here, and it goes once the host has it. So after a computer is
  lost, every one of its people is reset from the admin's computer.

## Consequences

- An admin can keep the vault's host safe without going to the host computer, and a team can
  recover from a host computer whose disk failed, as long as the host key is put back with the
  store; putting a `.gvhost` file on a new host computer, opened with the organization's key, is
  left for later.
- A replica's directory change made while the host was out of reach goes when it next reaches it;
  any record saved in a collection made then waits for it.
- Making someone an admin, or taking it away, from a computer without their key file entry still
  waits: it needs their entry's other parts, which only they or the host computer have.
- Left from the plan: the LAN update mirror, joining photo pieces with incremental BLOB writes,
  the host keeping the audit log, and a new organization recovery key reaching every computer.
