# 36. Photo pieces in place, more of the audit log, and phones that find the host

Proposed, 2026-11-03. Three follow-ups from docs/follow-ups.md: joining photo pieces with
rusqlite's incremental BLOB writes ([ADR 23](0023-client-mode.md)), noting more in the audit log
and showing the signatures of attachments ([ADR 19](0019-signatures-and-audit-log.md)), and
discovery on phones, which [ADR 29](0029-phones-as-replicas.md) left out.

## Context

A photo travels in 1 MiB pieces (ADR 23). The pieces wait in `incoming_attachments` until the last
one comes; then the replica, or the host for a photo a computer sent, read them all into one
buffer, hashed it and stored it. The host read a piece to send with `substr`, which loads the
whole BLOB first. A 25 MiB photo sat whole in memory each time, more than once on the way in.

The audit log noted opening recipes, materials, batch sheets and firings. Mixes, limit sets and
price lists hold the same kind of work, and were not noted. Every attachment is signed, with the
hash of its bytes, but nothing showed the signature.

Phones could pair only by QR code or a typed address: `browse` returned nothing on a phone, as
`mdns-sd`'s own multicast sockets need an entitlement on iOS and a multicast lock on Android.
Without discovery a phone also could not find its host again when the host's address changed.

## Decision

- **Pieces go into the BLOB where they belong.** Once the last piece is in, its hash is read from
  the waiting pieces a row at a time. If it is the hash the signature covers, the attachment's
  ciphertext is made with `zeroblob` at its full length and each piece is written into it with
  rusqlite's incremental BLOB I/O (`blob_open`, the `blob` feature). The host does the same for a
  photo a computer sent in pieces: `check_attachment` takes the hash of the bytes rather than the
  bytes. A piece to send is read with `blob_open` too, from its offset only. No schema change.
- **Opening a mix, a limit set or a price list is noted**, as opening the other records is: once a
  sign-in, by the page (`useOpened`, now in `ui/useOpened.ts`). A price list counts as opened when
  Settings shows it, not when a recipe's cost uses it. The audit log screen and its CSV already
  name every kind.
- **A photo shows its signature** under it in the firing log, worded as a revision's history words
  one: in a team, who added it; a key no admin has certified yet; or a warning when it does not
  check. `Vault::attachment_signed` checks the signature over what is known of the attachment and
  its hash, and, once its bytes are here, that they have that hash, read from the BLOB a piece at
  a time. A photo kept before attachments were signed says nothing.
- **Phones find hosts.** Android browses with `mdns-sd`, as desktops do, now built for Android.
  The app holds a Wi-Fi multicast lock while it is on screen (`MainActivity.onResume`, let go in
  `onPause`), with `CHANGE_WIFI_MULTICAST_STATE`; `crates/app/mobile/patch.cjs` adds both.
  `NEARBY_WIFI_DEVICES` is not needed: it is for Wi-Fi Direct and Aware, not multicast. iOS asks
  the system's Bonjour through `dns_sd.h` (`crates/sync/src/net/dnssd.rs`): browse, resolve and
  look up addresses, polled until the wait is over. That needs only the
  `NSLocalNetworkUsageDescription` and `NSBonjourServices` (`_glazevault._tcp`) that ADR 29 put
  in `Info.plist`, not the multicast entitlement. Only desktops advertise.
- **Discovery only fills in the address.** Joining a host found this way still takes the pairing
  code, which proves the host by SPAKE2 (ADR 21), and the fingerprint check. The QR code stays,
  and is still the only way that pins the host's key before pairing. Once joined, the host's key
  is pinned, so a host found again at a new address by its vault tag is used only if it has that
  key. The join screen on a phone says that a found host still needs the code.

## Consequences

- A photo is never whole in memory on its way into a vault, or out of the host. Sending one from
  a computer still reads it whole, as the push carries the item with its bytes.
- Phones find their host again when its address changes, as computers do, on networks that let
  devices find each other. The guide's advice to give the host a fixed address now covers
  networks that do not.
- The Bonjour code is tested on macOS, where the same `dns_sd.h` finds a host `mdns-sd`
  advertises; that test needs a network that carries multicast, so it is not in the usual run.
- Not tried on a phone: Android's multicast lock and `mdns-sd` there, and Bonjour and the local
  network prompt on iOS. The CI builds `glaze-vault-sync` for both.
