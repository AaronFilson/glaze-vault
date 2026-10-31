# Architecture decision records

Short records of the decisions that shape Glaze Vault: what was decided, why, and what it costs.
Each one is written once; a later change gets a new record that replaces the old one.

| No.                                      | Decision                                                               | Date       |
| ---------------------------------------- | ---------------------------------------------------------------------- | ---------- |
| [0001](0001-tauri-rust-react.md)         | A Tauri desktop app: Rust core, React and TypeScript UI                | 2026-10-14 |
| [0002](0002-chemistry-copy.md)           | Glazecalc's chemistry, copied in until it settles                      | 2026-10-14 |
| [0003](0003-encryption-and-keys.md)      | Encryption: SQLCipher, keys per collection, sealed to each user        | 2026-10-14 |
| [0004](0004-roles-and-collections.md)    | Access: roles granted on collections, enforced in the core             | 2026-10-14 |
| [0005](0005-lan-host-and-replicas.md)    | Networking: a LAN host, and replicas that work offline                 | 2026-10-14 |
| [0006](0006-one-person-first.md)         | One person first: a plain vault that can grow a team and shrink        | 2026-10-14 |
| [0007](0007-backups-locking-updates.md)  | Backups, export, locking by itself, and updates                        | 2026-10-14 |
| [0008](0008-materials-history-drafts.md) | Your own materials, earlier revisions, and drafts that outlast closing | 2026-10-15 |
| [0009](0009-deleting-and-erasing.md)     | Deleting, and erasing for good                                         | 2026-10-15 |
| [0010](0010-importing.md)                | Importing, formula materials, and renaming in recipes                  | 2026-10-15 |
| [0011](0011-end-to-end-tests.md)         | End-to-end tests through the development screen and driver             | 2026-10-16 |
| [0012](0012-teams-on-one-computer.md)    | A team on one computer: growing a vault, people, roles and collections | 2026-10-16 |
| [0013](0013-recipe-details-and-additions.md) | Recipe details, additions, and finding recipes                   | 2026-10-16 |
| [0014](0014-firing-log-and-photos.md)    | The firing log, and photos kept as attachments                         | 2026-10-16 |
| [0015](0015-chemistry-tools.md)          | Chemistry tools: line blends, limit formulas and costs                 | 2026-10-16 |
| [0016](0016-mix-log.md)                  | The mix log: batches as they were mixed                                | 2026-10-20 |
| [0017](0017-key-epochs-change-log.md)    | Key epochs, the change log and tombstones                              | 2026-10-20 |
| [0018](0018-directory-events.md)         | The directory as events, and shared access checks                      | 2026-10-21 |
| [0019](0019-signatures-and-audit-log.md) | Signed revisions, key certificates and the audit log                   | 2026-10-21 |
| [0020](0020-sync-core.md)                | The sync core: a blind host, replicas, and what they send each other   | 2026-10-21 |
| [0021](0021-transport-and-pairing.md)    | The transport and pairing: pinned keys over TLS, a code, and hostd     | 2026-10-21 |
| [0022](0022-host-mode.md)                | Host mode: hostd as a service, and the host computer's app as a replica | 2026-10-21 |
| [0023](0023-client-mode.md)              | Client mode: joining, syncing in the background, checkouts, and photos in pieces | 2026-10-29 |
| [0024](0024-offline-limits-and-revocation.md) | Offline limits, revoking computers, and the host's backups   | 2026-10-29 |
| [0025](0025-host-backups-from-the-app.md)     | The phase 2 leftovers: host backups from the app, and the rest | 2026-10-29 |
| [0026](0026-mobile-builds.md)                 | Mobile builds: the same app for phones and tablets             | 2026-10-30 |
| [0027](0027-phones.md)                        | Phones: the vault's folder, locking and what the page offers   | 2026-10-30 |
| [0028](0028-a-phones-own-vault.md)            | A phone's own vault, backed up by the phone's own backup       | 2026-10-30 |
| [0029](0029-phones-as-replicas.md)            | Phones as replicas: pairing by QR code, the local network      | 2026-10-30 |
| [0030](0030-protocol-version-ranges.md)       | Protocol version ranges                                        | 2026-10-30 |
