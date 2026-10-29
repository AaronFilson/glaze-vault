# 23. Client mode: joining, syncing in the background, checkouts, and photos in pieces

Proposed, 2026-10-29. Stage 7 of [the LAN host plan](../plans/phase-2-lan-host.md#7-staged-delivery),
on [ADR 20](0020-sync-core.md)'s sync core, [ADR 21](0021-transport-and-pairing.md)'s transport
and [ADR 22](0022-host-mode.md)'s host. Changes ADR 20's "a photo goes whole inside its item",
ADR 22's "the page syncs every 30 seconds", and adds a LAN suite to [ADR 11](0011-end-to-end-tests.md)'s
end-to-end tests. Schema 12.

## Context

Stage 6 left a host that an admin starts from the app, and other computers that could join it only
through the developers' client. What was left for workstations and laptops: joining from the app,
syncing without the page asking, knowing how the sync stands, photos that do not travel as one
32 MiB frame, a way to say "I am changing this", admin changes that cannot clash, and leaving.

## Decision

- **Joining** (Setup, "Join a vault on this network"): the app lists the hosts mDNS finds and takes
  a typed address (port 47917 if none is given), the code an admin reads out and this computer's
  name, which defaults to what the system calls it. It makes the computer's key first, and shows
  its fingerprint, which the admin's screen shows too. It waits until the admin approves, and the
  replica it joined is then locked, for its people to sign in with the passwords they have; the
  first sync brings what they may read. A failed attempt keeps the same key, so a fingerprint
  noted holds.
- **Syncing in the background** (`crates/app/src/syncing.rs`): a thread of the app's own, with its
  own runtime, syncs an unlocked replica every 30 seconds, within 5 seconds of something saved,
  and when the host has news; after a failed sync it waits 15 seconds before trying again for
  something saved. It takes the vault only while it handles each message (`net::sync_shared`), so
  the person keeps working through a sync. A second connection (`Watch`) hears `News` from the
  host whenever a computer pushes or checks something out, and every 50 seconds anyway; a host
  silent for two minutes has gone. One sync runs at a time; "Sync now" waits for it.
- **What the page hears**: `sync-status` (syncing, the last sync that worked, the last error,
  whether it hears the host, what waits to be sent, what the host would not take, photos still to
  come), only when it changes; and `vault-changed` when a sync brought something, after which the
  lists are read again and an editor with no unsaved edits moves on to its record's newest
  revision. The bar shows the status; Settings, Network, for anyone on a replica.
- **Photos in pieces** (plan section 3.7): an attachment travels without its bytes, which a
  signature over their hash still covers, and its bytes follow in pieces of 1 MiB (`GetChunk` and
  `Chunk`, `PutChunk` and `ChunkTaken`). A computer sends the bytes of the attachments in a push
  before the push, and the host stages them (`incoming_attachments`, by computer) and takes the
  attachment only when they have all come and match its hash, or refuses it with `BytesMissing`,
  which waits for the next push rather than being set aside. A computer fetches the bytes of what
  it pulled after pulling, newest first, up to 64 MiB a sync; the rest come in the next. Either
  side goes on from where a broken one stopped. A photo not here yet shows "Photo not synced yet"
  (`NotFetched`), and opens when a sync brings it.
- **Checkouts** (plan section 3.5, the plan's question 11): advisory, on the host only while it
  runs, eight hours each. "Check out" on a recipe, material or firing, by someone who may change
  it; each sync asks who has what. A computer that heard in the last two minutes refuses to save a
  record someone else has checked out (`CheckedOut`), until they release it or this person takes
  it over, which the audit log notes. The host never refuses a revision because of one, and a
  computer that has not heard from it lately saves as it would alone: work made apart becomes a
  fork, never lost. A checkout lost when the host restarts is simply taken again.
- **Changes to the directory need the host** (the plan's question 5): adding, removing or
  resetting people, roles, grants, admins, the organization's recovery key, and collections. On a
  replica the app holds the directory at the host (`LockDirectory`, one computer at a time, given
  up when its connection closes, waited for up to 30 seconds), syncs, makes the change, and syncs
  again before letting go, so two admins' changes cannot clash; without the host it says so
  (`NeedsHost`). This replaces ADR 20's "the replica stays apart until stage 7". The host does not
  yet refuse a directory change from a computer that did not hold the directory: the app always
  does.
- **Leaving** (Settings, Network, on a computer that is not the host): says how much never reached
  the host, then writes over the replica's files and removes them. The host computer stops serving
  instead.
- **Forks**: a fork's version listed first, on every computer, is the one the host took last, not
  the one with the latest clock; what this computer has not synced comes before all of it. The
  host refuses a resolution that sets aside another record's revision. Firings, mixes, batch
  sheets, limit sets and price lists show the fork notice too.
- **Finding the host again**: when a sync cannot connect, the app looks on the network for a host
  advertising this vault's tag (ADR 21) at another address, and keeps it if the sync then works.
- **The LAN suite** (`npm run e2e -- --suite lan`, `e2e/lan.ts`): the first app runs from `tauri
  dev` and serves through hostd as its child (`GLAZE_VAULT_HOST_NO_SERVICE`); the second runs the
  debug build it made, against the same Vite. An admin sets up, shares and serves the vault; the
  second computer joins with a code; a save shows on the other; a checkout stops a save until it
  is taken over. Going offline, erasing apart and revoking stay in the Rust tests (crates/core,
  crates/sync) until stage 8 brings revoking. CI runs it after the main suite on each system.

## Consequences

- Workstations and laptops join and sync by themselves, and the page no longer asks.
- A photo of 25 MiB no longer needs a 32 MiB frame, and a sync over a weak network goes on from
  where it broke off. Pieces are joined in memory once all have come, so a photo is held twice
  for a moment; rusqlite's incremental BLOB writes would avoid that.
- Older versions of the app refuse a vault at schema 12.
- The two apps of the LAN suite may share the webview's stored data on macOS, so its scenarios do
  not depend on it. It cannot run on a locked Mac, as the main suite cannot.
- Still to come, in stage 8: offline limits, revoking a computer and the lost-computer flow, and
  the host's backups. Also left: the host refusing directory changes from a computer that does not
  hold the directory, syncing photos on demand rather than all of them, and the host keeping and
  signing the audit log.
