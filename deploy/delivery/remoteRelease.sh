#!/usr/bin/env bash
set -euo pipefail
# 发布调用入口；远端控制器必须由运维预先安装，禁止执行仓库下发的任意 root 命令。
: "${RELEASE_HOST:?Missing environment host}"
: "${RELEASE_USER:?Missing environment user}"
: "${RELEASE_KEY:?Missing dedicated release key}"
: "${RELEASE_KNOWN_HOSTS:?Missing pinned SSH host keys}"
: "${RELEASE_IMAGE:?Missing immutable candidate}"
: "${RELEASE_SHA:?Missing source revision}"
: "${RELEASE_ENVIRONMENT:?Missing environment}"
[[ "$RELEASE_HOST" =~ ^[a-zA-Z0-9.-]+$ ]]
[[ "$RELEASE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$RELEASE_IMAGE" =~ ^ghcr.io/perfectuser21/zenithjoy-toonflow@sha256:[a-f0-9]{64}$ ]]
[[ "$RELEASE_ENVIRONMENT" == staging || "$RELEASE_ENVIRONMENT" == production ]]
releaseTmp=$(mktemp -d)
trap 'rm -rf "$releaseTmp"' EXIT
chmod 700 "$releaseTmp"
printf '%s\n' "$RELEASE_KEY" > "$releaseTmp/key"
printf '%s\n' "$RELEASE_KNOWN_HOSTS" > "$releaseTmp/knownHosts"
chmod 600 "$releaseTmp/key" "$releaseTmp/knownHosts"
# 请求通过 stdin 传输；公网入口与模型密钥不写入发布回执。
python3 - <<'PY' > "$releaseTmp/request.json"
import os,json
request={'environment':os.environ['RELEASE_ENVIRONMENT'],'sourceSha':os.environ['RELEASE_SHA'],'image':os.environ['RELEASE_IMAGE'],'runId':os.environ['GITHUB_RUN_ID'],'runAttempt':os.environ['GITHUB_RUN_ATTEMPT']}
if request['environment']=='production':
    stage=json.loads(os.environ['RELEASE_STAGING_RECEIPT'])
    assert stage['environment']=='staging' and stage['sourceSha']==request['sourceSha'] and stage['image']==request['image']
    assert stage['runId']==request['runId'] and stage['runAttempt']==request['runAttempt']
    assert stage['result']=='passed' and stage['businessVerified'] is True
    request['stagingReceipt']=stage
print(json.dumps(request))
PY
ssh -T -i "$releaseTmp/key" -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$releaseTmp/knownHosts" \
  -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
  "$RELEASE_USER@$RELEASE_HOST" /usr/local/sbin/aivideo-release \
  < "$releaseTmp/request.json" > "$releaseTmp/receipt.json"
python3 - "$releaseTmp/request.json" "$releaseTmp/receipt.json" <<'PY'
import json,sys,os
request=json.load(open(sys.argv[1])); receipt=json.load(open(sys.argv[2]))
for key in ('environment','sourceSha','image','runId','runAttempt'):
    assert receipt[key]==request[key],f'receipt mismatch: {key}'
assert receipt['result']=='passed' and receipt['businessVerified'] is True
assert receipt['runningImage']==request['image']
if request['environment']=='production':
    assert receipt['backupVerified'] is True and receipt['restoreVerified'] is True
    assert receipt['predecessorImage'] and receipt['backupId']
# 仅公开固定白名单字段，原始远端输出不打印到 CI 日志。
keys=('environment','sourceSha','image','runId','runAttempt','result','businessVerified','runningImage','backupVerified','restoreVerified','predecessorImage','backupId')
public={k:receipt[k] for k in keys if k in receipt}
encoded=json.dumps(public,separators=(',',':'))
with open('releaseReceipt.json','w') as f: f.write(encoded+'\n')
with open(os.environ['GITHUB_OUTPUT'],'a') as f: f.write('receipt='+encoded+'\n')
PY
