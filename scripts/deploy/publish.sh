#!/usr/bin/env bash
# GitHub runner entry point. The server never needs GitHub credentials or a git pull.
set -euo pipefail

: "${DEPLOY_HOST:?Set production variable DEPLOY_HOST}"
: "${DEPLOY_PORT:?Set production variable DEPLOY_PORT}"
: "${DEPLOY_USER:?Set production variable DEPLOY_USER}"
: "${DEPLOY_SSH_KEY:?Set production secret DEPLOY_SSH_KEY}"
: "${DEPLOY_KNOWN_HOSTS:?Set production secret DEPLOY_KNOWN_HOSTS}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/acerciae}"
[[ "$DEPLOY_ROOT" == /srv/acerciae ]] || { echo 'This deployment targets /srv/acerciae only'; exit 1; }
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]
[[ "$DEPLOY_PORT" =~ ^[0-9]{1,5}$ ]]
[[ "$DEPLOY_USER" == deploy ]]
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ && "$GITHUB_RUN_NUMBER" =~ ^[0-9]+$ ]]
[[ "$GITHUB_REF" == refs/heads/online && "$GITHUB_EVENT_NAME" == push ]]

# A slow older CI run must not roll production back after a newer merge.
latest="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/online" --jq .object.sha)"
if [[ "$latest" != "$GITHUB_SHA" ]]; then
  echo 'A newer online commit exists; skipping this superseded release.'
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
chmod 700 "$work"
printf '%s\n' "$DEPLOY_SSH_KEY" > "$work/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$work/known_hosts"
chmod 600 "$work/key" "$work/known_hosts"
unset DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS
ssh_options=(-F /dev/null -i "$work/key" -o IdentitiesOnly=yes -o BatchMode=yes
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$work/known_hosts"
  -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
target="$DEPLOY_USER@$DEPLOY_HOST"
release_id="$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
incoming="$DEPLOY_ROOT/incoming/$release_id"

git archive --format=tar.gz --output="$work/source.tar.gz" "$GITHUB_SHA" backend pdf-worker
ssh "${ssh_options[@]}" -p "$DEPLOY_PORT" "$target" "mkdir -p '$incoming'"
scp "${ssh_options[@]}" -P "$DEPLOY_PORT" "$work/source.tar.gz" scripts/deploy/deploy.py "$target:$incoming/"
ssh "${ssh_options[@]}" -p "$DEPLOY_PORT" "$target" \
  "bash -o pipefail -c 'python3 -u $incoming/deploy.py --archive $incoming/source.tar.gz --commit $GITHUB_SHA --release-id $release_id --run-number $GITHUB_RUN_NUMBER 2>&1 | tee $incoming/deploy.log'"

# Check the public route from outside the server too; a failure here leaves the
# locally healthy deployment running and is visible as a failed Actions job.
curl --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 3 \
  --connect-timeout 10 --max-time 20 https://trpg.missazertia.com:15510/api/health \
  | python3 -c 'import json,sys; h=json.load(sys.stdin); assert h.get("status")=="ok" and h.get("db")=="ok", h'
echo "Backend deployment verified: $GITHUB_SHA" >> "$GITHUB_STEP_SUMMARY"
