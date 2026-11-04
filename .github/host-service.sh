#!/usr/bin/env bash
# The host service smoke test (.github/workflows/ci.yml): a team vault, its host's store, a
# computer joined to it, hostd installed as a service with the store, a sync with it over TLS,
# the service checked to run as its own user with its key protected (docs/adr/0038-hardening-hostd.md),
# the host moved by a .gvhost file to a store unpacked by an admin and synced with again
# (docs/adr/0037-moving-the-host.md), and hostd removed. Needs an administrator: sudo, or an
# elevated shell on Windows.
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

synced() {
  for _ in $(seq 30); do
    if "$client" sync "$work/replica" 127.0.0.1:47917 --as Ana; then
      return 0
    fi
    sleep 2
  done
  "$hostd" status || true
  case "${RUNNER_OS:-}" in
    Linux) $sudo journalctl -u glaze-vault-host --no-pager | tail -50 || true ;;
    macOS) $sudo tail -50 "/Library/Logs/Glaze Vault/hostd.log" || true ;;
    Windows) tail -50 "C:/ProgramData/Glaze Vault/host/hostd.log" || true ;;
  esac
  $sudo "$hostd" uninstall || true
  echo "::error::the replica did not sync with the service"
  return 1
}

fail() {
  echo "::error::$1"
  $sudo "$hostd" uninstall || true
  exit 1
}

# How the service runs, on each system.
hardened() {
  case "${RUNNER_OS:-}" in
    macOS)
      data="/Library/Application Support/Glaze Vault/host"
      dscl . -read /Users/_glazevault UniqueID UserShell IsHidden || fail "no _glazevault user"
      [ "$(ps -o user= -p "$(pgrep -x hostd | head -1)" | tr -d ' ')" = _glazevault ] || fail "hostd is not run as _glazevault"
      [ "$($sudo stat -f '%Su %Lp' "$data")" = "_glazevault 700" ] || fail "the store is not _glazevault's alone"
      ;;
    Linux)
      systemctl show -p DynamicUser -p ProtectSystem glaze-vault-host
      systemd-analyze security glaze-vault-host --no-pager | tail -1 || true
      [ "$(ps -o user= -p "$(systemctl show -p MainPID --value glaze-vault-host)" | tr -d ' ')" != root ] || fail "hostd runs as root"
      ;;
    Windows)
      data="C:/ProgramData/Glaze Vault/host"
      [ -f "$data/host.key.dpapi" ] || fail "host.key is not kept under DPAPI"
      [ ! -e "$data/host.key" ] || fail "a plain host.key is left"
      ;;
  esac
}

$sudo "$hostd" install --from "$work/staging" --name "Smoke test"
synced
hardened

# The host moves: its store exported as one file, the service removed, an admin's computer
# unpacking the file with the organization's key, and the service installed with that. The
# replica's pin holds, as the key moved with the store.
$sudo "$hostd" export "$work/moving.gvhost"
$sudo chmod 644 "$work/moving.gvhost" 2>/dev/null || true
$sudo "$hostd" uninstall
"$client" unpack "$work/replica" "$work/moving.gvhost" "$work/moved" --as Ana
$sudo "$hostd" install --from "$work/moved" --name "Smoke test"
synced
hardened

$sudo "$hostd" uninstall
"$hostd" status
if [ "${RUNNER_OS:-}" = macOS ] && dscl . -read /Users/_glazevault >/dev/null 2>&1; then
  fail "the _glazevault user is left after uninstalling"
fi
