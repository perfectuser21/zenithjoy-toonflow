#!/usr/bin/env python3
"""停写前发布准入；只读当前服务和卷，缺少条件立即拒绝。"""
import json
import os
from pathlib import Path, PurePosixPath
from verifyBusiness import rootFile, rootJson, validateBusinessConfig
from verifyGeneration import validateGenerationConfig
from runtimeReadiness import verifyRuntimeReadiness
from backupShared import estimateShared, sharedDirectories
from volumeSnapshot import scanVolume, requireSpace, capsuleSize, reserve, requireCapsuleFilesystem
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
    business=rootJson(config['businessConfig'],private=True)
    if business['environment']!=request['environment'] or business['publicOrigin']!=config['publicOrigin']:
        raise RuntimeError('business contract identity mismatch')
    workspaces=validateBusinessConfig(business)
    validateGenerationConfig(business)
    runtime=verifyRuntimeReadiness(config,business,request)
    shared=config.get('dataMode')=='sharedDirectory'
    if shared:
        sharedDirectories(config,business)
    execution=run(['systemctl','show',config['service'],'--property=ExecStart','--value'])
    if '/usr/bin/docker start -a '+config['container'] not in execution:
        raise RuntimeError('service is not using managed container startup')
    current=json.loads(run(['docker','inspect',config['container']]))[0]
    if not current['State']['Running'] or current['State']['Restarting']:
        raise RuntimeError('current service not running steadily')
    for workspace in workspaces:
        directory=PurePosixPath(workspace['directory']); canvas=PurePosixPath(workspace['canvasPath'])
        if not directory.is_absolute() or canvas.is_absolute() or '..' in canvas.parts or '..' in directory.parts:
            raise RuntimeError('invalid acceptance seed path')
        containerPath=directory/canvas
        bindings=[m for m in current['Mounts'] if m['Type']=='bind' and containerPath.is_relative_to(PurePosixPath(m['Destination']))]
        bindings.sort(key=lambda m:len(PurePosixPath(m['Destination']).parts),reverse=True)
        if not bindings:
            raise RuntimeError('acceptance seed is not on persistent data mount')
        binding=bindings[0]; hostRoot=Path(binding['Source']).resolve(strict=True)
        seed=hostRoot/str(containerPath.relative_to(PurePosixPath(binding['Destination'])))
        if seed.is_symlink() or not seed.resolve(strict=True).is_relative_to(hostRoot) or seed.stat().st_size>4*1024*1024:
            raise RuntimeError('acceptance seed escapes persistent data or exceeds limit')
        value=json.loads(seed.read_text())
        if value.get('deliveryAcceptance') is not True or value.get('toonflowCanvas') is not True:
            raise RuntimeError('dedicated acceptance seed missing explicit marker')
    if shared:
        data,_=sharedDirectories(config,business)
        target=config['containerDataDirectory']
        for item in current['Mounts']:
            if item.get('Type')=='bind' and item.get('Destination')==target and item.get('Source')==str(data) and item.get('RW'):
                break
        else:
            raise RuntimeError('shared data directory bind mismatch')
        for workspace in workspaces:
            containerPath=PurePosixPath(workspace['directory'])/workspace['canvasPath']
            bindings=[item for item in current['Mounts'] if containerPath.is_relative_to(PurePosixPath(item['Destination']))]
            bindings.sort(key=lambda item:len(PurePosixPath(item['Destination']).parts),reverse=True)
            if not bindings or bindings[0].get('Destination')!=target:
                raise RuntimeError('shared acceptance seed is shadowed or outside shared data bind')
        estimate=estimateShared(config,business)
        for name in ('businessVerifier','switchCommand'):
            rootFile(config[name],executable=True)
        print(json.dumps({'environment':request['environment'],'sourceSha':request['sourceSha'],
                          'image':request['image'],'readinessVerified':True,'deployed':False,
                          **runtime,'sharedBypass':True,'restoreScope':'sharedFiles','storage':estimate}))
        return
    run(['systemctl','is-active','--quiet',config['quotaService']])
    data=Path(config['dataDirectory']).resolve(strict=True)
    volume=Path(config['volumeImage']).resolve(strict=True)
    mount=json.loads(run(['findmnt','-J','-T',str(data),'-o','TARGET,SOURCE,FSTYPE,OPTIONS']))['filesystems'][0]
    if mount['target']!=str(data) or mount['fstype']!='ext4' or 'prjquota' not in mount['options'].split(','):
        raise RuntimeError('quota mount not available')
    backing=json.loads(run(['losetup','-J','-l',mount['source']]))['loopdevices'][0]['back-file']
    if Path(backing).resolve()!=volume:
        raise RuntimeError('volume backing identity mismatch')
    applicationData=Path(config.get('applicationDataDirectory',str(data))).resolve(strict=True)
    if not applicationData.is_relative_to(data):
        raise RuntimeError('application data outside configured volume')
    target=config.get('containerDataDirectory','/app/data')
    if not PurePosixPath(target).is_absolute() or '..' in PurePosixPath(target).parts:
        raise RuntimeError('invalid container data target')
    for item in current['Mounts']:
        if item.get('Destination')==target and Path(item['Source']).resolve()==applicationData and item.get('RW'):
            break
    else:
        raise RuntimeError('application data binding mismatch')
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
    print(json.dumps({'environment':request['environment'],'sourceSha':request['sourceSha'],
                      'image':request['image'],'readinessVerified':True,'deployed':False,**runtime}))


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        reason=str(error) if isinstance(error,RuntimeError) else type(error).__name__
        print('发布准入未通过: '+reason,file=sys.stderr)
        sys.exit(1)
