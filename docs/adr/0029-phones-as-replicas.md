# 29. Phones as replicas: pairing by QR code, the local network, and a phone's name

Proposed, 2026-10-30. Stage 4 of [the phase 3 plan](../plans/phase-3-mobile.md#7-staged-delivery)
(its sections 3.1 to 3.4), on [ADR 23](0023-client-mode.md)'s joining and
[ADR 21](0021-transport-and-pairing.md)'s pairing. Notes [ADR 5](0005-lan-host-and-replicas.md)'s
"Phase 3 mobile is another client of the same protocol": it is, with nothing changed in the core
or `hostd`. The protocol's version ranges, also stage 4, are [ADR 30](0030-protocol-version-ranges.md).

## Context

A phone joins a host the way a laptop does, but typing an address and an eight-digit code on a
phone is slow, and a phone cannot find the host the way a desktop does: `mdns-sd` opens multicast
sockets of its own, which iOS allows only with an entitlement Apple grants on request (ADR 26).
iOS also asks the person before an app reaches the local network, and once refused, connections
just fail. A phone has no `hostname`, so ADR 23's suggested name was "A computer".

Comparing fingerprints by eye, as ADR 23 asks, is the step people skip. A wrong host on the same
network would be caught only by that.

## Decision

- **A QR code on "Pair a computer"**, beside the code, holds
  `glazevault:pair?a=<addresses>&k=<host key>&c=<code>`: the host's addresses with ports, its
  whole Ed25519 key (base64url, 32 bytes) and the pairing code (`net::Invite` in
  `crates/sync/src/net/invite.rs`). The app draws it as SVG (`qrcode`, no image crates). When the
  host is the admin's own computer, which syncs over loopback, the address is the one this
  computer has on its network, found by the route to an outside address with nothing sent.
- **Scanning** on phones uses `tauri-plugin-barcode-scanner`, a dependency on phones only, with
  its permissions given as a capability the app adds when it starts on a phone
  (`crates/app/mobile/capabilities/scanner.json`), since a desktop build has no such plugin to
  check them against. On Android the plugin's camera is marked not required, so devices without
  one still install it and type the code.
- **The scanned key is pinned before pairing** (`net::pair`'s `expect`): TLS refuses any other
  host, so a wrong one is turned away before the code is tried, and the code is not spent. Each
  address in the code is tried in turn, and the next only when the last could not be reached.
- **The typed path stays**, for a computer, or a phone whose camera was refused.
- **iOS's local network question**: `NSLocalNetworkUsageDescription` says why, and
  `NSBonjourServices` names `_glazevault._tcp` for when phones browse (below), both with the
  camera's reason in `crates/app/Info.ios.plist`, which Tauri merges into the app's. The join
  screen says what is about to be asked, before it is. A refusal cannot be read by the app; a
  connection that fails on iOS says that a "no" is the likely reason and where to change it
  (Settings, Privacy & Security, Local Network).
- **No discovery on phones yet.** The plan's system browsers (`NWBrowser` on iOS, `NsdManager` on
  Android) need a native plugin each that no phone or simulator here can try, and the QR code
  carries the address anyway. `browse` keeps returning nothing on phones. The guide asks admins to
  give the host a fixed address, so a code scanned once keeps working.
- **A phone's name**: Android's model (`getprop ro.product.model`, such as "Pixel 8"); on iOS
  "An iPhone" or "An iPad" from `uname`, as the phone's own name needs an entitlement since
  iOS 16. The person can change it before joining, as on a computer.

## Consequences

- A replica pins the host's key from the first byte when it joined by QR code, rather than after
  a person compared fingerprints. The admin still checks the phone's fingerprint before approving.
- A host whose address changes leaves joined phones unable to sync until it is back, since they
  cannot look for it; desktops find it by mDNS. Fixed addresses, or phone discovery later, fix it.
- The CI's iOS job checks the built app's Info.plist has the three keys, and the Android job that
  the camera is optional.
- Not tried on a phone: the scanner, the permission prompts, and the phone's name.
