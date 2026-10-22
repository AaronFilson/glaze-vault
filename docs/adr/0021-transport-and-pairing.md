# 21. The transport and pairing: pinned keys over TLS, a code, and hostd in the foreground

Proposed, 2026-10-21. Stage 5 of [the LAN host plan](../plans/phase-2-lan-host.md#7-staged-delivery),
its section 4: the network around [ADR 20](0020-sync-core.md)'s sync core. Settles the plan's
open choice between raw public keys and rcgen, and the default port.

## Context

ADR 20 left the host and replicas talking through frames passed in one process. What was left was
a connection between computers that a stranger on the LAN can neither read nor join, a way for a
new computer to join with nothing but a code an admin reads out, a way to find the host, and a
program that serves.

## Decision

- **TLS 1.3 with raw public keys** (RFC 7250), not X.509: rustls 0.23 supports them with `ring` on
  both sides, so rcgen is not needed. Each side shows an Ed25519 key. rustls is built without its
  default features, so `aws-lc-rs` (CMake and NASM on Windows) stays out of the tree.
- **The host's key** comes from its X25519 secret by HKDF (`glaze-vault v1 host signing-key`), so
  `host.key` holds nothing new. A computer pins it: the join package carries it, and a replica
  keeps it in `meta`. A computer refuses any other host key during the handshake.
- **A computer's key** is the Ed25519 key it made to join ([ADR 20](0020-sync-core.md)), from the
  replica's `meta`, so it can connect only while someone is signed in. The host takes any key that
  signs the handshake, and then looks it up: a known computer may sync; an unknown one may only
  pair. This differs from the plan's "no client certificate while pairing": the new computer
  shows the key it is about to be certified for, so pairing ties that key to the session too.
- **Pairing** (plan section 4.3):
  - An admin's computer, connected and greeted, sends `StartPairing`; the host makes a code of 8
    digits, `4821-0937`, good for 10 minutes and one attempt. One pairing is open at a time; a new
    one replaces it.
  - The new computer connects without a pin and runs SPAKE2 (`spake2`, Ed25519 group) with the
    code, as `"glaze-vault device"` to the host's `"glaze-vault host"`. Each side's confirmation is
    an HMAC-SHA256 under the SPAKE2 key over the TLS exporter value (`glaze-vault v1 pairing`), the
    computer's first. A man in the middle has a different TLS session with each side, so he fails
    it even knowing the code. A wrong code ends the pairing; so does a computer that leaves before
    it confirms.
  - The computer sends its id and name with its confirmation. The admin's computer, waiting on
    `AwaitPairing` on its own connection, gets the name and key, shown with a fingerprint (the
    first 8 bytes of SHA-256, `428b-ec49-9b19-3bd5`), and sends `ApproveDevice` with a certificate
    for the people it chose. The host adds the computer and sends it its join package, which it
    checks names the host key it saw, and joins.
  - `certify_device` checks the people against the directory, not the key file: an admin's own
    computer holds only its own people's entries.
- **Framing** is ADR 20's: a 4-byte length and CBOR, at most 32 MiB, read from the stream in
  pieces. No `tokio-util` codec was needed.
- **Discovery**: `mdns-sd` (pure Rust, no Bonjour or Avahi), without its default features.
  `_glazevault._tcp`, TXT `proto=1` and `vault=` the first 8 bytes of SHA-256 of the organization's
  signing key, in hex.
- **Port 47917** by default, or `port` in `host.json`, or `hostd run --port`.
- **`crates/hostd`**: `hostd run <host-dir> [--port N] [--name NAME] [--no-mdns]`, in the
  foreground, logging to standard error, stopping on Ctrl-C. The server shares the host's store
  between connections behind one lock, held only while a message is handled; a handshake gets 15
  seconds and a quiet connection 2 minutes. `examples/dev-client.rs` is for developers only:
  `make-team`, `prepare`, `join-local`, `sync`, `pair-start`, `pair`, `discover`.
- **Crates**: `spake2` `=0.5.0-pre.0`, pinned exactly, as it is the only release on
  `curve25519-dalek` 5, which the tree already has from `x25519-dalek` and `ed25519-dalek` (0.4
  would compile a second copy, version 4). `tokio`, `tokio-rustls`, `rustls`, `hmac` and `sha2`
  were in the tree already.
- **Tests** run a server on loopback: syncing with the pinned host, pairing with a code end to
  end, a wrong code ending the pairing, only an admin's computer starting one, and the host
  refusing an unknown key while computers refuse an unpinned host.

## Consequences

- Developers can run a host and pair and sync computers by hand.
- The organization does not certify the host key yet: a computer trusts it from pairing, or from
  the join package when it joins on the host computer itself. Stage 6 certifies it at conversion.
- The offline secret from the SPAKE2 key (plan section 3.12) is not derived or kept yet: stage 8,
  with the offline limits that use it.
- Replicas made before this have no host key and must join again; none were in use.
- Database work runs on the runtime's threads under the lock. That is fine for a LAN's few
  computers; a busy host would move it to blocking threads.
- No schema change.
