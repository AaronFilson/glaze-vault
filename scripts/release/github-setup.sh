#!/usr/bin/env bash
# One-time GitHub setup for releases (docs/releasing.md, "Where the keys live"). Run it yourself:
#   bash scripts/release/github-setup.sh
# It makes the `release` environment, which only v* tags may use and which waits for your
# approval, and a ruleset so only repository admins can create, move or delete v* tags.
# Safe to run again: the environment is updated in place, and an existing ruleset is kept.
set -euo pipefail
gh=${GH:-gh}
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
