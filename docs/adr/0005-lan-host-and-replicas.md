# 5. Networking: a LAN host, and replicas that work offline

Proposed, 2026-10-14. Made concrete in stages: the directory as events
([ADR 18](0018-directory-events.md)), signatures ([ADR 19](0019-signatures-and-audit-log.md)), and
the host, replicas and what they send ([ADR 20](0020-sync-core.md)), which replaces "batch logs,
firing logs and notes are events".

## Context

In phase 2, other workstations use the vault over the LAN. The data stays on the industrial
user's own machine: there is no cloud and no hosted server. Someone may also take a laptop with
their part of the vault to a warehouse that has no network, work there, and bring the changes
back.

## Decision

- **One app, three modes:** standalone (one machine), host (also serves the LAN) and client.
  The host runs `hostd` (ADR 1) as a system service (launchd, a Windows service or systemd), so
  it is there from boot without anyone signed in. The app on the host machine is one of its
  clients.
- **A star:** the host is the one source of truth. Clients talk only to the host, never to each
  other, and nothing leaves the LAN.
- **Every client keeps a replica:** a local, encrypted vault with only the collections its users
  may read (ADR 3 and 4). The host decides what goes into it, so a client never receives what it
  cannot read. A workstation syncs all the time; a laptop syncs when it is on the LAN and works
  from its replica otherwise. It is one sync protocol for both.
- **Data as revisions and events:** a recipe is a chain of revisions that never change; an edit
  adds revision n+1 with n as its parent. Batch logs, firing logs and notes are events that are
  only added. Each batch log names the exact revision it was made from. Sync sends what the other
  side does not have, with the host's sequence numbers as the cursor, not clock times.
- **Conflicts:** events never conflict. When two people change the same recipe from the same
  revision, the host keeps both as a fork and asks a Formulator to choose: it never merges
  amounts, because a merged recipe is one nobody has tested. A recipe can also be checked out for
  editing, which locks it on the host, to avoid forks.
- **Pairing and transport:** an admin starts pairing on the host, which shows a short one-time
  code. The client enters it, and the two agree on keys with a PAKE (SPAKE2), so a short code is
  enough. The client then trusts the host's pinned certificate (TLS 1.3 with rustls), and the
  host registers the device's key. Admins can revoke a device.
- **Finding the host:** DNS-SD over mDNS (`_glazevault._tcp`), and a typed address for networks
  that block multicast or split machines into VLANs.
- **Offline limits:** an admin sets how long a replica may go without syncing (14 days, say), and
  what happens after that, for everyone or per role:
  - **Nag:** the app keeps working and says, on every opening and more firmly each day, how long
    it has been and that it should be synced.
  - **Soft cut-off:** the replica opens read-only, so batch sheets can still be read and printed,
    but nothing can be changed or logged until it syncs, or until an admin gives an extension
    code. The code is short enough to read over the phone, works for that device only, and for a
    set number of days; the app checks it offline with a secret it shared with the host when it
    was paired.

  Neither is a hard lock: the data on the laptop is protected by encryption and the user's
  password, not by the limit.
- **Updates on the LAN:** the host can keep the signed updates and hand them to its clients, for
  sites whose clients cannot reach the internet.
- **Phase 1 builds this model:** revisions, events and the replica's storage, so that phase 2 adds
  the transport, not a rewrite.

## Consequences

- The host has to stay on and awake. The installer adds a Windows firewall rule for `hostd`, and
  macOS asks once.
- A revoked laptop that is offline still has its replica until it next connects. The offline
  limit is a rule in the app, not encryption; the real protection is the user's password and
  that the replica holds only their collections.
- Work logged offline is never lost to a cut-off: whatever was recorded before the limit is kept
  and synced.
- Phase 3 mobile is another client of the same protocol.
