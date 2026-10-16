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
