#!/usr/bin/env python3
"""停写后复制 ext4 原始卷，保留 project quota 与全部文件元数据。"""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import time
from releasePolicy import requireQuotaVolume
from volumeSnapshot import requireSpace, sparseCopy, capsuleSize, reserve, requireCapsuleFilesystem


def command(args, timeout=120):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, timeout=timeout).stdout


def stopGuard(guard):
    # 临时timer停止后，尚未触发的service可能被PID1自动卸载；以终态核对。
    for suffix in ('.timer', '.service'):
        unit = guard + suffix
        result = subprocess.run(['systemctl','stop',unit],capture_output=True,text=True,timeout=30)
        state = subprocess.run(['systemctl','show',unit,'--property=LoadState','--property=ActiveState'],capture_output=True,text=True,timeout=30)
        fields = dict(line.split('=',1) for line in state.stdout.splitlines() if '=' in line)
        if state.returncode and fields.get('LoadState') != 'not-found':
            raise RuntimeError('backup thaw guard status unavailable')
        if fields.get('ActiveState') not in ('inactive','failed'):
            raise RuntimeError('backup thaw guard is still active')
        if result.returncode and fields.get('LoadState') != 'not-found':
            raise RuntimeError('backup thaw guard stop failed')


def digest(path):
    value = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def compactRestoreScratch(payload, snapshot):
    # Only the verified writable copy is disposable. The immutable snapshot is
    # the rollback artifact and must remain byte-for-byte unchanged.
    clone = payload / 'quotaRestore.ext4'
    try:
        info = clone.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_dev != snapshot.stat().st_dev):
            return False
        if command(['losetup', '--associated', str(clone)]).strip():
            return False
        clone.unlink()
        # Commit the unlinked blocks before FITRIM enumerates free space.
        command(['sync', '-f', str(payload)])
        command(['fstrim', str(payload)], timeout=120)
    except (OSError, subprocess.SubprocessError):
        # A diagnostic clone or untrimmed free blocks can still be retained.
        return False
    return True


def sealRestoreSnapshot(payload, snapshot):
    snapshotHash = digest(snapshot)
    compacted = compactRestoreScratch(payload, snapshot)
    if digest(snapshot) != snapshotHash:
        raise RuntimeError('restore scratch cleanup changed snapshot bytes')
    return snapshotHash, compacted


