#!/usr/bin/env bash
# The host service smoke test (.github/workflows/ci.yml): a team vault, its host's store, a
# computer joined to it, hostd installed as a service with the store, a sync with it over TLS,
# and hostd removed again. Needs an administrator: sudo, or an elevated shell on Windows.
set -euo pipefail

exe=""
sudo="sudo"
if [ "${RUNNER_OS:-}" = Windows ]; then
  exe=".exe"
  sudo=""
fi
client="target/debug/examples/dev-client$exe"
work="${RUNNER_TEMP:-/tmp}/host-service"
rm -rf "$work"
mkdir -p "$work"

"$client" make-team "$work/vault" --as Ana
"$client" prepare "$work/vault" "$work/staging" --as Ana
"$client" join-local "$work/vault" "$work/staging" "$work/replica" --as Ana

# Where an installer would put it: a service cannot run a program from a home folder.
if [ "${RUNNER_OS:-}" = Windows ]; then
  bin="C:/Program Files/Glaze Vault smoke test"
  mkdir -p "$bin"
  cp "target/debug/hostd.exe" "$bin/hostd.exe"
  hostd="$bin/hostd.exe"
else
  $sudo install -m 755 target/debug/hostd /usr/local/bin/hostd
  hostd=/usr/local/bin/hostd
fi

$sudo "$hostd" install --from "$work/staging" --name "Smoke test"
synced=no
for _ in $(seq 30); do
  if "$client" sync "$work/replica" 127.0.0.1:47917 --as Ana; then
    synced=yes
    break
  fi
  sleep 2
done
"$hostd" status || true
if [ "$synced" != yes ]; then
  case "${RUNNER_OS:-}" in
    Linux) $sudo journalctl -u glaze-vault-host --no-pager | tail -50 || true ;;
    macOS) $sudo tail -50 "/Library/Logs/Glaze Vault/hostd.log" || true ;;
    Windows) tail -50 "C:/ProgramData/Glaze Vault/host/hostd.log" || true ;;
  esac
fi
$sudo "$hostd" uninstall
"$hostd" status
[ "$synced" = yes ]
