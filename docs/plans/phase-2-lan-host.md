# Phase 2: the LAN host and offline replicas

Draft for review, 2026-10-20. Nothing here is built yet. It is based on the code at `b89c274`
(schema 6, key file formats 1 and 2) and ADRs 1 to 15, plus branch `10-20-1`, which adds the mix
log (ADR 16, `Kind::Mix` under the batch key) and takes schema 7. So this plan's schema numbers
start at 8 and its new ADRs at 17. Where it is not sure what the code or a crate does, it says so.

Decisions for Aaron are in [section 8](#8-open-questions-for-aaron), each with a recommended
default. On 2026-10-20 Aaron accepted every default. Stages 1 to 4 are built
([ADR 17](../adr/0017-key-epochs-change-log.md), [ADR 18](../adr/0018-directory-events.md),
[ADR 19](../adr/0019-signatures-and-audit-log.md), [ADR 20](../adr/0020-sync-core.md)), so the
later ADRs here are numbered from 19.

## Summary

- Make the vault append-only first, on one computer, before any networking. Today, rotating a key, moving a record and the summaries change-over rewrite revision rows in place. Erasing a record leaves no trace. Grants, roles and collections are rows that get changed and deleted. Sync cannot be built on top of that.
- Rotating a collection's key starts a new **key epoch** and no longer re-encrypts what is already stored. Older keys are chained under the newer ones. With this, a revision's bytes never change, so signatures and sync stay simple. It is also a speed-up you get now: removing a person no longer re-encrypts the whole collection. This changes part of ADR 3 and ADR 12.
- Every change to people, roles, collections and grants becomes a **directory event**, and one `apply` function writes it to the tables. On one computer the vault makes the event and applies it. On a host, `hostd` checks the event and applies it. On a replica, the replica applies what the host sends.
- **The host is blind.** `hostd` holds its own SQLCipher key but no collection keys. It decides what each device gets, and what it accepts, from metadata alone (collection, kind, grant level, author, signature). A stolen host disk shows who did what and when, but no recipe.
- Revisions, attachments and events are signed with Ed25519 keys. Each signing key is derived from the person's (or the organization's) existing X25519 secret, so the key file needs no new secrets. The organization certifies each person's keys and each device. The audit log is a hash chain, kept on the host.
- Transport is TLS 1.3 (rustls with `ring`, both already in Cargo.lock) with pinned keys. Pairing uses SPAKE2, bound to the TLS session. Discovery uses `mdns-sd`. Messages are length-prefixed CBOR frames.
- Delivery is 8 stages. Stages 1 to 3 are core-only and useful on one computer. Networking starts in stage 4.

---

## 1. Gap analysis

### 1.1 How data is stored today

Each vault folder holds two files, plus SQLCipher's WAL files:

