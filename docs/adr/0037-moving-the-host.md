# 37. Moving the host to another computer by its `.gvhost` file

Proposed, 2026-11-03. The follow-up "putting a `.gvhost` file on a new host computer, opened with
the organization's key" left by [ADR 25](0025-host-backups-from-the-app.md), and "retiring a host
key is part of moving a host" from [ADR 34](0034-certified-host-keys.md). No new schema.

## Context

A host could be backed up and put back on the same computer, but not moved: a host computer
being replaced, or one whose disk failed, left the team with replicas pinned to a host key that
no store anywhere could serve. ADR 25's `.gvhost` file already holds everything a host needs:
the database under the host's database key, `host.json` with that key sealed to the host's key,
and the host's key sealed to the organization's encryption key. Only the host computer, or
someone with the organization's key, opens it.

Each computer trusts the host by the TLS key it pinned (ADR 21), and from ADR 34 requires that
key to be certified. A new host with a new key would need every computer to take a new pin from
a server it has never met, and a way to say the old key is no longer the host's, which is a new
event and a new table.

## Decision

- **The key moves with the store.** The new host serves with the old host's key, opened from the
  file with the organization's key. Every computer's pin, and the certificate for it, hold as
  they are; computers find the new host by mDNS, as they find a host whose address changed
  (ADR 23). Nothing new is trusted, so nothing new can be forged.
- **The file**: from the app, Backups of the host, as before; or on the old host computer,
  `hostd export <file.gvhost>` (elevated), which needs no network and works while the service
  serves. The service may checkpoint its log while the export copies, so the database is not
  copied as it lies on disk: SQLite's backup API copies every page inside one read transaction,
  into a file under the same SQLCipher key, and that copy is hashed into the file.
- **On the new computer**: an admin's computer that syncs with the host has Settings, Network,
  "Move the host here". It asks for the file; `Vault::unpack_host_backup` checks it is this
  vault's, opens the host's key with the organization's key, writes the store into a staging
  folder (the database checked by its length and SHA-256, then by `PRAGMA quick_check`, since a
  hash only says the file is as it was written), opens it, and checks the key is the one this
  computer pinned and that this computer is in it, not revoked. A staging folder of the caller's
  must be empty, and on failure only what was written there is removed. The store gets a new generation, as a restore does (ADR 24), so each
  computer sends again what reached the old host after the file was made. The organization
  certifies the key if it never had been (a host from before ADR 34). Then hostd installs the
  staging folder as a service, as for a new host (ADR 22), and this computer's replica syncs with
  it on loopback. If the service does not start, or that first sync fails, the service is removed
  again (the file still holds the store) and this computer goes back to the old host's address,
  and the app says why. `dev-client unpack` does the same for tests and by hand.
- **A file older than a revocation.** Only the host keeps which computers are revoked; computers
  do not send that again after a new generation, so a file made before a revocation would let
  that computer sync again. An admin's computer remembers each revocation it sees, in a list of
  computers or one it makes (in `meta`, so no schema change). A file in which one of those is not
  revoked is refused (`host-backup-stale`) unless the admin chooses to use it anyway; then each of
  them is revoked again in the new store before it serves.
- **Stopping on a computer the host moved to** keeps the store. Its own vault is a replica with
  only its own people's key file entries and perhaps not every photo's bytes, so the host's store
  is the only whole copy: Stop serving there runs `hostd uninstall --keep-data`, and the admin
  moves it on by `hostd export`. The vault stays the host's replica.
- **The old host computer rejoins.** Its own vault is a replica over loopback, and is never moved
  to another address. Stop serving offers "the host is moving to another computer": the service
  goes with its store kept, and the vault stays a replica, marked retired. It, or a host computer
  whose service was removed by hand so that nothing answers on loopback, can then leave the vault
  (its copy goes, with the usual warning about what never reached the host) and join the new host
  with a code, as any computer does. Stopping without moving is as before: the store goes and the
  vault is on that computer alone.
- **Never two hosts.** The app refuses to move the host while the old one still answers at the
  address this computer knows (`old-host-serving`). The old host is retired by stopping it there:
  Stop serving in its app, or `hostd uninstall`. A host computer that is gone is retired already.

## Consequences

- A team whose host computer dies keeps its vault and its computers, with nothing to pair again,
  as long as an admin kept a `.gvhost` file or can reach the old disk; what reached the old host
  after the file was made comes back from the computers that sent it.
- A host file used anyway brings back what else only the old host kept: devices paired since are
  missing (they pair again), and offline extensions given since are gone.
- The old host computer's own work reaches the new host only by the file, or by leaving and
  joining again after it has synced; what it saved after the file was made and never synced is
  lost when it leaves, and the app says how much first.
- The host's key is the same on the new computer, so a host key that may have been stolen with
  the old computer is not replaced by moving. That needs a new key, a way for computers to take
  a new certified pin, and retiring the old key: an event and a table, so a schema change, left
  for later.
- If the old host is out of this computer's reach but still serves others, the app cannot tell;
  the admin is asked to stop it first. Computers that sync with both would each see the
  generation change and send their changes again, so nothing is lost, but they would go back and
  forth until the old one stops.
