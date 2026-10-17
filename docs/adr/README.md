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
