#!/usr/bin/env python3
"""生产主机独立通过固定SSH身份读取香港已完成事务，不信任CI传入的声明。"""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


def privateFile(name):
    path=Path(name)
    if not path.is_absolute():
        raise RuntimeError('witness file must be absolute')
    for item in [path,*path.parents]:
        info=item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid!=0 or info.st_mode & 0o022:
            raise RuntimeError('witness file not protected')
    return str(path)


def main():
    if os.geteuid()!=0:
        raise RuntimeError('root required')
    config=json.loads(Path('/etc/aivideo/release.json').read_text())
    if config['environment']!='production':
        raise RuntimeError('production witness only')
    request=json.load(sys.stdin)
    host=config['stagingWitnessHost']; user=config['stagingWitnessUser']
    if not re.fullmatch(r'[a-zA-Z0-9.-]+',host) or not re.fullmatch(r'[a-z_][a-z0-9_-]*',user):
        raise RuntimeError('invalid witness target')
    port=config.get('stagingWitnessPort',22)
    if type(port) is not int or not 1<=port<=65535:
        raise RuntimeError('invalid witness port')
    payload={key:request[key] for key in ('sourceSha','image','runId','runAttempt')}
    payload.update(environment='staging',operation='receipt')
    result=subprocess.run(['ssh','-T','-p',str(port),'-i',privateFile(config['stagingWitnessKey']),
                           '-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',
                           '-o','UserKnownHostsFile='+privateFile(config['stagingWitnessKnownHosts']),
                           '-o','ConnectTimeout=15',user+'@'+host,'/usr/local/sbin/aivideo-read-release'],
                          input=json.dumps(payload),capture_output=True,text=True,check=True,timeout=45)
    receipt=json.loads(result.stdout)
    for key in ('environment','sourceSha','image','runId','runAttempt'):
        if receipt.get(key)!=payload[key]:
            raise RuntimeError('staging witness identity mismatch')
    if receipt.get('publicOrigin')!='https://toonflow.zenjoymedia.media':
        raise RuntimeError('witness refers to a different staging entry')
    if receipt.get('result')!='passed' or receipt.get('businessVerified') is not True or receipt.get('runningImage')!=payload['image']:
        raise RuntimeError('staging witness not passed')
    print(json.dumps(receipt))


if __name__=='__main__':
    try:
        main()
    except Exception:
        print('无法独立确认香港已完成的业务验收回执。',file=sys.stderr)
        sys.exit(1)
