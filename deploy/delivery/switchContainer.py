#!/usr/bin/env python3
"""在固定 systemd 管理模式下切换容器；保留前驱容器，不自动还原业务数据。"""
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time
from verifyBusiness import publicClient, rootJson, verifyApplicationDataMount
from releasePolicy import releaseIdentityFields, requireQuotaVolume, validatePassedJourneys


def run(args, timeout=120):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, timeout=timeout).stdout


def main():
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    config = json.loads(Path('/etc/aivideo/release.json').read_text())
    request = json.load(sys.stdin)
    requireQuotaVolume(config)
    current = json.loads(run(['docker', 'inspect', config['container']]))[0]
    if current['Image'] != request['predecessorId']:
        raise RuntimeError('production predecessor changed')
    if config['environment'] == 'production':
        runId, attempt = (request[key] for key in ('runId', 'runAttempt'))
        if not all(isinstance(value, str) and re.fullmatch('[1-9][0-9]{0,19}', value)
                   for value in (runId, attempt)):
            raise RuntimeError('invalid production transaction identity')
        transaction = rootJson(Path(config['stateDirectory']) / (runId + '-' + attempt + '.json'), private=True)
        proof = transaction.get('candidateVerification', {})
        if (transaction.get('phase') != 'switching'
                or any(transaction.get('request', {}).get(key) != request[key] for key in releaseIdentityFields)
                or proof.get('predecessorId') != current['Id']
                or proof.get('containerId') in (None, current['Id'])):
            raise RuntimeError('production cutover requires isolated candidate verification')
        validatePassedJourneys(proof.get('passedJourneys'), 'production')
    # 配置由 root 安装；不把请求内字符串拼接为 shell。
    args = config['containerCreateArgs']
    if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
        raise RuntimeError('invalid container args')
    execution = run(['systemctl', 'show', config['service'], '--property=ExecStart', '--value'])
    if '/usr/bin/docker start -a ' + config['container'] not in execution:
        raise RuntimeError('systemd must use managed container startup')
    oldName = config['container'] + '-before-' + request['runId'] + '-' + request['runAttempt']
    # 创建前检查名称不会覆盖任何已保留的容器。
    found = run(['docker', 'ps', '-a', '--filter', 'name=^/' + oldName + '$', '--format', '{{.Names}}'])
    if found.strip():
        raise RuntimeError('predecessor slot already exists')
    run(['systemctl', 'stop', config['service']])
    stopped = json.loads(run(['docker', 'inspect', config['container']]))[0]
    if stopped['State']['Running'] or stopped['State']['Restarting']:
        raise RuntimeError('old writer did not stop')
    containers = run(['docker', 'ps', '-q']).split()
    if containers:
        for item in json.loads(run(['docker', 'inspect', *containers])):
            for mount in item['Mounts']:
                source = mount.get('Source', '')
                data = config['dataDirectory']
                if mount.get('RW') and source and (Path(source).resolve() == Path(data).resolve() or Path(source).resolve() in Path(data).resolve().parents or Path(data).resolve() in Path(source).resolve().parents):
                    raise RuntimeError('another container still writes data')
    run(['docker', 'rename', config['container'], oldName])
    # 执行失败时保留停止状态和事务现场，禁止盲目重启旧程序访问已迁移的数据。
    run(['docker', 'create', '--name', config['container'], *args, '-e', 'TOONFLOW_WEB_MEDIA_STREAMING=1', '-e', 'TOONFLOW_RELEASE_SHA=' + request['sourceSha'], '-e', 'TOONFLOW_RELEASE_IMAGE=' + request['image'], request['image']])
    candidate = json.loads(run(['docker', 'inspect', config['container']]))[0]
    verifyApplicationDataMount(config, candidate)
    run(['systemctl', 'start', config['quotaService']])
    run(['systemctl', 'start', config['service']])
    # Type=simple的active只表示启动命令已执行；等待同一候选后端真实接收HTTP。
    business = rootJson(config['businessConfig'], private=True)
    local = publicClient(business['localOrigin'].rstrip('/'))
    deadline = time.monotonic() + 90
    while True:
        if time.monotonic() >= deadline:
            raise RuntimeError('candidate backend did not become ready')
        try:
            state = json.loads(run(['docker', 'inspect', config['container']],
                                   timeout=min(5, deadline - time.monotonic())))[0]
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('candidate backend did not become ready')
            identity = local.request('GET', '/api/delivery/identity', timeout=min(5, remaining))
            if (state['State']['Running'] and not state['State']['Restarting']
                    and state['Config']['Image'] == request['image']
                    and identity.get('sourceSha') == request['sourceSha']
                    and identity.get('image') == request['image']
                    and isinstance(identity.get('bootId'), str)):
                break
        except (RuntimeError, OSError, ValueError, subprocess.SubprocessError):
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError('candidate backend did not become ready')
        time.sleep(1)
    print(json.dumps({'predecessorContainer':oldName,'switched':True}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('容器切换未完成；请读取事务阶段与前驱容器，禁止盲目重试。', file=sys.stderr)
        sys.exit(1)
