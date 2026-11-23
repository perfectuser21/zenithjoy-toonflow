#!/usr/bin/env python3
"""停写前发布准入；只读当前服务和卷，缺少条件立即拒绝。"""
import json
import os
from pathlib import Path, PurePosixPath
from releasePolicy import requireQuotaVolume
from verifyBusiness import newPublicClient, rootJson, validateBusinessConfig, verifyApplicationDataMount
from verifyGeneration import studioGenerationCase, validateGenerationConfig, verifyPointsBudget
from runtimeReadiness import verifyRuntimeReadiness
from volumeSnapshot import scanVolume, requireSpace, capsuleSize, reserve, requireCapsuleFilesystem
import subprocess
import sys


def run(args):
    return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=30).stdout


def main():
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    config=rootJson('/etc/aivideo/release.json')
    requireQuotaVolume(config)
    request=json.load(sys.stdin)
    if request['environment'] != config['environment']:
        raise RuntimeError('environment mismatch')
    business=rootJson(config['businessConfig'],private=True)
    if business['environment']!=request['environment'] or business['publicOrigin']!=config['publicOrigin']:
        raise RuntimeError('business contract identity mismatch')
    workspaces=validateBusinessConfig(business)
    payload, _, account = validateGenerationConfig(business)
    if request['environment'] == 'staging':
        client = newPublicClient(business)
        client.login(account)
        verifyPointsBudget(client, payload)
        studioPayload, _, studioAccount = studioGenerationCase(business)
        studioClient = newPublicClient(business)
        studioClient.login(studioAccount)
        verifyPointsBudget(studioClient, studioPayload, business['studioImageVerification'])
    execution=run(['systemctl','show',config['service'],'--property=ExecStart','--value'])
    if '/usr/bin/docker start -a '+config['container'] not in execution:
        raise RuntimeError('service is not using managed container startup')
    current=json.loads(run(['docker','inspect',config['container']]))[0]
    if not current['State']['Running'] or current['State']['Restarting']:
        raise RuntimeError('current service not running steadily')
    run(['systemctl','is-active','--quiet',config['quotaService']])
    data,target=verifyApplicationDataMount(config,current)
    volume=Path(config['volumeImage']).resolve(strict=True)
    mount=json.loads(run(['findmnt','-J','-T',str(data),'-o','TARGET,SOURCE,FSTYPE,OPTIONS']))['filesystems'][0]
    if mount['target']!=str(data) or mount['fstype']!='ext4' or 'prjquota' not in mount['options'].split(','):
        raise RuntimeError('quota mount not available')
    backing=json.loads(run(['losetup','-J','-l',mount['source']]))['loopdevices'][0]['back-file']
    if Path(backing).resolve()!=volume:
        raise RuntimeError('volume backing identity mismatch')
    # 配额控制目录可以单独绑定，验收画布仍必须落在同一备份卷中。
    for workspace in workspaces:
        containerPath=PurePosixPath(workspace['directory'])/workspace['canvasPath']
        binding=max((item for item in current['Mounts']
                     if containerPath.is_relative_to(PurePosixPath(item['Destination']))),
                    key=lambda item:len(PurePosixPath(item['Destination']).parts), default=None)
        if (not binding or binding.get('Type')!='bind' or not binding.get('RW')
                or not containerPath.is_relative_to(target)):
            raise RuntimeError('acceptance seed is not on writable data bind')
        hostRoot=Path(binding['Source']).resolve(strict=True)
        seed=hostRoot/str(containerPath.relative_to(PurePosixPath(binding['Destination'])))
        resolved=seed.resolve(strict=True)
        if (not hostRoot.is_relative_to(data) or seed.is_symlink() or not resolved.is_relative_to(hostRoot)
                or not resolved.is_file() or resolved.stat().st_dev!=data.stat().st_dev
                or resolved.stat().st_size>4*1024*1024):
            raise RuntimeError('acceptance seed escapes quota volume or exceeds limit')
        value=json.loads(resolved.read_text())
        if value.get('deliveryAcceptance') is not True or value.get('toonflowCanvas') is not True:
            raise RuntimeError('dedicated acceptance seed missing explicit marker')
    backup=Path(config['backupDirectory'])
    if backup.is_symlink() or not backup.is_dir():
        raise RuntimeError('backup directory missing')
    requireCapsuleFilesystem(backup)
    capacity = capsuleSize(config)
    requireSpace(backup, capacity + reserve)
    estimate = scanVolume(volume)
    if 2 * estimate['estimatedPayloadBytes'] + 64 * 1024**2 > capacity:
        raise RuntimeError('configured backup capsule too small for estimated contents')
    # 确认所有外部实际验收入口已安装；不以文件存在代替业务验收通过。
    for name in ('restoreVerifier','businessVerifier','switchCommand'):
        path=Path(config[name])
        if not path.is_absolute() or not path.is_file() or not os.access(path,os.X_OK):
            raise RuntimeError('required release component unavailable')
    if not isinstance(config['requiredBackupPaths'],list) or not config['requiredBackupPaths'] or config['minimumBackupDatabases']<1:
        raise RuntimeError('backup content contract missing')
    runtime=verifyRuntimeReadiness(config,business,request)
    print(json.dumps({'environment':request['environment'],'sourceSha':request['sourceSha'],
                      'image':request['image'],'readinessVerified':True,'deployed':False,**runtime}))


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        reason=str(error) if isinstance(error,RuntimeError) else type(error).__name__
        print('发布准入未通过: '+reason,file=sys.stderr)
        sys.exit(1)
