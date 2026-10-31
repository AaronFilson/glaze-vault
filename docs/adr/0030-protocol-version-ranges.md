# 30. Protocol version ranges

Proposed, 2026-10-30. Stage 4 of [the phase 3 plan](../plans/phase-3-mobile.md#7-staged-delivery),
its section 3.5. Changes [ADR 21](0021-transport-and-pairing.md)'s single protocol version, where
a host refuses a computer that speaks another.

## Context

App stores review each phone release, for a day or for a week, and people update when they get
round to it. Desktops update themselves (ADR 7). So for days at a time a phone and its host may
run different releases. With one version each, a change to the protocol would cut every phone
off when the host updated, or the host off from the phones that updated first.

## Decision

- Each build speaks a range, `OLDEST..=PROTOCOL` (`crates/sync/src/proto.rs`). The hello carries
  both ends (`oldest` is new and optional, so a hello from before ranges reads as its one
  version), and the host takes the newest version both speak (`agree`), kept in the session for
  when messages come to differ. mDNS advertises both too (`proto`, `oldest`).
- **The rule for releases**: a release that raises `PROTOCOL` keeps `OLDEST` where it was, and
  speaks the old version as well; the release after may raise `OLDEST`. A host and a phone one
  release apart always meet.
- A refusal says which side to update: "this app is too old for the host", or "the host is older
  than this app: update Glaze Vault on the host computer".
- Today both ends are 1, so nothing on the wire changes but the new field, which hosts from before
  ignore.

## Consequences

- Each protocol change costs a release of speaking both versions, and the code for both until
  `OLDEST` moves.
- Tests: `agree`'s cases, an old hello read by a new host and a new hello by an old one, and a host
  letting in a newer computer at its own version (`crates/sync`).
