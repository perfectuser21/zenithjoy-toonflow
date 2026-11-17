#!/usr/bin/env python3
"""停写前发布准入；只读当前服务和卷，缺少条件立即拒绝。"""
import json
import os
from pathlib import Path
import subprocess
import sys


def run(args):
    return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=30).stdout


def main():
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    config=json.loads(Path('/etc/aivideo/release.json').read_text())
    request=json.load(sys.stdin)
    if request['environment'] != config['environment']:
        raise RuntimeError('environment mismatch')
    execution=run(['systemctl','show',config['service'],'--property=ExecStart','--value'])
    if '/usr/bin/docker start -a '+config['container'] not in execution:
        raise RuntimeError('service is not using managed container startup')
    current=json.loads(run(['docker','inspect',config['container']]))[0]
    if not current['State']['Running'] or current['State']['Restarting']:
        raise RuntimeError('current service not running steadily')
    run(['systemctl','is-active','--quiet',config['quotaService']])
    data=Path(config['dataDirectory']).resolve(strict=True)
    volume=Path(config['volumeImage']).resolve(strict=True)
    mount=json.loads(run(['findmnt','-J','-T',str(data),'-o','TARGET,SOURCE,FSTYPE,OPTIONS']))['filesystems'][0]
    if mount['target']!=str(data) or mount['fstype']!='ext4' or 'prjquota' not in mount['options'].split(','):
        raise RuntimeError('quota mount not available')
    backing=json.loads(run(['losetup','-J',mount['source']]))['loopdevices'][0]['back-file']
    if Path(backing).resolve()!=volume:
        raise RuntimeError('volume backing identity mismatch')
    for item in current['Mounts']:
        if item.get('Destination')=='/app/data' and Path(item['Source']).resolve()==data and item.get('RW'):
            break
    else:
        raise RuntimeError('application data binding mismatch')
    backup=Path(config['backupDirectory'])
    if backup.is_symlink() or not backup.is_dir():
        raise RuntimeError('backup directory missing')
    stats=os.statvfs(backup)
    if stats.f_bavail*stats.f_frsize < 2*volume.stat().st_size+1024**3:
        raise RuntimeError('insufficient space for complete volume backup')
    # 确认所有外部实际验收入口已安装；不以文件存在代替业务验收通过。
    for name in ('restoreVerifier','businessVerifier','switchCommand'):
        path=Path(config[name])
        if not path.is_absolute() or not path.is_file() or not os.access(path,os.X_OK):
            raise RuntimeError('required release component unavailable')
    if not isinstance(config['requiredBackupPaths'],list) or not config['requiredBackupPaths'] or config['minimumBackupDatabases']<1:
        raise RuntimeError('backup content contract missing')
    print(json.dumps({'environment':request['environment'],'sourceSha':request['sourceSha'],
                      'image':request['image'],'readinessVerified':True,'deployed':False}))


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        reason=str(error) if isinstance(error,RuntimeError) else type(error).__name__
        print('发布准入未通过: '+reason,file=sys.stderr)
        sys.exit(1)
