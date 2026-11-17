#!/usr/bin/env python3
"""在固定 systemd 管理模式下切换容器；保留前驱容器，不自动还原业务数据。"""
import json
import os
from pathlib import Path
import subprocess
import sys


def run(args, timeout=120):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, timeout=timeout).stdout


def main():
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    config = json.loads(Path('/etc/aivideo/release.json').read_text())
    request = json.load(sys.stdin)
    current = json.loads(run(['docker', 'inspect', config['container']]))[0]
    if current['Image'] != request['predecessorId']:
        raise RuntimeError('production predecessor changed')
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
    run(['systemctl', 'start', config['quotaService']])
    run(['systemctl', 'start', config['service']])
    print(json.dumps({'predecessorContainer':oldName,'switched':True}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('容器切换未完成；请读取事务阶段与前驱容器，禁止盲目重试。', file=sys.stderr)
        sys.exit(1)
