#!/usr/bin/env python3
"""停写后复制 ext4 原始卷，保留 project quota 与全部文件元数据。"""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time


def command(args, timeout=120):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, timeout=timeout).stdout


def digest(path):
    value = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def main():
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    config = json.loads(Path('/etc/aivideo/release.json').read_text())
    request = json.load(sys.stdin)
    # 只能由控制器调用；输入不控制任何宿主路径、unit 名称或命令。
    key = str(time.time_ns())
    target = Path(config['backupDirectory']) / key
    target.mkdir(mode=0o700, parents=False, exist_ok=False)
    volume = Path(config['volumeImage'])
    data = config['dataDirectory']
    if volume.is_symlink() or not volume.is_file():
        raise RuntimeError('not a regular volume image')
    command(['mountpoint', '-q', data])
    mount = json.loads(command(['findmnt', '-J', '-T', data, '-o', 'TARGET,SOURCE,FSTYPE']))['filesystems'][0]
    if mount['target'] != data or mount['fstype'] != 'ext4':
        raise RuntimeError('unexpected data mount')
    source = mount['source']
    backing = json.loads(command(['losetup', '-J', source]))['loopdevices'][0]['back-file']
    if Path(backing).resolve() != volume.resolve():
        raise RuntimeError('mount does not refer to configured image')
    # 保守按两份完整逻辑卷预留；不以稀疏文件预计压缩率作为容量保证。
    stats = os.statvfs(target)
    if stats.f_bavail * stats.f_frsize < volume.stat().st_size + 1024 ** 3:
        raise RuntimeError('insufficient backup space')
    snapshot = target / 'data.ext4'
    restored = target / 'restored'
    restored.mkdir(mode=0o700)
    services = [config['service'], config['quotaService']]
    active = [unit for unit in services if subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0]
    frozen = False
    guardArmed = False
    mounted = False
    stopped = False
    backupReady = False
    guard = 'aivideo-backup-thaw-' + key
    try:
        stopped = True
        for unit in services:
            command(['systemctl', 'stop', unit])
        for unit in services:
            if subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0:
                raise RuntimeError('declared writer service still active')
        containers = command(['docker', 'ps', '-q']).split()
        if containers:
            for container in json.loads(command(['docker', 'inspect', *containers])):
                for item in container['Mounts']:
                    source = item.get('Source', '')
                    if item.get('RW') and source and (Path(source).resolve() == Path(data).resolve() or Path(source).resolve() in Path(data).resolve().parents or Path(data).resolve() in Path(source).resolve().parents):
                        raise RuntimeError('data volume still has running container writer')
        # 独立 PID1 定时解冻兜底，发布进程被杀也不会把生产卷永久冻结。
        command(['systemd-run', '--quiet', '--unit=' + guard, '--on-active=180s',
                 '/usr/sbin/fsfreeze', '--unfreeze', data])
        guardArmed = True
        frozen = True
        command(['fsfreeze', '--freeze', data], timeout=30)
        command(['cp', '--sparse=always', '--reflink=never', str(volume), str(snapshot)], timeout=90)
        os.chmod(snapshot, 0o600)
        with open(snapshot, 'rb') as durable:
            os.fsync(durable.fileno())
        # 原始字节级核对，连同 ext4 project id、配额及 xattr 一起核验。
        command(['cmp', '--silent', str(volume), str(snapshot)], timeout=60)
        command(['fsfreeze', '--unfreeze', data], timeout=15)
        frozen = False
        command(['systemctl', 'stop', guard + '.timer'])
        guardArmed = False
        # 恢复到独立只读挂载，不连接服务、不启动后台任务、不修改原始卷。
        command(['mount', '-o', 'loop,ro,noload,nosuid,nodev,noexec', str(snapshot), str(restored)])
        mounted = True
        fileCount = 0
        databaseCount = 0
        def walkError(error):
            raise error
        for base, dirs, files in os.walk(restored, followlinks=False, onerror=walkError):
            dirs[:] = [name for name in dirs if not (Path(base) / name).is_symlink()]
            for name in files:
                path = Path(base) / name
                if path.is_symlink() or not path.is_file():
                    continue
                fileCount += 1
                with open(path, 'rb') as handle:
                    header = handle.read(16)
                if header == b'SQLite format 3\x00':
                    # 服务停写关闭连接后，不允许遗漏仍含未合并提交的 WAL。
                    wal = Path(str(path) + '-wal')
                    if wal.exists() and wal.stat().st_size > 0:
                        raise RuntimeError('snapshot has live SQLite WAL; explicit recovery required')
                    connection = sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)
                    try:
                        if connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                            raise RuntimeError('restored database integrity failed')
                    finally:
                        connection.close()
                    databaseCount += 1
        for required in config['requiredBackupPaths']:
            relative = Path(required)
            if relative.is_absolute() or '..' in relative.parts or not (restored / relative).exists():
                raise RuntimeError('required backup content missing')
        if databaseCount < config['minimumBackupDatabases']:
            raise RuntimeError('expected databases missing')
        command(['umount', str(restored)])
        mounted = False
        # 独立配额恢复验收器必须实际验证 project id/限额及超额拒绝。
        validation = subprocess.run([config['restoreVerifier']], input=json.dumps({'snapshot':str(snapshot), 'request':request}),
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True, timeout=300)
        proof = json.loads(validation.stdout)
        if proof.get('snapshot') != str(snapshot) or proof.get('quotaRestoreVerified') is not True:
            raise RuntimeError('quota restore has not been verified')
        receipt = {'backupId':key, 'backupVerified':True, 'restoreVerified':True,
                   'sha256':digest(snapshot), 'filesVerifiedReadable':fileCount,
                   'databasesVerified':databaseCount, 'sourceSha':request['sourceSha']}
        with open(target / 'receipt.json', 'x') as handle:
            os.chmod(handle.fileno(), 0o600)
            json.dump(receipt, handle)
            handle.flush()
            os.fsync(handle.fileno())
        for directory in (target, target.parent):
            fd = os.open(directory, os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        backupReady = True
    finally:
        cleanupErrors = []
        if frozen:
            try:
                command(['fsfreeze', '--unfreeze', data], timeout=15)
                frozen = False
            except Exception:
                cleanupErrors.append('thaw')
        if guardArmed and not frozen:
            try:
                command(['systemctl', 'stop', guard + '.timer'])
                guardArmed = False
            except Exception:
                cleanupErrors.append('guard')
        if mounted:
            try:
                command(['umount', str(restored)])
                mounted = False
            except Exception:
                cleanupErrors.append('restoreMount')
        if stopped and not backupReady and not frozen:
            for unit in reversed(active):
                try:
                    command(['systemctl', 'start', unit])
                except Exception:
                    cleanupErrors.append('restart')
        if cleanupErrors:
            raise RuntimeError('cleanup needs operator inspection')
        # 成功保持停写直到 switch；失败保留备份现场。
    print(json.dumps(receipt))



if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('完整卷备份或恢复验证未通过，请检查受控备份现场。', file=sys.stderr)
        sys.exit(1)
