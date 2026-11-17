#!/usr/bin/env python3
"""香港只读见证入口，专用 SSH 身份只能经受限 sudo 调用此程序。"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

from imageTransfer import exportCommand
from releaseHost import configPath, rootFile


class WitnessDiagnosticFailure(Exception):
    pass


def exportImageWithEvidence(request):
    rootFile(configPath)
    config=json.loads(configPath.read_text())
    state=Path(config['stateDirectory'])
    rootFile(state / 'identity.json')
    if config['environment']!='staging' or not all(isinstance(request[k],str) and re.fullmatch(r'[1-9][0-9]{0,19}',request[k]) for k in ('runId','runAttempt')):
        raise RuntimeError('invalid witness state')
    try:
        fd,_=tempfile.mkstemp(prefix='witness-export-'+request['runId']+'-'+request['runAttempt']+'-',suffix='.jsonl',dir=state)
    except OSError as error:
        raise WitnessDiagnosticFailure('witness diagnostic unavailable') from error
    started=time.monotonic(); code=None
    fields=('environment','sourceSha','image','runId','runAttempt')
    with os.fdopen(fd,'w',encoding='utf-8') as log:
        def record(phase,error=None):
            errorName = ('TimeoutExpired' if isinstance(error,subprocess.TimeoutExpired) else
                         'OSError' if isinstance(error,OSError) else 'OtherError') if error else None
            try:
                json.dump({'identity':{k:request[k] for k in fields},'phase':phase,'bytes':None,
                           'exit':code,'elapsed':round(time.monotonic()-started,3),'errorClass':errorName},
                          log,separators=(',',':'))
                log.write('\n'); log.flush(); os.fsync(log.fileno())
            except OSError as failure:
                raise WitnessDiagnosticFailure('witness diagnostic unavailable') from failure
        try:
            stateFd=os.open(state,os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(stateFd)
            finally:
                os.close(stateFd)
        except OSError as error:
            raise WitnessDiagnosticFailure('witness diagnostic unavailable') from error
        record('started')
        try:
            # 保留原有 ctr 直接写 stdout 路径；不可从结果推断具体字节数。
            exported=subprocess.run(exportCommand(request['image']),stdout=sys.stdout.buffer,
                                    stderr=subprocess.DEVNULL,timeout=7200,
                                    env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'})
            code=exported.returncode
            if code!=0:
                raise RuntimeError('OCI export incomplete')
            record('completed')
        except Exception as error:
            record('failed',error)
            raise


def main():
    if os.geteuid()!=0:
        raise RuntimeError('root required')
    data=sys.stdin.buffer.read(8193)
    if len(data)>8192:
        raise RuntimeError('request too large')
    request=json.loads(data)
    keys={'sourceSha','image','runId','runAttempt','environment','operation'}
    if set(request)!=keys or request['environment']!='staging' or request['operation'] not in ('receipt', 'exportImage'):
        raise RuntimeError('witness identity only permits validated release reads')
    exportImage=request['operation']=='exportImage'
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
    if exportImage:
        # stdout仅包含OCI二进制；镜像、namespace、socket、参数均固定。
        exportImageWithEvidence(request)
        return
    fields=('publicOrigin','environment','sourceSha','image','runId','runAttempt','result',
            'businessVerified','runningImage','backupVerified','restoreVerified','predecessorImage','backupId')
    print(json.dumps({key:receipt[key] for key in fields if key in receipt}))


if __name__=='__main__':
    try:
        main()
    except WitnessDiagnosticFailure:
        print('香港见证诊断写入失败。',file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('香港只读发布见证未通过。',file=sys.stderr)
        sys.exit(1)
