#!/usr/bin/env python3
"""香港只读见证入口，专用 SSH 身份只能经受限 sudo 调用此程序。"""
import json
import os
import subprocess
import sys



def main():
    if os.geteuid()!=0:
        raise RuntimeError('root required')
    data=sys.stdin.buffer.read(8193)
    if len(data)>8192:
        raise RuntimeError('request too large')
    request=json.loads(data)
    keys={'sourceSha','image','runId','runAttempt','environment','operation'}
    if set(request)!=keys or request['environment']!='staging' or request['operation']!='receipt':
        raise RuntimeError('witness identity only permits validated release reads')
    request['operation']='receipt'
    # 即使调用者改变JSON也不能进入deploy/preflight；命令、路径均固定。
    result=subprocess.run(['/usr/local/sbin/aivideo-release'],input=json.dumps(request),
                          capture_output=True,text=True,check=True,timeout=35,
                          env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'})
    receipt=json.loads(result.stdout)
    for key in ('environment','sourceSha','image','runId','runAttempt'):
        if receipt.get(key)!=request[key]:
            raise RuntimeError('witness receipt identity mismatch')
    if (receipt.get('publicOrigin')!='https://toonflow.zenjoymedia.media'
            or receipt.get('result')!='passed' or receipt.get('businessVerified') is not True
            or receipt.get('runningImage')!=request['image']):
        raise RuntimeError('witness receipt not passed')
    fields=('publicOrigin','environment','sourceSha','image','runId','runAttempt','result',
            'businessVerified','runningImage','backupVerified','restoreVerified','predecessorImage','backupId','transfer')
    print(json.dumps({key:receipt[key] for key in fields if key in receipt}))


if __name__=='__main__':
    try:
        main()
    except Exception:
        print('香港只读发布见证未通过。',file=sys.stderr)
        sys.exit(1)
