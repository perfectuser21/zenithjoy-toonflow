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
[[ "$RELEASE_HOST" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] || exit 1
[[ "$RELEASE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || exit 1
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 1
[[ "$RELEASE_IMAGE" =~ ^ghcr.io/perfectuser21/zenithjoy-toonflow@sha256:[a-f0-9]{64}$ ]] || exit 1
if [[ "$RELEASE_ENVIRONMENT" != staging && "$RELEASE_ENVIRONMENT" != production ]]; then
  echo 'Invalid release environment' >&2; exit 1
fi
releasePort="${RELEASE_PORT:-22}"
[[ "$releasePort" =~ ^[0-9]{1,5}$ ]] || exit 1
(( 10#$releasePort > 0 && 10#$releasePort <= 65535 )) || exit 1
jumpCount=0
for jumpName in RELEASE_JUMP_HOST RELEASE_JUMP_PORT RELEASE_JUMP_USER RELEASE_JUMP_KEY RELEASE_JUMP_KNOWN_HOSTS; do
  if [[ -n "${!jumpName:-}" ]]; then ((jumpCount+=1)); fi
done
if (( jumpCount != 0 )); then
  if [[ "$RELEASE_ENVIRONMENT" != production || "$jumpCount" != 5 ]]; then
    echo 'Jump settings require production and all five values' >&2; exit 1
  fi
  [[ "$RELEASE_JUMP_HOST" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] || exit 1
  [[ "$RELEASE_JUMP_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || exit 1
  [[ "$RELEASE_JUMP_PORT" =~ ^[0-9]{1,5}$ ]] || exit 1
  (( 10#$RELEASE_JUMP_PORT > 0 && 10#$RELEASE_JUMP_PORT <= 65535 )) || exit 1
fi
umask 077
releaseTmp=$(mktemp -d /tmp/aivideo-release.XXXXXXXX)
trap 'rm -rf "$releaseTmp"' EXIT
chmod 700 "$releaseTmp"
printf '%s\n' "$RELEASE_KEY" > "$releaseTmp/key"
printf '%s\n' "$RELEASE_KNOWN_HOSTS" > "$releaseTmp/knownHosts"
chmod 600 "$releaseTmp/key" "$releaseTmp/knownHosts"
if (( jumpCount == 5 )); then
  printf '%s\n' "$RELEASE_JUMP_KEY" > "$releaseTmp/jumpKey"
  printf '%s\n' "$RELEASE_JUMP_KNOWN_HOSTS" > "$releaseTmp/jumpKnownHosts"
  chmod 600 "$releaseTmp/jumpKey" "$releaseTmp/jumpKnownHosts"
fi
{
  printf 'Host releaseTarget\n  HostName %s\n  User %s\n  Port %s\n' "$RELEASE_HOST" "$RELEASE_USER" "$releasePort"
  printf '  IdentityFile %s/key\n  UserKnownHostsFile %s/knownHosts\n' "$releaseTmp" "$releaseTmp"
  if (( jumpCount == 5 )); then
    printf '  ProxyJump releaseJump\n'
    printf 'Host releaseJump\n  HostName %s\n  User %s\n  Port %s\n' "$RELEASE_JUMP_HOST" "$RELEASE_JUMP_USER" "$RELEASE_JUMP_PORT"
    printf '  IdentityFile %s/jumpKey\n  UserKnownHostsFile %s/jumpKnownHosts\n' "$releaseTmp" "$releaseTmp"
  fi
  printf 'Host *\n  BatchMode yes\n  IdentitiesOnly yes\n  IdentityAgent none\n  ForwardAgent no\n  StrictHostKeyChecking yes\n  GlobalKnownHostsFile /dev/null\n  ClearAllForwardings yes\n  ControlMaster no\n  ConnectTimeout 15\n  ServerAliveInterval 15\n  ServerAliveCountMax 4\n'
} > "$releaseTmp/config"
chmod 600 "$releaseTmp/config"
# 请求通过 stdin 传输；公网入口与模型密钥不写入发布回执。
"${RUNNER_TEMP:?Missing runner temp}/cos-venv/bin/python" - <<'PY' > "$releaseTmp/request.json" 2>/dev/null
import os,json,logging,re
from qcloud_cos import CosConfig,CosS3Client
logging.disable(logging.CRITICAL)
request={'environment':os.environ['RELEASE_ENVIRONMENT'],'sourceSha':os.environ['RELEASE_SHA'],'image':os.environ['RELEASE_IMAGE'],'runId':os.environ['GITHUB_RUN_ID'],'runAttempt':os.environ['GITHUB_RUN_ATTEMPT']}
key=os.environ['RELEASE_COS_KEY']; digest=os.environ['RELEASE_COS_SHA256']; length=int(os.environ['RELEASE_COS_BYTES'])
assert key==f"aivideoReleases/{request['sourceSha']}/{request['runId']}/{request['runAttempt']}/image.oci"
assert re.fullmatch(r'[a-f0-9]{64}',digest) and 0<length<=768*1024*1024
client=CosS3Client(CosConfig(Region=os.environ['CANVAS_COS_REGION'],SecretId=os.environ['CANVAS_COS_SECRET_ID'],
                             SecretKey=os.environ['CANVAS_COS_SECRET_KEY'],Scheme='https',EnableOldDomain=True))
url=client.get_presigned_url(Method='GET',Bucket=os.environ['CANVAS_COS_BUCKET'],Key=key,Expired=7200)
transfer={'key':key,'sha256':digest,'bytes':length}
if request['environment']=='production':
    stage=json.loads(os.environ['RELEASE_STAGING_RECEIPT'])
    assert stage['environment']=='staging' and stage['sourceSha']==request['sourceSha'] and stage['image']==request['image']
    assert stage['runId']==request['runId'] and stage['runAttempt']==request['runAttempt']
    assert stage['result']=='passed' and stage['businessVerified'] is True
    assert stage['transfer']==transfer
    request['stagingReceipt']=stage
request['transfer']={**transfer,'url':url}
print(json.dumps(request))
PY
ssh -F "$releaseTmp/config" -T releaseTarget /usr/local/sbin/aivideo-release \
  < "$releaseTmp/request.json" > "$releaseTmp/receipt.json"
python3 - "$releaseTmp/request.json" "$releaseTmp/receipt.json" <<'PY'
import json,sys,os
request=json.load(open(sys.argv[1])); receipt=json.load(open(sys.argv[2]))
origins={'staging':'https://toonflow.zenjoymedia.media','production':'https://aivideo.zenithjoy.tech'}
assert receipt.get('publicOrigin')==origins[request['environment']], 'release public origin mismatch'
for key in ('environment','sourceSha','image','runId','runAttempt'):
    assert receipt[key]==request[key],f'receipt mismatch: {key}'
assert receipt['result']=='passed' and receipt['businessVerified'] is True
assert receipt['runningImage']==request['image']
assert receipt['transfer']=={k:request['transfer'][k] for k in ('key','sha256','bytes')}
if request['environment']=='production':
    assert receipt['backupVerified'] is True and receipt['restoreVerified'] is True
    assert receipt['predecessorImage'] and receipt['backupId']
# 仅公开固定白名单字段，原始远端输出不打印到 CI 日志。
keys=('publicOrigin','environment','sourceSha','image','runId','runAttempt','result','businessVerified','runningImage','backupVerified','restoreVerified','predecessorImage','backupId','transfer')
public={k:receipt[k] for k in keys if k in receipt}
encoded=json.dumps(public,separators=(',',':'))
with open('releaseReceipt.json','w') as f: f.write(encoded+'\n')
with open(os.environ['GITHUB_OUTPUT'],'a') as f: f.write('receipt='+encoded+'\n')
PY
