# Plan 3: Release Readiness, Sync Follow-Ups, and Remaining Tracks

Drafted 2026-11-26, based on `main` at `c0e1d3b`.

## Baseline Where Things Stand

- **Built and verified end to end:**
  - **Phase 1 (One-person vault & chemistry):** SQLCipher + Argon2id + XChaCha20-Poly1305 + HPKE + Ed25519 vault, revision history, backups, print/PDF, glaze UMF/limits/target fitting/line & triaxial blends, clay-body & zero-flux slip chemistry, SHAB/ASTM C373 test bars, vitrification curves, and side-by-side recipe & clay material comparisons.
  - **Shared chemistry submodules:** `lib/core` (`@glazecalc/core` `v0.2.1`) and `lib/catalog` (`@glazecalc/catalog` `v0.2.0`), with `184` standard materials + `41` additives and primary-TDS clay data sheets ([glazecalc-submodules.md](glazecalc-submodules.md), [clay-research-to-library.md](clay-research-to-library.md)).
  - **Phase 2 (Teams & blind LAN host):** Collections, custom roles, coded batch sheets, signed revisions & hash-chained audit log, `glaze-vault-hostd` over TLS 1.3 + SPAKE2 pairing, background sync, checkouts, chunked photos, offline limits, device revocation, host backups, and `.gvhost` host migration ([phase-2-lan-host.md](phase-2-lan-host.md)).
  - **Phase 3 (iOS & Android):** Responsive mobile UI, QR pairing as a shop-floor replica, or a phone's own standalone vault backed up via iCloud / Android Auto Backup, camera firing photos, background auto-lock, and native PDF export ([phase-3-mobile.md](phase-3-mobile.md), [../user/phones.md](../user/phones.md)).
  - **Test & CI gates:** `54` Vitest files (`331` tests covering UI decision trees), submodule coverage gates (`core` ≥99/98/99%, `catalog` 100%), `170` Rust workspace tests, `22` desktop E2E scenarios, `5` two-computer + `hostd` LAN E2E scenarios, iOS/Android E2E, `npm audit --audit-level=high`, and desktop installer smoke tests.

---

## Track 1: First Tagged Release (`v0.1.0` / `v0.2.0`) & Signing

See [../releasing.md](../releasing.md) and [../../.github/workflows/release.yml](../../.github/workflows/release.yml).

1. **Pre-release compliance & credentials:**
   - **Export classification ([ADR 3](../adr/0003-encryption-and-keys.md)):** Confirm encryption export classification before the first customer/store release.
   - **Tauri updater key:** `plugins.updater.pubkey` is already configured in `crates/app/tauri.conf.json`. Run `bash scripts/release/set-secrets.sh list` to verify `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are set in the GitHub `release` environment (and that the offline backup of `~/.tauri/glaze-vault.key` + password is stored safely).
   - **OS code signing (recommended before public downloads):**
     - macOS: Apple Developer ID Application `.p12` + notarization app-specific password via `bash scripts/release/set-secrets.sh apple certificate.p12`.
     - Windows: Azure Artifact Signing Individual account + Public Trust profile via `bash scripts/release/set-secrets.sh azure`.
2. **Cut and verify the first draft desktop release:**
   - Bump version in `package.json` and `Cargo.toml` (`[workspace.package]`), update `Cargo.lock`, commit, and push tag `v0.1.0` (never deleting or moving tags; fix-forward with `v0.1.1` if needed).
   - Approve the `release` deployment in GitHub Actions to produce the draft GitHub Release (`.dmg`, `-setup.exe`, `.msi`, `.AppImage`, `.deb`, `.rpm`, and `latest.json`).
   - Manually install and test the built installers on macOS, Windows (including `hostd` Windows service + MSI upgrade), and Linux, then publish the draft and verify an installed copy updates itself cleanly.
3. **Mobile store signing (when ready for App Store / Google Play):**
   - Add App Store Connect API key and Android upload keystore to the `release` environment.

---

## Track 2: Team & LAN Sync Enhancements

Remaining items from [../follow-ups.md](../follow-ups.md):

1. **Host-kept signed audit log:**
   - **Current state:** Each computer verifies signatures and keeps its own local hash-chained audit log (`crates/core/src/vault/audit.rs`).
   - **Plan:** Extend `crates/sync/src/proto.rs`, `crates/core/src/vault/host.rs`, and `crates/core/src/vault/replica.rs` so signed audit entries push to and pull from `hostd`, giving admins a complete studio-wide audit log from any paired computer while keeping `hostd` blind to record contents.
2. **Propagating a rotated organization recovery key:**
   - **Current state:** `new_organization_recovery_key` updates the local `vault.keys` file; paired computers keep their previous organization recovery wrapper until re-paired.
   - **Plan:** Emit a signed directory/keyring event (`crates/core/src/vault/events.rs`, `crates/core/src/keyring.rs`) carrying the new organization recovery key wrapper + public parameters so every paired computer updates its local `vault.keys` on sync.
3. **Remote admin promotion and demotion:**
   - **Current state:** `make_admin` and `take_admin_away` (`crates/core/src/vault/team.rs`) seal `organization_key` using the target person's entry in the local keyring, requiring the change to happen on the host computer (or a computer where they exist in `vault.keys`).
   - **Plan:** Seal `organization_key` to the target person's certified X25519 public key from directory events so any admin can grant or revoke admin status from any paired computer.
4. **Host key rotation on host migration ([ADR 37](../adr/0037-moving-the-host.md)):**
   - **Current state:** Moving a host via `.gvhost` carries the existing certified host key forward.
   - **Plan:** Generate a fresh host key on the destination computer (`crates/core/src/vault/host_key.rs`, `crates/app/src/network/hosting.rs`), certify it under the organization key, distribute the new pin to paired replicas before retiring the old key.
5. **Release local vault mutex during `network::with_host`:**
   - **Current state:** Directory mutations (`people`, `roles`, `collections`) in `crates/app/src/network.rs` (`with_host`) hold `AppState.vault` across the network round-trip while holding the host directory lock.
   - **Plan:** Prepare the signed request under a short lock, perform the network round-trip unlocked (as `sync_now` already does), and re-lock briefly to apply the synced result.

---

## Track 3: Additional Import Formats

See [ADR 10](../adr/0010-importing.md) and `ui/importFormats.ts`:

1. **Glazy YAML dumps:** Parse Glazy recipe/material YAML exports into `ImportPlan`, mapping material names through `@glazecalc/catalog`'s strict/ambiguous matcher (`ui/importFormats.ts` or shared in `lib/catalog`).
2. **Digitalfire material XML (`MDT`):** Add parser + fixtures once a representative real `.xml` / `MDT` export file is in hand to verify field names and LOI/oxide conventions.

---

## Track 4: Updater & Closed-Network Polish

1. **Automated updater & `.rpm` CI verification ([ADR 35](../adr/0035-installer-smoke-test.md)):**
   - Add an automated test serving a local minisign-signed `latest.json` + archive to verify Tauri's updater signature & version check end to end.
   - Extend Linux installer smoke testing in `.github/workflows/ci.yml` to cover `.rpm` alongside `.deb` and `.AppImage`.
2. **LAN update mirror on `hostd` ([ADR 5](../adr/0005-updates-on-closed-networks.md)):**
   - Once signed releases are live (Track 1), let an admin load a signed release bundle onto `hostd` so replicas on air-gapped or shop-floor LANs without internet access can verify and install updates directly from their pinned host.
   - Drop macOS 12 fallback in `crates/hostd` in favor of `SMAppService` if minimum macOS target moves to 13+.
