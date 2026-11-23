#!/usr/bin/env python3
"""生产主机独立通过固定SSH身份读取香港已完成事务，不信任CI传入的声明。"""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from releasePolicy import publicReceipt, releaseIdentityFields, validateReceipt


def privateFile(name):
    path=Path(name)
    if not path.is_absolute():
        raise RuntimeError('witness file must be absolute')
    for item in [path,*path.parents]:
        info=item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid!=0 or info.st_mode & 0o022:
            raise RuntimeError('witness file not protected')
    return str(path)


def witnessPayload(request, operation='receipt'):
    payload={key:request[key] for key in releaseIdentityFields[1:]}
    payload.update(environment='staging',operation=operation)
    return payload


def witnessCommand(config):
    host=config['stagingWitnessHost']; user=config['stagingWitnessUser']
    if not re.fullmatch(r'[a-zA-Z0-9.-]+',host) or not re.fullmatch(r'[a-z_][a-z0-9_-]*',user):
        raise RuntimeError('invalid witness target')
    port=config.get('stagingWitnessPort',22)
    if type(port) is not int or not 1<=port<=65535:
        raise RuntimeError('invalid witness port')
    return ['ssh','-T','-p',str(port),'-i',privateFile(config['stagingWitnessKey']),
            '-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',
            '-o','UserKnownHostsFile='+privateFile(config['stagingWitnessKnownHosts']),
            '-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',
            user+'@'+host,'/usr/local/sbin/aivideo-read-release']


def main():
    if os.geteuid()!=0:
        raise RuntimeError('root required')
    privateFile('/etc/aivideo/release.json')
    config=json.loads(Path('/etc/aivideo/release.json').read_text())
    if config['environment']!='production':
        raise RuntimeError('production witness only')
    request=json.load(sys.stdin)
    payload=witnessPayload(request)
    result=subprocess.run(witnessCommand(config), input=json.dumps(payload),capture_output=True,
                          text=True,check=True,timeout=45,
                          env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'})
    receipt=json.loads(result.stdout)
    validateReceipt(receipt,payload,'staging')
    print(json.dumps(publicReceipt(receipt)))


if __name__=='__main__':
    try:
        main()
    except Exception:
        print('无法独立确认香港已完成的业务验收回执。',file=sys.stderr)
        sys.exit(1)
