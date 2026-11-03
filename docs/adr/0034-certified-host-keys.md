# 34. The organization certifies the host's key

Proposed, 2026-11-03. Closes what [ADR 21](0021-transport-and-pairing.md) and
[ADR 22](0022-host-mode.md) left: "the organization does not yet certify the host key".

## Context

A computer trusts the LAN host by the key it pinned: from pairing, where SPAKE2 is bound to the
TLS session and the admin's computer has the host pinned already, or from the join package on the
host computer itself. Pairing is sound, but nothing in the vault says which host key the
organization meant. Anyone with a copy of a host's store and a new TLS key, or a host set up again
by hand, looks the same to a computer that is pairing as the real one does. Later work, such as
moving a host to a new computer, needs a host key the vault itself vouches for.

## Decision

- **A `HostCertified` event** (`host-certified`, schema 14 `host_certificates`) holds the host's
  Ed25519 TLS key, when it was issued, the organization signing key that issued it, and its
  signature over `glaze-vault v1 host-certificate vault {id} key {hex} issued {time}`. Only an
  admin may record one, with an organization key the vault lists now (`access::Directory::check`);
  the host checks it like any other event it is pushed.
- **`prepare_host` certifies the new host's key before it copies the store**, so the host and
  every computer that joins it get the certificate through the change log.
- **A certificate counts** when the organization key that signed it had not been retired when
  the certificate came in the change log, as for people's certificates (ADR 20). Taking admin away
  retires the old key, but certificates issued before that stay good, so nothing is issued again.
- **A computer requires it.** At the end of each pull (`apply_batch`, when the host has nothing
  more), a replica checks that the key it pinned is certified. If it is not, nothing from that
  pull is kept, and the sync fails with `host-not-certified`. A computer that joins now, and the
  host computer's own replica, require it from the start (`host_certificate` in `meta`).
- **Hosts from before.** A computer that joined before this trusts its pin until a certificate
  for that key comes, and requires one from then on. An admin signing in at any computer that
  syncs certifies the key that computer pinned (`certify_pinned_host`, at unlock, best effort
  like attesting), so an existing host is certified the first time an admin signs in after the
  update.

## Consequences

- A host whose key the organization never signed cannot bring a new computer in: pairing still
  works, but its first sync fails and keeps nothing.
- Until an admin signs in after updating, existing computers trust their pins as before.
- An admin's computer that paired with a wrong host would certify it at sign-in. Pairing checks
  the host by the code and the admin's own pin, so this needs the admin to have paired with it.
- Host certificates are never revoked yet; retiring a host key is part of moving a host.
- Schema 14.
