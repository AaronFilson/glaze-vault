#!/usr/bin/env bash
# Puts signing secrets into the GitHub `release` environment straight from files and prompts,
# so they never pass through the clipboard or shell history (docs/releasing.md). Run it yourself:
#   bash scripts/release/set-secrets.sh updater   # the Tauri updater key
#   bash scripts/release/set-secrets.sh apple     # Developer ID certificate and notarization
#   bash scripts/release/set-secrets.sh azure     # Azure Artifact Signing
#   bash scripts/release/set-secrets.sh list      # names set so far (values are never shown)
# GitHub secrets cannot be read back, by you or anyone: keep your own offline copy of each key.
set -euo pipefail
gh=${GH:-gh}
repo=${REPO:-AaronFilson/glaze-vault}
put() { $gh secret set "$1" --repo "$repo" --env release; }       # value from stdin
var() { $gh variable set "$1" --repo "$repo" --env release --body "$2"; }
ask() { local v; read -r -s -p "$1: " v; echo >&2; printf '%s' "$v"; }
askv() { local v; read -r -p "$1: " v; printf '%s' "$v"; }

case "${1:-}" in
  updater)
    key=${2:-$HOME/.tauri/glaze-vault.key}
    [ -f "$key" ] || { echo "No key at $key: run 'npx tauri signer generate -w $key' first" >&2; exit 1; }
    put TAURI_SIGNING_PRIVATE_KEY < "$key"
    ask "The updater key's password" | put TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    echo "Public key for crates/app/tauri.conf.json plugins.updater.pubkey:"
    cat "$key.pub"; echo ;;
  apple)
    p12=${2:?give the .p12 file: set-secrets.sh apple certificate.p12}
    openssl base64 -A -in "$p12" | put APPLE_CERTIFICATE
    ask "The .p12 password" | put APPLE_CERTIFICATE_PASSWORD
    askv "Signing identity, as Keychain shows it (Developer ID Application: Name (TEAMID))" | put APPLE_SIGNING_IDENTITY
    askv "Apple Account email" | put APPLE_ID
    ask "App-specific password" | put APPLE_PASSWORD
    askv "Team ID (10 characters)" | put APPLE_TEAM_ID
    echo "Now delete $p12 from this disk (keep the offline copy)." ;;
  azure)
    askv "AZURE_CLIENT_ID (app registration)" | put AZURE_CLIENT_ID
    ask "AZURE_CLIENT_SECRET" | put AZURE_CLIENT_SECRET
    askv "AZURE_TENANT_ID" | put AZURE_TENANT_ID
    var AZURE_SIGNING_ENDPOINT "$(askv 'Signing endpoint, such as https://eus.codesigning.azure.net')"
    var AZURE_SIGNING_ACCOUNT "$(askv 'Signing account name')"
    var AZURE_SIGNING_PROFILE "$(askv 'Certificate profile name')" ;;
  list)
    echo "Secrets:"; $gh secret list --repo "$repo" --env release
    echo "Variables:"; $gh variable list --repo "$repo" --env release ;;
  *) sed -n '2,9p' "$0"; exit 1 ;;
esac
