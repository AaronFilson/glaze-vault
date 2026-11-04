#!/usr/bin/env bash
# One-time GitHub setup for releases (docs/releasing.md, "Where the keys live"). Run it yourself:
#   bash scripts/release/github-setup.sh
# It makes the `release` environment, which only v* tags may use and which waits for your
# approval, and a ruleset so only repository admins can create, move or delete v* tags.
# Safe to run again: the environment is updated in place, and an existing ruleset is kept.
set -euo pipefail
# gh: $GH if given, else gh on the PATH, else the copy in ~/gh_*/bin. A stale GITHUB_TOKEN in the
# environment would override gh's own login, so it is dropped.
unset GITHUB_TOKEN
gh=${GH:-$(command -v gh || ls -d "$HOME"/gh_*/bin/gh 2>/dev/null | tail -1)}
[ -n "$gh" ] && [ -x "${gh%% *}" -o -n "$(command -v "${gh%% *}")" ] || { echo "Can't find gh: install it or run with GH=/path/to/gh" >&2; exit 1; }
$gh auth status >/dev/null 2>&1 || { echo "gh isn't logged in: run '$gh auth login' first" >&2; exit 1; }
repo=${REPO:-AaronFilson/glaze-vault}
me=$($gh api user --jq .id)

echo "Environment 'release', approved by user $me, for v* tags only"
$gh api -X PUT "repos/$repo/environments/release" --input - >/dev/null <<JSON
{"wait_timer":0,"prevent_self_review":false,"reviewers":[{"type":"User","id":$me}],
 "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
if ! $gh api "repos/$repo/environments/release/deployment-branch-policies" \
     --jq '.branch_policies[] | select(.type=="tag" and .name=="v*") | .id' | grep -q .; then
  $gh api -X POST "repos/$repo/environments/release/deployment-branch-policies" \
    -f name='v*' -f type=tag >/dev/null
fi

if $gh api "repos/$repo/rulesets" --jq '.[].name' | grep -qx 'Release tags'; then
  echo "Ruleset 'Release tags' already there"
else
  echo "Ruleset 'Release tags': only admins create, move or delete v* tags"
  $gh api -X POST "repos/$repo/rulesets" --input - >/dev/null <<'JSON'
{"name":"Release tags","target":"tag","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},
 "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}],
 "rules":[{"type":"creation"},{"type":"update"},{"type":"deletion"},{"type":"non_fast_forward"}]}
JSON
fi
echo "Done. Secrets now go into the environment: bash scripts/release/set-secrets.sh updater"