- `vault.keys` (`crates/core/src/keyring.rs`) is JSON:
  - users, each with Argon2id parameters, the private key under the password and under the recovery key, and `database_key` sealed to them (HPKE);
  - for admins, `organization_key` (the organization's X25519 secret, sealed to them);
  - the `Organization` section: the organization's public key, its private key under the organization recovery key, and the database key sealed to the organization.
- `vault.db` is SQLCipher with a random key. The migrations are in `crates/core/src/store.rs` (`MIGRATIONS`, 7 entries since the mix log, so `user_version` is 7; entry 7 changes no table):
  - `meta(name, value)`: `vault_id`, `default_collection`, `summaries`, `last_backup`, `settings <user>`, `draft <user>` (XChaCha under the owner's private collection key), and `PENDING_ORGANIZATION`.
  - `collections(id, created_at, name, owner_id)`: names are in the clear inside SQLCipher.
  - `grants(user_id, collection_id, enc, ciphertext, role)`: the collection key, or the batch or summary key made from it (`Held`), sealed to the user with `grant_info`.
  - `organization_grants(collection_id, enc, ciphertext)`.
  - `revisions(id, record_id, kind, parent_id, number, collection_id, author_id, created_at, nonce, ciphertext, deleted, summary_nonce, summary)`. Content is under `kind_key()`: batch sheets under `batch_key`, firings under `summary_key` once summaries are on, everything else under the collection key. The AAD (`revision_aad`) binds id, record, kind, collection, number, parent and the deleted flag. A recipe also keeps a summary under `summary_key`.
  - `attachments(id, record_id, kind, collection_id, media_type, size, author_id, created_at, nonce, ciphertext)`, up to 25 MiB each, stored inline as a BLOB.
  - `roles(id, name, changes, may, created_at)`.
- The `Vault` struct (`crates/core/src/vault.rs`) is synchronous and owns the single `rusqlite::Connection`. The app keeps it in `Mutex<Option<Vault>>` (`crates/app/src/lib.rs`, `AppState`).

### 1.2 What already fits ADR 5

| Thing | Where | Why it fits |
| --- | --- | --- |
| Revision chains | `Vault::add_revision` | Revisions are only inserted. Each has a client-made UUID, `parent_id` and `number`, so ids from different replicas never clash. |
| Delete | `Vault::delete` | It adds a revision with `deleted = 1`, bound in the AAD. |
| Restore | `Vault::save` after a deleting revision | Also an added revision. |
| Attachments | `attachments.rs` | Never changed in normal use, and bound by AAD to id, record, kind, collection and media type. |
| Forks | `Vault::newest` | Forks are already possible: `add_revision` does not check that the parent is a head. `newest` notices two heads and shows the newer one. |
| Separation by kind and key | `kind_key`, `Held`, summaries | The host can decide what to send from the `kind`, `collection_id` and `summary` columns, without decrypting anything. This is what makes a blind host possible. |
| Finishing a change on the next unlock | `PENDING_ORGANIZATION`, `previous_database_key` | Good patterns to reuse for crash-safe conversion and sync steps. |
| Materials | `Kind::Material` | Ordinary revision chains, so they sync like recipes. |
| Firings | `Kind::Firing` (ADR 14) | Records with revisions, not events. That still syncs. Forks are rare (two people editing one firing). |
| Mixes | `Kind::Mix` (ADR 16) | The same, under the batch key. A slip's readings over days are later revisions, so a mix edited on two laptops forks like a firing. |

### 1.3 What does not fit

| Today | Where | Problem | Change |
| --- | --- | --- | --- |
| Rotating a collection key re-encrypts every revision, summary, attachment and draft in place | `team.rs` `rotate_collection_key_for` (`UPDATE revisions SET nonce, ciphertext`) | Rows change under the same id. Replicas would need everything again. Signatures over ciphertext would break. | Key epochs (§3.4). |
| Moving rewrites `collection_id` and the ciphertext in place | `moving.rs` `move_records` | Same problem. People who can read the old collection but not the new one must lose the record. | A move becomes an event that replaces envelopes. Replicas that cannot read the target get a "gone" notice (§3.6). |
| Summaries change-over rewrites firings and adds summaries | `summaries.rs` `change_to_summaries` | A one-time rewrite. | Make it a precondition for becoming a host. No replica ever sees a vault from before summaries. |
| Erase is a hard `DELETE`, then `wal_checkpoint` | `Vault::erase` | Leaves no tombstone, so an offline replica would bring the record back. | An `erased` table plus an event (§1.4). |
| `author_id` and `created_at` are not in the AAD | `revision_aad` | Anyone holding the database key can change who saved a revision, or when. | Revision signatures cover them (§5). |
| Heads are ordered by `created_at` | `newest`, `history` | That is the client's clock. | Order by host sequence where there is one. A fork is resolved by a revision that supersedes the other heads. |
| No sequence numbers | — | No cursor. | A `changes` table (§3.2). |
| Grants are deleted and re-inserted. Roles are updated and deleted. Collections are renamed in place. | `team.rs`, `roles.rs` | Mutable rows. The host cannot replay them, and replicas cannot learn about them. | Directory events plus one `apply` (§3.3). |
| People live in the key file | `Keyring.users` | `database_key` in it belongs to one database. On a replica it must be that replica's own key. | Each store keeps its own key file. People's entries travel as directory events. Each store seals its own database key to the people it holds. |
| Database-key rotation on removing a person | `rotate_database_key` | A vault-wide step today. | Becomes local to each store. The host and each replica rotate their own key when a person leaves that store's key file. |
| Access checks are mixed in with key handling | `Vault::editable`, `managed`, `admin`, `may_change`, `capabilities`, `held`, `set_role`'s manager rules | The host has no keys. It needs the same checks over metadata. | Move the checks into pure functions in `access.rs` (§2.4). |
| Names must be unique (materials, ADR 8; people; roles) | `checked_name`, `role_name`, the material name check in the UI | Two offline replicas cannot keep a name unique. | People and roles: admin changes need the host (open question 5). Materials: the host accepts both and flags a name clash, and the UI asks someone to rename one (§3.5). |
| No events table | — | ADR 5's "batch logs are events" has nothing to map onto. Batches as mixed are now records with revisions (`Kind::Mix`, ADR 16), as firings are. | Events are only for the directory, erasures, moves and the audit log. ADR 5 needs changing to say so. |
| Drafts, settings and `last_backup` live in `meta` | `vault.rs` | They belong to one machine. | They stay local and never sync. Settings would be nice to sync later (follow-up). |
| No signing keys, no audit log | — | Deferred in ADR 12. | §5. |

### 1.4 Erasure (ADR 9) with replicas

- `Vault::erase` still needs the record to be deleted first, and the right to change that kind of record in its collection. It also now writes:
  - `erased(record_id, kind, collection_id, erased_at, by)`;
  - an `Erased` event;
  - a row in `changes`.

  It then deletes the revisions and attachments and runs `wal_checkpoint(TRUNCATE)`, as it does today.
- The host accepts an erase only if every head of the record is a deleting revision. An erase from an offline replica, for a record that someone else changed meanwhile, is refused with `ChangedElsewhere`. The person sees "Changed on another computer since you deleted it".
- The host sends `Erased` to every device that can read the collection, at any level. A replica deletes the rows, runs `secure_delete` and checkpoints.
- The host keeps the tombstone for good. If a push contains a revision or attachment of an erased record, the host refuses it with `Erased`, and the replica drops it locally. A replica also keeps tombstones, so a host restored from an older backup does not get the record back from it (§3.9).
- Backups made before the erase still hold the record, as ADR 9 says. So does a revoked laptop that never connects again. The question shown before erasing should say so.
- The audit log keeps "erased record R, kind, collection, by whom, when" with ids only, no content.

---

## 2. Architecture

### 2.1 Crates

```
crates/core    glaze-vault-core   sync Rust, no IO beyond SQLite and files; no tokio
  vault/...      as today, plus epochs.rs, events.rs, forks.rs, audit.rs, replica.rs
  access.rs      pure policy checks over metadata (used by Vault and HostStore)
  signing.rs     Ed25519 keys derived from X25519 secrets, certificates, signed payloads
  host.rs        HostStore: the blind host's store; validate, apply, assign seq, filter
crates/sync    glaze-vault-sync   wire types, sans-IO sessions, and the tokio/rustls transport
  proto.rs       message enums, PROTOCOL version, CBOR framing
  session/       host_session.rs and client_session.rs: state machines over messages
  net/           tls.rs (pinned keys), pair.rs (SPAKE2), discover.rs (mDNS), conn.rs
crates/hostd   glaze-vault-hostd  binary: `run`, `install`, `uninstall`, `status`
crates/app     the Tauri app: client mode, host setup, background sync task
```

Why this split:

- **Host checks stay in core.** ADR 4 says every LAN request goes through one access check in `crates/core`. `HostStore` lives in core and calls the same `access.rs` functions as `Vault`.
- **Core stays free of tokio,** so `cargo test -p glaze-vault-core` stays fast and simple.
- **Sessions in `sync` are sans-IO.** They take messages in and give messages out, so in-process tests can run a host and two clients without sockets.
- **`hostd` is a separate binary** (ADR 1, ADR 5). It runs from boot with nobody signed in, survives the app being closed, and holds no webview. It is shipped inside the app's installer as a Tauri sidecar (`bundle.externalBin`, which needs files named with the target triple). CI builds it before `tauri build`.

Process layout on a host machine:

```
[hostd service] --TLS 127.0.0.1--> [Glaze Vault app on the same machine: a replica]
      ^  ^
      |  +--TLS LAN-- [workstation app: replica]
      +-----TLS LAN-- [laptop app: replica, sometimes offline]
```

ADR 5 says the app on the host machine is one of the host's clients. I recommend it be a real replica over loopback, not a second connection to the host's database file. That keeps one code path, and `hostd` stays the only writer to the host store. (Today `back_up` assumes the app holds the only connection.)

### 2.2 The blind host

- `hostd` has a host secret: 32 random bytes in `host.key` in its data folder. It derives an X25519 key pair (to open the host store's database key) and an Ed25519 key pair (its TLS identity, and for signing `Welcome` messages and audit checkpoints).
- The host store's SQLCipher key is sealed to the host's X25519 key in `host.json`. It is also sealed, in the host store's own `vault.keys`, to every admin and to the organization. So an admin, or the organization recovery key, can open the host store with the service stopped. That makes `recover_organization` and restoring a backup work on the host.
- The host never holds collection keys, batch keys, summary keys or the organization's private key.
- **What protects `host.key`:**
  - Linux: file mode 0600, owned by the service user.
  - Windows: DPAPI with machine scope, plus an ACL for the service account.
  - macOS: 0600 in a folder owned by root or the service user.

  None of these hold up against a stolen disk without full-disk encryption. The host setup screen should check for FileVault, BitLocker or LUKS and advise turning it on. Even without it, a stolen host disk gives metadata (people's and collections' names, who changed what and when, the audit log), never recipe content.
- **What the host cannot do:** search, export, or work out anything about recipes. Nothing in ADR 5 asks it to.

### 2.3 Modes, and switching between them

The store records its mode in `meta` (`mode = standalone | host | replica`). All three modes use one schema: tables only the host uses stay empty elsewhere (ADR 6's "no second storage format").

| From → to | Who | Steps |
| --- | --- | --- |
| Standalone → host | An admin of a team's vault, on that machine | See 2.3.1. |
| Nothing → client | Anyone, on a new machine | "Join a vault on this network". Find the host (mDNS list, or type an address), enter the pairing code an admin shows, then choose a name from the device's people and type that person's password. Then the first sync. |
| Host → standalone | An admin, on the host machine | "Stop serving on the network". All devices are revoked. The service is stopped and uninstalled. The admin unlocks the host store with their own `database_key` entry. The database key is sealed to all people again, and mode is set to standalone. The app's replica is set aside (`set_aside_vault`, a `replaced-<time>` folder) and the host store is moved into the app's vault folder. Work that offline laptops never synced is lost, and the screen says so. |
| Client → nothing | Anyone on that device | "Leave this vault". This warns about unsynced work, then deletes the replica (secure delete, then remove the files). |
| Team → one person (ADR 6) | An admin | Needs the host stopped first. Then it runs as today. |

#### 2.3.1 Converting a standalone vault into a host

This is `Vault::prepare_host(staging: &Path) -> HostSetup`, in `crates/core/src/host.rs`:

1. Check the preconditions: `is_team()`, `admin()` succeeds, `summaries` is on, `finish_organization_change` has run, and schema 10 is in place with legacy attestation done (§5.4).
2. Make a backup, as `go_back_to_one_person` does.
3. Checkpoint the WAL. Copy `vault.db` to a staging folder. Open the copy and `store::rekey` it to a new host database key. Remove the local `meta` rows (drafts, settings, `last_backup`) from the copy, and set mode to host.
4. Write the host's key file: admins' `database_key` entries sealed again to the new key, plus `Organization`. Other people's entries keep their encrypted private keys, so the host can hand them to their devices, but they get no host `database_key`.
5. Make the host secret and the app's own device key. Sign both certificates with the organization signing key (§5.1). The device's people are everyone currently in the vault, because they all sign in at this computer today.
6. Run the elevated step (§2.5): `glaze-vault-hostd install --from <staging>`. It moves the staged store into the system data folder, protects `host.key`, writes the service definition, adds the firewall rule and starts the service.
7. Mark the app's own vault as a replica: mode = replica, the host's address `127.0.0.1:<port>`, the host's pinned key, the device key, and cursors set to the current highest sequence number per scope (it already has every row). A `meta` row `converting` records each step, so an unlock after a crash finishes or rolls back, as `finish_organization_change` does.

### 2.4 Access checks shared by `Vault` and `HostStore`

Built in stage 2 ([ADR 18](../adr/0018-directory-events.md)) as `access::Directory`, with
`check(actor, &Body)` in place of `check_event`.

Move the decisions out of `Vault` into pure functions over a metadata view:

```rust
// crates/core/src/access.rs
pub struct Directory { people, admins, grants: Vec<GrantRow>, roles: Vec<CustomRole>, collections, ... }
pub fn may_change(dir: &Directory, person: Uuid, collection: Uuid, kind: Kind) -> bool;
pub fn may_manage(dir: &Directory, person: Uuid, collection: Uuid) -> bool;
pub fn check_event(dir: &Directory, actor: Uuid, event: &Event) -> Result<()>; // incl. ManagersOnlyLower
pub fn held(dir: &Directory, role: Role) -> Held;
```

`Vault::editable` becomes "`access::may_change` succeeds, and I hold the key". `HostStore::accept` uses `access::may_change` plus a signature check. This refactor of `team.rs` (about 2,000 lines) and `roles.rs` is the riskiest piece of work in phase 2. Stage 2 does it while the code still runs on one computer, so the existing tests in `team.rs`, `roles.rs`, `summaries.rs` and `moving.rs` cover it.

### 2.5 System services

`glaze-vault-hostd install` runs elevated. It writes short service files by hand: they are easy to review, and it avoids pulling in a general service-manager crate.

| OS | Runs as | Data | Install | Elevation from the app |
| --- | --- | --- | --- | --- |
| macOS | `_glazevault`, a hidden user made with `dscl` (fiddly). Root is the fallback. | `/Library/Application Support/Glaze Vault/host` | LaunchDaemon plist in `/Library/LaunchDaemons`, `KeepAlive`, `launchctl bootstrap system` | `osascript … with administrator privileges`. `SMAppService` needs macOS 13 and the app supports macOS 12. |
| Windows | Virtual account `NT SERVICE\GlazeVaultHost` | `%ProgramData%\Glaze Vault\host` | The `windows-service` crate, both to create the service and to run as one. Firewall rule with `netsh advfirewall firewall add rule … program=…` | `ShellExecuteW` with `runas` (a UAC prompt) |
| Linux | `DynamicUser=yes` | `StateDirectory=glaze-vault` → `/var/lib/glaze-vault` | A systemd unit in `/etc/systemd/system`, `systemctl enable --now` | `pkexec` |

- **Updates.** The service runs the `hostd` that sits inside the app's install folder.
  - macOS: after an update, `hostd` sees that its binary changed and exits, and `KeepAlive` restarts it.
  - Windows: a running exe is locked. Tauri's NSIS installer hooks (`NSIS_HOOK_PREINSTALL` and `NSIS_HOOK_POSTINSTALL`) stop and start the service. MSI needs the same; I have not checked how. This must be tried on a real Windows install.
  - Linux: hosting needs the `.deb` or `.rpm`, since an AppImage has no fixed path to point a service at. The guide should say so.
- **Code signing.** The sidecar must be signed and notarized with the app (docs/releasing.md).
- **Development.** `glaze-vault-hostd run --dir <folder> --port 0 --port-file <file>` runs in the foreground with no service. Tests and the e2e suite use it.

---

## 3. Sync protocol

### 3.1 Units of data

Each unit is immutable once the host has it:

- `RevisionEnvelope`: every `revisions` column, plus `epoch`, `supersedes`, `signature` and `signer_id`. The ciphertext can be left out, for summary-only readers. The signature covers hashes of both the ciphertext and the summary (§5.2), so a stripped envelope still verifies.
- `AttachmentEnvelope`: the metadata, `epoch`, `sha256` and `signature`. The bytes travel separately, in chunks.
- `Event`: a directory change, a new key epoch, a move, an erasure or an offline policy. It has a type, an actor, an optional collection, `created_at`, a JSON body kept byte for byte as made, and a signature.
- `AuditEntry`: from clients to the host only (§5.5).

### 3.2 Sequence numbers and the cursor

Schema 8 adds a change log:

```sql
CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,   -- this store's own order
  host_seq INTEGER,                         -- the host's number; NULL on a replica until accepted
  item TEXT NOT NULL,                       -- 'revision' | 'attachment' | 'event' | 'erased'
  item_id TEXT NOT NULL,
  collection_id TEXT,                       -- NULL for the directory scope
  kind TEXT
);
```

- On the host, `host_seq = seq`.
- **Scopes:** `Directory`, and `Collection(id)`, one per collection. A new key epoch and a move are events in their collection's scope, so they come before the revisions that use them.
- **The cursor** is a map from scope to the last host sequence number received. The client keeps it in `sync_state` and sends it. The host keeps no per-device cursor, so the host can stay stateless about cursors.
- A scope the client sends no cursor for starts at 0. That is how a new grant is backfilled.
- If a device's level on a collection changes (say, from the collection key to the summary key), the host lists it in `reset_scopes`. The client deletes its rows for that collection and starts again at 0.
- A collection the device may no longer read goes in `drop_scopes`.

### 3.3 What the host sends each device

A device's people are chosen when it is paired (open question 4). Its scopes are the union, over those people, of `(collection, held(role))` from their grants. An admin among them gets every collection at the collection-key level, through `organization_grants`. So a laptop an admin uses holds everything, and the pairing screen should say so.

For each item:

| Item | Sent when the device holds… |
| --- | --- |
| Recipe revision, full | the collection key |
| Recipe revision, summary only (ciphertext stripped) | the summary key |
| Material, Limits, Prices revisions | the collection key |
| Batch and Mix revisions | the collection key or the batch key |
| Firing revisions | the collection key or the summary key |
| Attachments | as their record's kind |
| Key epoch rows (`collection_epochs`) | any level on that collection |
| `Erased`, `Moved` | any level on that collection |
| Grants | Admin devices: all. Others: their people's own grants, plus all grants on collections they manage (as `Vault::grants` filters today). |
| `organization_grants` | admin devices only |
| Key file entries (encrypted private keys) | the device's own people only |
| Certificates (public keys, names) | everyone, so signatures verify and history can show names |
| Roles, collection names | everyone (the names of collections in scope only) |
| Device list, audit log | admins, on request |

A shared workstation's replica holds ciphertext for all its people. Each person still opens only what their own grants unlock, exactly as on one computer today.

### 3.4 Key epochs (replacing in-place re-encryption)

Schema 8:

```sql
ALTER TABLE collections ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE grants ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE organization_grants ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE revisions ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE attachments ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;
CREATE TABLE collection_epochs (
  collection_id TEXT NOT NULL REFERENCES collections(id),
  epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  previous BLOB NOT NULL,          -- key of epoch-1 under this epoch's key (XChaCha, AAD names both)
  previous_batch BLOB NOT NULL,    -- batch_key(epoch-1) under batch_key(epoch)
  previous_summary BLOB NOT NULL,  -- summary_key(epoch-1) under summary_key(epoch)
  PRIMARY KEY (collection_id, epoch)
);
```

- Today's key becomes epoch 1, so nothing is re-encrypted by the migration.
- `rotate_collection_key_for` becomes `new_epoch(collection)`. It makes `K(n+1)`, writes the three wraps, seals new grants and the organization grant at `n+1`, and writes a `KeyEpoch` event. It touches no revisions, attachments or drafts.
- New content uses the current epoch. `OpenCollection` keeps `keys: Vec<(epoch, Key)>`, unwrapped lazily, and `key_for` takes the epoch.
- On a replica, an item saved offline under an old epoch is sealed again under the current one before it is pushed. It is still pending, so changing it is allowed. The host refuses old-epoch uploads with `StaleEpoch`, which forces this.
- **What this gives up.** Today, someone removed from a collection who kept its old key can open nothing in the vault, because everything was re-encrypted. With epochs they can still open epoch-n items if they also get the ciphertext. They had that ciphertext on their replica anyway, and they cannot get more without the host or another store's database key. ADR 3's "re-encrypts it" was written with replicas in mind, but on replicas it buys nothing, and it makes every removal cost a full re-encryption that every replica must download again. This is open question 2.

### 3.5 Forks, name clashes and the checkout lock

- **Forks.** The host accepts a revision whose parent is not a head, which gives the record two heads. `heads()` returns one entry per record with `forks: Vec<Uuid>` (the other heads), ordered by `host_seq`.
  - A Formulator, or anyone who may change that kind in the collection, chooses a version with `Vault::resolve_fork(kind, keep, others)`. That saves a revision whose parent is `keep` and whose `supersedes` lists the others.
  - `heads()` leaves out superseded revisions and parents.
  - The UI reuses `ui/compare.ts` to show the two versions side by side. Amounts are never merged (ADR 5).
- **Delete against edit.** A delete made offline from a revision that someone else has since changed becomes a fork. The live branch shows, with a note "Deleted on another computer". Resolving can delete it or keep it.
- **Material name clashes.** Two replicas can each make a material called "Custer". The host accepts both. Every client sees a "two materials share this name" notice, and recipes find the older one by name until someone renames one. Unique names of people and roles stay enforced, because admin changes need the host.
- **Checkout (advisory).** Recommended:
  - It needs the host. `Checkout { record_id }` and `Release`.
  - The host keeps `checkouts(record_id, person_id, device_id, since, expires)`, expiring after 8 hours by default. It sends `CheckoutChanged` to connected sessions.
  - The core on a connected client refuses to save a record checked out by someone else, with `CheckedOut { by }`.
  - The host itself never refuses a revision because of a checkout. A save made offline, before the device learned of the lock, becomes a fork as usual. Work is never thrown away.
  - Anyone who may change the record can break a lock. Breaking one is audited.

### 3.6 Moves

- `move_records` on a client builds a `Moved` event for each record. The event carries replacement envelopes, re-encrypted under the target collection's current epoch and signed by the mover with `moved_from` naming the original revision. It also carries replacement attachments, re-encrypted and uploaded again.
- The host checks the mover may change records in both collections (as today), replaces the rows and gives them new sequence numbers. It sends `Gone(record)` to devices that read the source collection but not the target.
- This is the one sanctioned replacement of stored rows, besides erasing. It is audited.
- Moving a firing with many photos uploads the photos again. Moves are rare, so I would accept that. The alternative is a random key per revision and per attachment, wrapped by the collection key, so a move only re-wraps 32 bytes. It means re-encrypting everything once at migration and a second key layer everywhere. I would not do it in phase 2.

### 3.7 Attachments and photos

- Schema 8 adds `attachments.sha256`. Schema 10 adds the signature.
- **Upload:**
  - After the push that holds the record's revision, the client sends `PutAttachment { id, offset, bytes, last }` in 1 MiB chunks.
  - The host stages the chunks in `incoming_attachments`.
  - The host checks the hash and the signature when the last chunk arrives, then inserts the attachment and gives it a sequence number.
  - An upload that breaks off can resume from `offset`.
- **Download:** `GetAttachment { id, offset }` → `AttachmentChunk`. The default is to fetch every photo in the background after revisions (open question 9).
- A firing whose photo has not arrived shows "Photo not synced yet".
- Reading BLOBs in chunks can use rusqlite's incremental BLOB I/O (`blob` feature, `Connection::blob_open`), so a 25 MiB photo is never held twice. Today `Vault::attachment` reads the whole BLOB, which is fine for display.

### 3.8 Messages

These are CBOR (`ciborium`) frames over one TLS stream, with a 4-byte length prefix (`tokio_util::codec::LengthDelimitedCodec`, 32 MiB maximum frame).

```rust
pub const PROTOCOL: u32 = 1;

enum ClientMsg {
  Hello { protocol: u32, app_version: String, device_id: Uuid, generation: Option<Uuid>,
          cursors: Vec<(Scope, u64)> },
  Pull { cursors: Vec<(Scope, u64)>, max_bytes: u32 },
  Push { items: Vec<Upload> },                 // revisions, attachment envelopes, events, erasures
  PutAttachment { id: Uuid, offset: u64, bytes: Vec<u8>, last: bool },
  GetAttachment { id: Uuid, offset: u64 },
  Audit { entries: Vec<AuditEntry> },
  Checkout { record_id: Uuid }, Release { record_id: Uuid },
  // admin only, checked by the host against the directory:
  StartPairing { device_name_hint: String }, ApproveDevice { cert: DeviceCertificate, people: Vec<Uuid> },
  RevokeDevice { device_id: Uuid, lost: bool }, IssueExtension { device_id: Uuid, days: u8 },
  ReadAudit { from_seq: u64, limit: u32 }, RequestBackup,
  Ping,
}

enum HostMsg {
  Welcome { host_time: i64, generation: Uuid, revoked: bool, policy: OfflinePolicy,
            reset_scopes: Vec<Scope>, drop_scopes: Vec<Scope>, checkouts: Vec<Checkout>, signature: Vec<u8> },
  Batch { items: Vec<Item>, cursors: Vec<(Scope, u64)>, more: bool },
  PushResult { accepted: Vec<(Uuid, u64)>, refused: Vec<(Uuid, Refusal)> },
  AttachmentChunk { id: Uuid, offset: u64, bytes: Vec<u8>, last: bool },
  Changed { seq: u64 },                        // unasked: "pull again"
  CheckoutChanged(Checkout), CheckoutResult(Result<Checkout, Refusal>),
  PairingCode { code: String, expires_at: i64 }, PairingFinished { device: PendingDevice },
  ExtensionCode { code: String }, AuditPage { entries: Vec<AuditEntry>, more: bool },
  BackupChunk { bytes: Vec<u8>, last: bool },
  Pong, Refused(Refusal),
}

enum Refusal { NotAllowed, BadSignature, UnknownSigner, StaleEpoch { current: u32 },
               Erased, ChangedElsewhere, ParentUnknown, TooLarge, CheckedOut { by: Uuid },
               NeedsNewerApp { min: String }, Revoked }
```

**Order of one sync:** `Hello` → `Welcome` → pull until `more` is false (directory scope first, then collections, all in sequence order) → apply → seal pending items again if an epoch changed → `Push` → `PushResult` → set `host_seq` on accepted rows → upload pending photos → download missing photos → stay connected and wait for `Changed`.

Items the client pushed come back in later pulls. They are inserted with `INSERT OR IGNORE`.

**Sync while unlocked only (recommended).** The sync engine in the app uses a second `rusqlite::Connection` to the replica. It is opened with the database key while the vault is unlocked, and closed on lock. Applying pulled items needs no collection keys: they are ciphertext plus signature checks against certificates. Sealing pending items again needs keys, so it takes the `Vault` mutex for that rare step. After applying, the app sends a Tauri event (`vault-changed`) so TanStack Query refetches. A workstation that is left unlocked syncs all the time. A locked one catches up when it is unlocked (open question 6).

### 3.9 Restoring the host from a backup

- The host store has a `generation` UUID, which changes on every restore.
- A client that sees a new generation in `Welcome` resets every cursor to 0. It then pushes every signed item it has that the host lacks. A replica is a good second copy for that reason.
- Items in the replica's own `erased` table are not pushed.
- Work erased on the host after the backup was made, which no replica kept a tombstone for, can come back. The restore screen says so.

### 3.10 Key distribution

Changed by [ADR 18](../adr/0018-directory-events.md): events carry public keys only, since they are
kept for good, and a password change makes no event. How key file entries reach a person's
devices is decided in ADR 20.

- A person's collection keys stay where they are today: grants sealed to their X25519 public key. They travel as `GrantSet` events, which hold the sealed box, so the host forwards sealed keys it cannot open.
- An admin adding a person makes the person's keys on their own client, exactly as `add_person` does today. `PersonAdded` carries the key file entry (private key under the one-time password), the certificate and the grants.
- The person's first sign-in on a device picks up that entry. `set_own_password` emits `PersonKeysChanged` (new password and recovery wrappings), signed by the person.
- A password change on one device travels the same way. A device that has not synced still opens with the old password, as old backups do (ADR 7).
- Each replica seals its own database key to the people in its key file. When a person is added to a device, the replica seals its key to them at the next sync, while someone is unlocked.

### 3.11 Revocation

- **Device retired.** The host marks it revoked. At the next connection, its TLS key is still accepted for one exchange, and `Welcome { revoked: true }`, signed by the host, tells the app to delete the replica. A device with an unknown key is refused at the TLS layer.
- **Device lost or stolen.** The same, plus:
  - a new key epoch for every collection the device could read (`RevokeDevice { lost: true }`);
  - `reset_person` for each of its people (new keys and a one-time password, the existing flow), since their private keys are on the device under their passwords.

  Until it connects, the laptop still opens with its people's passwords, as ADR 5 says. The real protection is the password, and that the replica holds only those people's collections.
- **Person removed** (`remove_person`). Their grants go and their certificates are revoked. Their collections get new epochs. A device whose only person was them is revoked. Other devices drop their key file entry and rotate their own database key.
- **Admin taken away** (`take_admin_away`). As today: a new organization key and recovery sheet. A new epoch on every collection replaces today's re-encryption. The organization signing key changes too, so every person and device certificate is issued again, signed by the new key, in the same event. Clients accept the new organization key because the old one signed the change.

### 3.12 Offline limits

- **Policy.** `OfflinePolicy { days, after: Nag | ReadOnly, by_role: Vec<(Role, days, after)> }` is a directory event. A person's rule is the strictest one among their roles. The replica applies it while that person is signed in.
- **What counts as synced:** a pull that reached `more: false`, and a push with nothing left pending. The replica keeps `last_synced_host_time`, and `max_seen_local_time` to catch a clock that was set back. A clock more than a day behind what it has seen counts as expired.
- **Nag:** a banner on unlock that gets firmer each day.
- **Soft cut-off:** enforced in the core, not the page. `Vault::writable()` is called from `add_revision`, `add_attachment`, `delete`, `erase`, `move_records` and every team change, and returns `Error::OfflineTooLong`. Drafts are still kept, so nothing typed is lost. Reading and printing go on.
- **Extension code.** An admin asks the host for one. The code is the number of days (2 digits), the day it was issued (3 base32 characters) and a 10-character Crockford base32 MAC. The MAC is HMAC-SHA256 under the device's offline secret, over `glaze-vault v1 extension device {id} issued {day} days {n}`. That makes 15 characters, written as `14-K7Q-F9M2D-XW3PA`, short enough to read over the phone.
- **The offline secret** is derived from the SPAKE2 session at pairing (HKDF, `info = "glaze-vault v1 offline-secret"`). The host keeps it in `devices`. The replica keeps it in `meta`, inside SQLCipher.
- Someone with the replica and their own password could take the secret out and make their own codes. ADR 5 already says the limit is a rule in the app, not a lock. The guide should say it too.

---

## 4. Transport and pairing

### 4.1 Crates

| Need | Crate | In Cargo.lock? | Why |
| --- | --- | --- | --- |
| Async runtime | `tokio` 1 | yes, 1.53.3 (from Tauri) | Already there, and it is Tauri's own runtime. Add `net`, `rt-multi-thread`, `time`, `sync`, `io-util`, `macros`. |
| TLS 1.3 | `rustls` 0.23 + `tokio-rustls` 0.26 | yes, both, with `ring` | Pure Rust. `ring` is already the provider in the tree. Declare `rustls = { default-features = false, features = ["ring", "std"] }`, or the default pulls in `aws-lc-rs`, which needs CMake and NASM on Windows. The Windows build already fights the OpenSSL Perl (ci.yml). |
| Certificates | rustls raw public keys (RFC 7250) if they work with Ed25519 and `ring` on both sides; otherwise `rcgen` (`default-features = false, features = ["ring"]`) for self-signed Ed25519 certificates | rcgen: no | Pinned keys need no X.509 at all. I believe rustls 0.23 supports raw public keys, but not that it does with `ring` for both client and server. Check this in stage 5 before choosing. |
| Framing | `tokio-util` `LengthDelimitedCodec` | yes, 0.7.20 | |
| Encoding | `ciborium` (CBOR) | no | Self-describing, so new fields can be added with `#[serde(default)]`. Bytes are compact. An IETF standard. `postcard` is smaller but not self-describing. I would avoid `bincode`; I recall its maintainers stopped working on it in 2025. |
| PAKE | `spake2` (RustCrypto PAKEs) | no | Named in ADR 5. Check which `curve25519-dalek` major it uses. The tree has 5.0.0, from `x25519-dalek` 3 via `hpke`. If `spake2` still uses 4, both will be compiled. That works, but it is extra build time. |
| Signatures | `ed25519-dalek` (the major that uses `curve25519-dalek` 5; I expect 3.x, so check) with `zeroize` | no | Same family as `x25519-dalek`. ADR 3 asks for RustCrypto/dalek-grade libraries. `ring`'s Ed25519 is the fallback. |
| MAC | `hmac` 0.13 + `sha2` | hmac: yes (as a dependency of a dependency) | |
| mDNS | `mdns-sd` | no | Pure Rust, advertises and browses, and needs no Bonjour on Windows or Avahi on Linux. `zeroconf` needs both. |
| Windows service | `windows-service` | no | Creates and runs the service. |
| Logging in hostd | `log` (already present) plus a small file logger | log: yes | Keep it small. `tracing` is in the tree too, if wanted. |

### 4.2 Keys and identities

- **Host:** Ed25519 (TLS identity) and X25519, both from the host secret. The organization certifies the host key at conversion.
- **Device:** a random Ed25519 key, made when it pairs. The private key is in the replica's `meta`, so it can only connect while someone is unlocked. The organization signs a `DeviceCertificate`: `glaze-vault v1 device-certificate vault {vault_id} device {id} key {hex} people {sorted ids} issued {time}`.
- **TLS:**
  - TLS 1.3 only: `builder_with_protocol_versions(&[&rustls::version::TLS13])`.
  - The client's `ServerCertVerifier` accepts only the pinned host key, and checks the TLS 1.3 signature with ring's algorithms. It ignores names and expiry dates.
  - The host's `ClientCertVerifier` accepts keys of registered devices. A revoked device is let through only to receive `Welcome { revoked }`.
  - During pairing, the host accepts a connection with no client certificate.

### 4.3 Pairing

1. An admin, on any connected client (the host machine's app included), chooses "Pair a computer". `StartPairing` goes to the host. The host makes a code of 8 digits, shown as `4821-0937`. It is valid for 10 minutes and for one attempt: a wrong code ends it.
2. The new device connects with TLS and records the host's key, not yet trusted.
3. Over that TLS stream, both sides run SPAKE2 with the code as the password. The identities are `"glaze-vault host"` and `"glaze-vault device"`. Each side mixes a TLS exporter value (`export_keying_material`, label `"glaze-vault v1 pairing"`) into its confirmation MAC. So a man in the middle with a different TLS session fails the confirmation, even if they knew the code.
4. After confirmation, the device sends its name and Ed25519 public key. The host forwards them to the admin's session as `PairingFinished`.
5. The admin's app shows the device's name and a short fingerprint, and asks "Who will use this computer?". It signs the `DeviceCertificate` and sends `ApproveDevice`.
6. The host stores the device and sends the device: `vault_id`, the organization's signing and X25519 public keys, the host certificate, the device certificate, and the key file entries of the chosen people. Both sides derive the offline secret from the SPAKE2 key.
7. The device saves the pinned host key, and from then on connects with its key.

### 4.4 Discovery

- **Advertise:** `_glazevault._tcp`. The instance name is the host machine's label, chosen at setup. The TXT record holds `proto=1` and `vault=` the first 8 bytes of SHA-256 of the organization signing key, in hex. So a paired client can find its own vault's host when its address changes. This tells anyone on the LAN that a Glaze Vault host is there, but not whose it is.
- **Browse:** the join screen lists the hosts it finds. "Type an address" covers networks that block multicast or split machines across VLANs.
- **Port:** one fixed default port, chosen and written down in the ADR in stage 5. It can be changed in `host.json`. A replica keeps the last address that worked, and tries it before mDNS.

---

## 5. Signed revisions and the audit log

### 5.1 Author keys and certificates

- `signing.rs`: `signing_key(x25519_secret) = Ed25519 seed from HKDF-SHA256(ikm = secret, info = "glaze-vault v1 signing-key")`. The organization's comes from its X25519 secret with `info = "glaze-vault v1 organization signing-key"`.
  - Existing people and organizations get signing keys with no new secret in the key file.
  - Two keys from one secret, kept apart by different HKDF info strings, is ordinary key derivation.
- Public signing keys are published as optional fields: `KeyringUser.signing_key` and `Organization.signing_key`, with `#[serde(default)]`. Key file formats 1 and 2 stay as they are. Older app versions ignore the new fields, since `Keyring` does not deny unknown fields.
- **Schema 10:** `certificates(person_id, signing_key, encryption_key, issued_at, issuer, signature, revoked_at)`.
  - A team's certificates are signed by the organization signing key: `glaze-vault v1 person-certificate vault {vault_id} person {id} signing {hex} encryption {hex} issued {time}`.
  - In a one-person vault, the person signs their own certificate. `grow_into_team` certifies them with the new organization key.

### 5.2 What is signed

Each payload is a fixed byte string built by a function, in the style of `revision_aad`. Signatures never cover serde output, which could change between versions. For example:

```
glaze-vault v1 revision-signature vault {vault} revision {id} record {record} kind {kind}
collection {collection} epoch {epoch} number {n} parent {parent|-} deleted {0|1}
supersedes {sorted ids|-} author {author} at {created_at}
content {hex sha256(nonce || ciphertext)} summary {hex sha256(summary_nonce || summary) | -}
```

- **Attachments:** id, record, kind, collection, epoch, media type, size, author, time and the SHA-256 of the ciphertext.
- **Events:** type, actor, collection, time and the SHA-256 of the exact body bytes as stored.
- **Checks:**
  - The host checks every push: the signature, that the signer's certificate is valid and not revoked, and that the author may do this under `access.rs`.
  - Clients check again when they apply what they pulled.
  - `Vault::history` returns `signed: Signed::{ByAuthor, Attested(by), Unsigned, Bad}`. The history screen shows who saved each revision, and warns about `Bad` signatures.
  - On one computer, a bad signature is a warning, not a refusal (ADR 12: whoever could forge one already holds the keys).

### 5.3 Moves and signatures

A moved revision is signed again by the mover (§3.6). It keeps `moved_from`, and the original author shows as "saved by A, moved by B".

### 5.4 Revisions from before signing

The first admin to unlock after schema 10 (or the one person) signs an attestation for each unsigned revision, attachment and the stage-2 directory events made from existing rows. This follows the pattern of `change_to_summaries`, which also runs at unlock and is retried if it fails. These items show as "Saved before signing; vouched for by A on date". Converting to a host needs it done.

### 5.5 The audit log

- **Schema 10:**

  ```sql
  CREATE TABLE audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, at INTEGER NOT NULL,
    person_id TEXT, device_id TEXT, action TEXT NOT NULL, kind TEXT, record_id TEXT,
    collection_id TEXT, detail TEXT, prev_hash BLOB NOT NULL, hash BLOB NOT NULL,
    signature BLOB, host_seq INTEGER
  );
  ```

  `hash = SHA-256(prev_hash || payload)`. On the host, `hostd` signs a checkpoint (the latest `seq` and `hash`) every hour, and when an admin reads the log.
- **What is recorded:**
  - **Changes:** every revision, attachment, erase and move. Every directory event (people, roles, grants, collections, admin given or taken away, new key epochs, a new organization recovery sheet).
  - **Reading**, as reported by the app: a recipe, material, batch sheet or firing opened, once per record per sign-in, not every list. Printed (recipe or batch sheet, and the batch size). Exported (format and number of records). Backup made or restored.
  - **Security:** sign-ins and failed sign-ins (reported at the next sync), pairing started, finished or failed, devices revoked, extension codes issued, cut-off reached, a checkout broken. Connections are counted per device per day, not logged one by one.
- **Who reports.** Reading and printing can only be reported by the app (`Vault::note(action, subject)`, called from the page). They show what an honest app did, not proof of what someone read. The guide should say so.
- **Where it lives:**
  - Host: the whole log. Admins read it through `ReadAudit`, and the client checks the chain and the checkpoints.
  - Replicas: an outbox only. Entries are pushed and then deleted, so a lost laptop holds no log.
  - Standalone (stage 3): the same table and chain without a host signature. Useful, but anyone with the database key could rewrite it, as ADR 12 says.
- **Records only ids.** The admin's app puts names back from what it can open. Erasing a record leaves its audit entries. Entries are kept for good, and admins can export them as CSV.

---

## 6. Testing

### 6.1 Rust

- **Core tests** (`cargo test -p glaze-vault-core`) cover:
  - epochs, including reading epoch-1 rows after three rotations at each `Held` level;
  - tombstones;
  - fork resolution;
  - every directory event round-tripped through `apply`, against the existing behaviour tests in `team.rs` and `roles.rs`;
  - signatures, attestation and the audit chain.
- **Integration tests** in `crates/sync/tests/`:
  - `TestHost::new()`: a temporary folder and a `HostStore`, served either over `tokio::io::duplex` pairs (for the protocol) or on `127.0.0.1:0` (for TLS and pairing).
  - `TestClient::pair(&host, &admin, people)` and `client.sync()`.
  - A `Clock` trait put into `Vault` and `HostStore`, so offline limits and checkout expiry can be tested without waiting.
  - **What they cover:**
    - pairing: a wrong code ends the session, and a swapped TLS key fails confirmation;
    - first sync;
    - "never receives": open a batch operator's replica with its database key and assert there are no rows of other kinds, and that a summary-only replica has no recipe `ciphertext`;
    - forks;
    - checkout;
    - an erase spreads, and an offline replica cannot bring the record back;
    - a moved record disappears from devices that cannot read the target;
    - revocation wipes the replica;
    - a new epoch while a client is offline, then its pending items are sealed again;
    - a host restore with a new generation;
    - soft cut-off and extension codes.
  - **A convergence test:** a seeded random series of saves, deletes and grant changes on three clients, each offline for part of it, then sync all. Each person's view must be the same on every device. A small hand-written random loop is enough, so no `proptest`.
- **Speed.** `crypto::NEW_KDF` uses the cheap Argon2 settings only under `cfg(test)`. That does not apply when `glaze-vault-core` is built as a dependency of `crates/sync`'s tests. So each test unlock would run Argon2id at 64 MiB and 3 passes. Add a feature to core, `test-kdf`, enabled only from `sync`'s and `hostd`'s `[dev-dependencies]`. Add a CI step that fails if a release build turns it on (for example, `cargo tree -e features -p glaze-vault --release` must not show it).
- **mDNS.** A loopback browse-and-advertise test. GitHub runners may block multicast, so the typed address is what the other tests use, and the mDNS test can be `#[ignore]` in CI if it proves unreliable.

### 6.2 End-to-end

- **Two apps.** `e2e/app.ts` already keeps each app's files in its own folder (`GLAZE_VAULT_DIR`, `_SCREEN`, `_DRIVE`).
  - Start the first app with `tauri dev` as now. It builds and starts Vite.
  - Start the second by running the built `target/debug/glaze-vault` directly, with its own environment. A debug build loads the dev URL, so it uses the same Vite server. I have not tried this.
  - The UI uses `localStorage` in `RecipeEditor`, `PersonPicker` and `Limits`. Two instances of one binary may share the webview's data store. On Windows and Linux, a dev-only `GLAZE_VAULT_WEBVIEW_DATA` can set `WebviewWindowBuilder::data_directory`. On macOS 12 the store probably cannot be separated, so the scenarios must not depend on what is kept there.
- **A host.** `cargo build -p glaze-vault-hostd`, then `target/debug/glaze-vault-hostd run --dir <tmp>/host --port 0 --port-file <tmp>/port`. The scenarios type the address and never use mDNS.
- **A separate suite** (`npm run e2e -- --suite lan`, scenarios in `e2e/lan.ts`), so the main run stays around 30 seconds. `Scenario.run` takes `{ apps: { a, b }, host }`. Scenarios, in order:
  1. Convert to a host, using a dev-only `GLAZE_VAULT_HOST_NO_SERVICE=1` that runs `hostd` as a child process and skips the service install.
  2. Pair the second app, and sign in as a batch operator who sees only batch sheets.
  3. A save on A shows on B.
  4. B goes offline (stop `hostd`), both apps edit, and a fork is resolved.
  5. Erase on A while B is offline, then B reconnects.
  6. Revoke B.
- **Installing the service** cannot be tested by `tauri dev`. Add a CI job, "Host service smoke test", on each OS: build `hostd`, run `sudo glaze-vault-hostd install --dir …` (an elevated shell on Windows), check that it listens and answers `Hello`, then uninstall. GitHub's runners allow sudo and admin, and Ubuntu runners have systemd.

### 6.3 CI

The existing matrix (`.github/workflows/ci.yml`) already runs `cargo test --workspace` and `npm run e2e` on macOS, Windows and Linux. Add:

- the LAN e2e suite after the main one;
- the service smoke-test job;
- `hostd` built for the bundle job (the sidecar's file name needs the target triple), and in `release.yml`.

---

## 7. Staged delivery

Sizes: S is under 500 lines changed, M is 500 to 1,500, L is 1,500 to 3,000. Tests included. Each stage leaves the app shippable. Branch names follow whatever date names are in use; the topic is given here.

| # | Stage | Contents | Useful on its own | Size |
| --- | --- | --- | --- | --- |
| 1 | **Key epochs, change log, tombstones** (schema 8) | `collection_epochs` and epoch columns. `rotate_collection_key_for` becomes `new_epoch`, and `OpenCollection` keeps epoch keys. Drafts encrypted at the current epoch, and read through the chain. The `changes` table, filled from existing rows in `created_at, rowid` order. `attachments.sha256`. The `erased` table, written by `erase`. `heads()` shows forks, plus `resolve_fork` and `supersedes`, and a small fork notice in the editor using `compare.ts`. Draft ADR 17. | Removing a person, or a grant, no longer re-encrypts the collection. Forks are resolvable. | L |
| 2 | **Directory as events, shared access checks** (schema 9) | An `events` table. Each operation in `team.rs` and `roles.rs` builds an `Event` and calls `apply(&tx, &event)`. `access.rs` gains `Directory`, `may_change`, `may_manage` and `check_event`. `move_records` and `erase` write events. Existing grants, roles and collections are filled in as events made from the existing rows (unsigned until stage 3). No change visible on screen. ADR 18. **Built.** | All team logic in one place that the host can call. | L |
| 3 | **Signatures and the audit log** (schema 10) | `signing.rs`, `certificates`, signature columns, attestation at unlock, `Signed` in history. The audit table and chain, and `Vault::note` from the page for opening, printing and exporting. An admin screen listing the log, with CSV export. ADR 19. Closes the Teams follow-up. **Built.** | Who saved what, and a log, on one computer. | L |
| 4 | **Sync core, no network** | `core::host::HostStore`: a blind open, `accept(push)`, assigning sequence numbers, `pull(device, cursors)` filtering. `core::replica`: apply, pending items, sealing again, cursors. `crates/sync` with `proto.rs` and sans-IO sessions. In-process tests with one host and two or three clients, including the convergence test. The `test-kdf` feature. ADR 20. **Built**: `HostStore` is `vault/host.rs`, the replica `vault/replica.rs`, the wire types `core::sync`. | Proves the model before any socket. | L |
| 5 | **Transport, pairing, hostd in the foreground** | `sync::net`: rustls with pinned keys (decide between raw public keys and rcgen), SPAKE2 with the exporter binding, `mdns-sd`, framing. `crates/hostd` with `run`. Loopback TLS tests. A dev-only CLI client for trying it by hand. ADR 21. **Built**: raw public keys, no rcgen; port 47917; `crates/hostd`, with `examples/dev-client.rs`. | A working host that developers can run. | L |
| 6 | **Host mode in the app** | `Vault::prepare_host`, the conversion screen, `hostd install` and `uninstall` per OS with elevation, firewall rule, sidecar bundling, updater handling. The host machine's app as a loopback replica. "Pair a computer", the Devices list, "Stop serving". Service smoke-test CI. ADR 22. **Built**: stopping makes the host computer's replica the vault again, rather than moving the host's store back; `hostd` runs as root on macOS. | Teams can serve the LAN. Clients come next. | L |
| 7 | **Client mode** | The join flow, the background sync task in the app (a second connection, `vault-changed` events), the sync status indicator, photos in chunks, the checkout button, `NeedsHost` for admin actions while offline, "Leave this vault". The LAN e2e suite. ADR 23. **Built**: admin changes on a replica hold the directory at the host while they are made (`LockDirectory`); checkouts are kept in the host's memory; the LAN suite leaves going offline, erasing apart and revoking to the Rust tests. Schema 12. | Workstations and laptops work. | L |
| 8 | **Offline limits, revocation, host backups** | `OfflinePolicy`, `Vault::writable`, nag and read-only banners, extension codes, revoked-device wipe, the lost-device flow, `generation` and a restore on the host, host backups (daily ones kept by `hostd`, and `RequestBackup`). ADR 24. **Built**, without `RequestBackup`: the host's backups stay on the host computer, restored with `hostd restore`; the offline rule's clock is the computer's own, with the latest time it showed; a lost computer's people whose key file entries the admin's computer lacks are reset from the host computer. Schema 13. | Finishes ADR 5. | M |

The LAN update mirror (ADR 5, "Updates on the LAN") comes after stage 8, as a follow-up.

**After stage 8, built** ([ADR 25](../adr/0025-host-backups-from-the-app.md)): `RequestBackup` as a
`.gvhost` file and restoring the host from the app, rules by role on screen, photos on demand,
checkouts of every kind, the host refusing directory changes from a computer not holding the
directory, and resetting someone from a computer without their key file entry.

**Biggest risks:**

- The `team.rs` refactor in stage 2.
- The Windows service and the updater replacing a running sidecar (stage 6).
- Installing a daemon on macOS 12 without `SMAppService`.
- Whether `spake2` and `ed25519-dalek` fit with `curve25519-dalek` 5.
- Two webviews of one debug binary in the e2e suite.

---

## 8. Open questions for Aaron

Each has a recommended default. Aaron accepted all of them on 2026-10-20.

1. **A blind host.** Should `hostd` hold no collection keys, so it cannot read recipes? *Default: yes.* The cost is no server-side search or export, which nothing needs.
2. **Key epochs instead of re-encrypting on removal.** This changes ADR 3 and 12. Someone removed who kept the old key and the old ciphertext can still read what they could already read. *Default: yes, epochs.*
3. **Is a team needed to host?** A potter with a studio desktop and a laptop would have to "share" the vault, with only themselves in it. *Default: yes, hosting needs the organization key, which signs certificates. The share step could get a simpler wording for "just my own computers".*
4. **Who can sign in at a device.** *Default: the people an admin names when pairing.* The alternative, anyone in the vault, would send every person's encrypted private key to every device, open to offline password guessing there.
5. **Do admin changes need the host?** People, roles, grants, collections, admin, epochs. *Default: yes.* That keeps names unique and avoids admin changes that conflict.
6. **Sync only while unlocked.** *Default: yes.* A locked or closed app does not sync, and the device key is behind the person's password. The alternative is a background service on every client.
7. **A revoked device that reconnects deletes its replica.** *Default: yes.*
8. **A lost device.** Should revoking it as lost give new key epochs to everything it could read, and reset its people's keys? *Default: yes for "lost or stolen", no for "retired".*
9. **Photos on laptops.** *Default: all of them, fetched in the background.* The alternative is fetching on demand, which saves disk but means none in the warehouse.
10. **Default offline policy.** *Default: nag after 14 days, no cut-off unless an admin turns it on.*
11. **The checkout lock.** *Default: advisory, as in §3.5.* It needs the host, expires after 8 hours, and anyone who may change the record can break it. The host never refuses work made offline.
12. **Backups in host mode.** *Default: only the host backs up.* `hostd` makes one daily and keeps 14, and an admin can download one from any client. Clients cannot make backups, since each holds only part of the vault.
13. **What is audited for reading.** *Default: opening a record, printing and exporting, as reported by the app. Not list views. Kept for good.*
14. **Delete against edit.** *Default: the edit is kept and shown as a fork with "Deleted on another computer".*

## 9. ADRs to write or change

This repo writes each record once, and a later change gets a new record. So "change" below means a new record, plus a note at the top of the old one (as ADR 7's "Drafts are replaced by ADR 8").

- **New 17. Key epochs, the change log and tombstones.** Replaces ADR 3's "Removing a grant … re-encrypts it", ADR 12's re-encryption on removal and on taking admin away, and ADR 14's "Changing a collection's key re-encrypts its attachments". Says how ADR 9's erasure works with replicas.
- **New 18. The directory as events, and shared access checks.** Built in stage 2.
- **New 19. Signed revisions, key certificates and the audit log.** Built in stage 3, with three changes to section 5: signing keys are not published in the key file (certificates carry them), certificates are not issued again under a new organization key (each stays trusted for when its issuer was the organization's), and people from before prove their keys before an admin certifies them. Builds the parts of ADR 4 that were deferred ("Every revision is signed", "The audit log"), and the follow-up from ADR 12. Includes keys derived by HKDF, attestation, and what is audited.
- **New 20. The sync protocol.** Built in stage 4 as the sync core, with these changes to section 3: key file entries travel as signed latest entries, not events; a collection's making and name are in its own scope; the host works out each computer's keys held per collection, and the computer says what it last knew, for resets; consecutive events are taken all or none; photos travel whole inside their items until stage 7; erasing on a replica waits for its delete to reach the host. Scopes and cursors, what the host sends whom, forks and resolving them, checkout, moves as events, attachments in chunks, the generation on restore. Replaces ADR 5's "Batch logs, firing logs and notes are events" (firings and mixes are records; events are for the directory, erasures, moves and the audit log), and the move event of ADR 18 carrying the rows that replace the old ones. Also how people's key file entries reach their devices.
- **New 21. Pairing, transport and discovery.** SPAKE2 bound to TLS with an exporter, rustls with ring and pinned keys, CBOR frames, `_glazevault._tcp`, the default port.
- **New 22. hostd, the blind host and the three modes.** The crate split (adds `crates/sync` to ADR 1's list), services per OS, converting and stopping, the host on the same machine as a loopback replica, the host's keys and disk encryption, sidecar updates, and Linux hosting from `.deb`/`.rpm` only. Notes ADR 6's "the LAN host stops" step.
- **New 23. Client mode.** Built in stage 7: joining, the background sync, checkouts, photos in pieces, directory changes through the host, and the LAN suite.
- **New 24. Offline limits, revocation and lost devices.** Makes ADR 5's offline limits concrete: the code format, the clock rule, what read-only means in the core.
- **New 25. The phase 2 leftovers.** Host backups from the app, and the rest left after stage 8.
- **Change ADR 11.** The LAN suite: two apps and a foreground `hostd`, and the service smoke test.
- **Change ADR 7.** Backups in host mode, and that clients do not make them.
- **docs/follow-ups.md:** remove the Teams item when stage 3 lands. Add: syncing per-person settings, the LAN update mirror, a key per item if moves with photos get slow, and `SMAppService` once macOS 12 support is dropped.
- **docs/user:** `sharing.md` loses "Other computers on your network come later". `security.md`'s "The network" section describes the host. New guides for hosting, joining, offline use and devices.

---

### Critical files for implementation

- crates/core/src/vault/team.rs (rotation, removal, grants and admin changes: becomes events and epochs)
- crates/core/src/vault.rs (`add_revision`, `revision_aad`, `newest` and `heads`, `erase`, `key_for` and `kind_key`, drafts, `open`)
- crates/core/src/store.rs (migrations 8 to 11)
- crates/core/src/access.rs (to become the shared policy checks for `Vault` and `HostStore`)
- crates/core/src/vault/moving.rs and crates/core/src/vault/attachments.rs (moves as events, attachment hashes and chunks)
- Also: crates/core/src/keyring.rs, crates/core/src/crypto.rs, crates/app/src/lib.rs, e2e/app.ts, .github/workflows/ci.yml