def main():
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    config = json.loads(Path('/etc/aivideo/release.json').read_text())
    request = json.load(sys.stdin)
    requireQuotaVolume(config)
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
    backing = json.loads(command(['losetup', '-J', '-l', source]))['loopdevices'][0]['back-file']
    if Path(backing).resolve() != volume.resolve():
        raise RuntimeError('mount does not refer to configured image')
    # 胶囊先实际分配宿主空间，内部任何恢复增长都不能突破该硬容量。
    if target.stat().st_dev == Path(data).stat().st_dev:
        raise RuntimeError('backup control directory must be outside frozen filesystem')
    requireCapsuleFilesystem(target)
    capacity = capsuleSize(config)
    requireSpace(target, capacity + reserve)
    capsule = target / 'capsule.ext4'
    capsuleFd = os.open(capsule, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.posix_fallocate(capsuleFd, 0, capacity)
        os.fsync(capsuleFd)
    finally:
        os.close(capsuleFd)
    requireSpace(target, reserve)
    command(['mkfs.ext4', '-q', '-F', '-m', '0', '-E', 'nodiscard,lazy_itable_init=0,lazy_journal_init=0', str(capsule)])
    # 格式化不得撤销物理预留；再次实分配并核对后才允许停写。
    with open(capsule,'r+b',buffering=0) as allocated:
        os.posix_fallocate(allocated.fileno(),0,capacity)
        os.fsync(allocated.fileno())
    if capsule.stat().st_blocks * 512 < capacity:
        raise RuntimeError('capsule allocation not fully reserved')
    requireSpace(target,reserve)
    payload = target / 'payload'
    payload.mkdir(mode=0o700)
    snapshot = payload / 'data.ext4'
    restored = payload / 'restored'
    capsuleMounted = False
    services = [config['service'], config['quotaService']]
    active = [unit for unit in services if subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0]
    frozen = False
    guardArmed = False
    mounted = False
    stopped = False
    backupReady = False
    guard = 'aivideo-backup-thaw-' + key
    thawMarker = target / 'guardTriggered'
    try:
        command(['mount','-o','loop,nosuid,nodev,noexec,nodiscard',str(capsule),str(payload)])
        capsuleMounted = True
        os.chmod(payload,0o700)
        restored.mkdir(mode=0o700)
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
        guardCode = 'import os,subprocess,sys\ntry:\n f=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\n try:\n  os.write(f,b"triggered");os.fsync(f)\n finally:os.close(f)\nfinally:\n subprocess.run(["/usr/sbin/fsfreeze","--unfreeze",sys.argv[2]],check=True)\n'
        command(['systemd-run', '--quiet', '--unit=' + guard, '--on-active=300s',
                 '/usr/bin/python3', '-c', guardCode, str(thawMarker), data])
        guardArmed = True
        frozen = True
        command(['fsfreeze', '--freeze', data], timeout=30)
        stats = os.statvfs(payload)
        restoreReserve = 64 * 1024**2
        available = stats.f_bavail * stats.f_frsize
        storage = sparseCopy(volume, snapshot, maxPayloadBytes=(available - restoreReserve) // 2)
        requireSpace(payload, storage['estimatedPayloadBytes'] + restoreReserve)
        os.chmod(snapshot, 0o600)
        with open(snapshot, 'rb') as durable:
            os.fsync(durable.fileno())
        # 原始字节级核对，连同 ext4 project id、配额及 xattr 一起核验。
        compareTimeout = 160 if config['environment'] == 'production' else 60
        command(['cmp', '--silent', str(volume), str(snapshot)], timeout=compareTimeout)
        # 手动解冻成功之前保留独立兜底，避免SIGKILL留下永久冻结的卷。
        command(['fsfreeze', '--unfreeze', data], timeout=15)
        frozen = False
        stopGuard(guard)
        guardArmed = False
        if thawMarker.exists():
            raise RuntimeError('backup thaw watchdog fired; snapshot rejected')
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
        snapshotHash, scratchCompacted = sealRestoreSnapshot(payload, snapshot)
        receipt = {'backupId':key, 'backupVerified':True, 'restoreVerified':True,
                   'quotaRestoreVerified':True,
                   'sha256':snapshotHash, 'filesVerifiedReadable':fileCount,
                   'databasesVerified':databaseCount, 'storage':storage, 'sourceSha':request['sourceSha'],
                   'restoreScratchCompacted':scratchCompacted}
        command(['umount', str(payload)])
        capsuleMounted = False
        capsuleHash = digest(capsule)
        command(['fallocate', '--dig-holes', str(capsule)], timeout=180)
        if digest(capsule) != capsuleHash:
            raise RuntimeError('capsule compaction changed logical bytes')
        with open(capsule, 'rb') as durable:
            os.fsync(durable.fileno())
        receipt['capsuleSha256'] = capsuleHash
        receipt['capsuleCapacityBytes'] = capacity
        receipt['capsuleAllocatedBytes'] = capsule.stat().st_blocks * 512
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
                stopGuard(guard)
                guardArmed = False
            except Exception:
                cleanupErrors.append('guard')
        if mounted:
            try:
                command(['umount', str(restored)])
                mounted = False
            except Exception:
                cleanupErrors.append('restoreMount')
        if capsuleMounted and not mounted:
            try:
                command(['umount',str(payload)])
                capsuleMounted = False
            except Exception:
                cleanupErrors.append('capsuleMount')
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
    except Exception as failure:
        reason = str(failure) if isinstance(failure, RuntimeError) else type(failure).__name__
        if isinstance(failure, subprocess.CalledProcessError):
            reason = Path(failure.cmd[0]).name + ' exit ' + str(failure.returncode)
        print('完整卷备份或恢复验证未通过: ' + reason, file=sys.stderr)
        sys.exit(1)
