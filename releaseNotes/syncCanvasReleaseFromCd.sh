#!/usr/bin/env bash
set -euo pipefail
run="${NOTES_RUN:-$GITHUB_RUN_ID}"
replay=false
if [[ -n "${NOTES_RUN:-}" ]]; then replay=true; fi
[[ "$run" =~ ^[1-9][0-9]{0,19}$ ]]
metadata=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run")
jq -e --arg repo "$GITHUB_REPOSITORY" --arg current "$GITHUB_RUN_ID" '
    .head_repository.full_name == $repo and .head_branch == "master" and
    .path == ".github/workflows/canvasDelivery.yml" and
    (.event == "push" or .event == "workflow_dispatch") and
    ((.id | tostring) == $current or .status == "completed")
' <<< "$metadata" >/dev/null
jobs=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run/jobs?filter=latest&per_page=100")
job=$(jq -cer '
    [.jobs[] | select((.name == "staging" or .name == "production") and
       (.conclusion == "success" or .conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out"))]
    | if length == 1 then .[0] else error("expected one completed Canvas deployment job") end
' <<< "$jobs")
environment=$(jq -er '.name' <<< "$job")
attempt=$(jq -er '.run_attempt | tostring' <<< "$job")
[[ "$attempt" =~ ^[1-9][0-9]{0,19}$ ]]
digest=$(jq -er '.head_sha' <<< "$metadata")
outcome=$(jq -er '
    [.steps[]? | select(.name == "Deploy and verify Hong Kong customer staging" or
      .name == "Promote same digest to Hangzhou") | .conclusion] | first // "skipped"
' <<< "$job")
if [[ "$outcome" == skipped ]]; then
    outcome=$(jq -er '.conclusion' <<< "$job")
fi

umask 077
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
if [[ "$environment" == production ]]; then
    gh run download "$run" --repo "$GITHUB_REPOSITORY" --name "production-release-context-$attempt" --dir "$temp/context"
    digest=$(jq -er '.sourceSha' "$temp/context/releaseContext.json")
fi
[[ "$digest" =~ ^[a-f0-9]{40}$ ]]
printf 'null\n' > "$temp/receipt.json"
if [[ "$outcome" == success ]]; then
    gh run download "$run" --repo "$GITHUB_REPOSITORY" --name "$environment-release-$attempt" --dir "$temp/release"
    PYTHONPATH=deploy/delivery python3 -B - "$temp/release/releaseReceipt.json" "$environment" "$digest" "$run" "$attempt" \
        > "$temp/receipt.json" <<'PY'
import json, sys
from releasePolicy import validateReceipt

path, environment, source, run, attempt = sys.argv[1:]
with open(path) as stream:
    receipt = json.load(stream)
if environment == 'production':
    run, attempt = receipt['runId'], receipt['runAttempt']
validateReceipt(receipt, {'image': receipt['image'], 'sourceSha': source,
                          'runId': run, 'runAttempt': attempt}, environment)
print(json.dumps({key: receipt[key] for key in ('environment', 'sourceSha', 'image', 'bootId', 'businessVerified')}))
PY
fi
jq -n --arg site "$environment" --arg digest "$digest" --arg run "$run" --arg outcome "$outcome" \
    --argjson replay "$replay" --slurpfile receipt "$temp/receipt.json" \
    '{environment: $site, sourceSha: $digest, run: $run, outcome: $outcome, receipt: $receipt[0], replay: $replay}' > "$temp/event.json"

printf '%s\n' "${NOTES_SSH_KEY:?Missing release notes SSH key}" > "$temp/key"
printf '%s\n' "${NOTES_KNOWN_HOSTS:?Missing release notes host key}" > "$temp/known_hosts"
result=$(ssh -F /dev/null -T -i "$temp/key" -p "${NOTES_PORT:?}" -o BatchMode=yes -o IdentitiesOnly=yes \
    -o IdentityAgent=none -o StrictHostKeyChecking=yes -o GlobalKnownHostsFile=/dev/null \
    -o UserKnownHostsFile="$temp/known_hosts" -o ClearAllForwardings=yes -o ConnectTimeout=12 \
    -o ServerAliveInterval=10 -o ServerAliveCountMax=3 "canvas-notes@${NOTES_HOST:?}" < "$temp/event.json")
printf '%s\n' "$result"
printf '### Notion release notes\n\n%s\n' "$result" >> "$GITHUB_STEP_SUMMARY"
