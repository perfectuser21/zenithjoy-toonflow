#!/usr/bin/env python3
"""仅 staging 旧共享目录：停写、完整归档及有界 tmpfs 恢复；不改变源数据。"""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import time
from verifyBusiness import rootJson
from volumeSnapshot import requireSpace, reserve


def run(args, timeout=300):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout).stdout


def canonicalDirectory(value, private=False):
    path = Path(value)
    if not path.is_absolute() or str(path) != value or '..' in path.parts or path == Path('/'):
        raise RuntimeError('canonical absolute directory required')
    for current in (path, *path.parents):
        if current.is_symlink():
            raise RuntimeError('directory has symlink ancestor')
        if private and (current.stat().st_uid != 0 or current.stat().st_mode & 0o022):
            raise RuntimeError('backup directory ownership unsafe')
    if not path.is_dir() or path.resolve(strict=True) != path:
        raise RuntimeError('directory identity mismatch')
    if private and stat.S_IMODE(path.stat().st_mode) != 0o700:
        raise RuntimeError('backup directory must be root private 0700')
    return path


def sharedDirectories(config, business):
    if config.get('dataMode') != 'sharedDirectory' or config.get('environment') != 'staging' or business.get('environment') != 'staging' or business.get('businessMode') != 'shared':
        raise RuntimeError('shared directory allowed only for shared staging')
    data = canonicalDirectory(config['dataDirectory'])
    if config.get('applicationDataDirectory', str(data)) != str(data):
        raise RuntimeError('shared data binding must retain original directory')
    target = config.get('containerDataDirectory')
    if not isinstance(target, str) or not PurePosixPath(target).is_absolute() or str(PurePosixPath(target)) != target or '..' in PurePosixPath(target).parts or target == '/':
        raise RuntimeError('canonical container data directory required')
    backup = canonicalDirectory(config['backupDirectory'], private=True)
    if backup == data or backup.is_relative_to(data) or data.is_relative_to(backup):
        raise RuntimeError('backup directory overlaps source')
    required = config.get('requiredBackupPaths')
    if not isinstance(required, list) or not required:
        raise RuntimeError('required shared backup paths missing')
    for name in required:
        relative = PurePosixPath(name)
        if not isinstance(name, str) or relative.is_absolute() or '..' in relative.parts or str(relative) != name or name == '.':
            raise RuntimeError('invalid required backup path')
    return data, backup


def digest(path):
    value = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as handle:
        for chunk in iter(lambda: handle.read(4 * 1024**2), b''):
            value.update(chunk)
    return value.hexdigest()


def scanDirectory(data, withHashes=False):
    device = data.stat().st_dev
    entries = {}
    logicalBytes = 0
    def visit(path):
        nonlocal logicalBytes
        info = path.lstat()
        if info.st_dev != device or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise RuntimeError('shared source contains link, special file or nested filesystem')
        if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
            raise RuntimeError('shared source contains hardlinked file')
        name = str(path.relative_to(data))
        entry = {'kind': 'directory' if stat.S_ISDIR(info.st_mode) else 'file',
                 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
                 'size': info.st_size if stat.S_ISREG(info.st_mode) else 0}
        if withHashes:
            entry['xattrs'] = {name: os.getxattr(path, name, follow_symlinks=False)
                              for name in os.listxattr(path, follow_symlinks=False)}
        if stat.S_ISREG(info.st_mode):
            logicalBytes += info.st_size
            if withHashes:
                entry['sha256'] = digest(path)
        entries[name] = entry
        if stat.S_ISDIR(info.st_mode):
            for child in sorted(path.iterdir()):
                visit(child)
    visit(data)
    return {'logicalBytes': logicalBytes, 'entries': entries}


def estimateShared(config, business):
    """只读准入估算；停写后仍须重新扫描、检查空间及内存。"""
    data, backup = sharedDirectories(config, business)
    for transaction in backup.iterdir():
        if transaction.name.isdecimal():
            if transaction.is_symlink() or not transaction.is_dir() or not (transaction / 'receipt.json').is_file():
                raise RuntimeError('incomplete shared backup transaction; operator inspection required')
            receipt = rootJson(transaction / 'receipt.json', private=True)
            if receipt.get('backupVerified') is not True or receipt.get('restoreVerified') is not True or receipt.get('restoreScope') != 'sharedFiles':
                raise RuntimeError('incomplete shared backup receipt; operator inspection required')
            if subprocess.run(['mountpoint', '-q', str(transaction / 'restored')], capture_output=True).returncode == 0:
                raise RuntimeError('shared restore mount still present; operator inspection required')
    source = scanDirectory(data)
    # tar/PAX headers、ACL/xattr 与文件系统块分配的保守估算；不足即失败，无稀疏假设。
    overhead = max(128 * 1024**2, len(source['entries']) * 32768)
    capacity = ((source['logicalBytes'] + overhead + 1024**2 - 1) // 1024**2) * 1024**2
    if capacity > 3 * 1024**3:
        raise RuntimeError('shared restore exceeds 3GiB tmpfs limit')
    memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    if int(memory['MemAvailable'].split()[0]) * 1024 < capacity + reserve:
        raise RuntimeError('insufficient available memory for isolated shared restore')
    requireSpace(backup, source['logicalBytes'] + overhead + reserve)
    return {'logicalBytes': source['logicalBytes'], 'entryCount': len(source['entries']),
            'metadataReserveBytes': overhead, 'restoreCapacityBytes': capacity}


def requireStopped(config, data, initialGroups=None):
    units = config.get('sharedWriterServices', [config['service']])
    if not isinstance(units, list) or not units or config['service'] not in units or len(set(units)) != len(units) or not all(isinstance(unit, str) and re.fullmatch(r'[A-Za-z0-9_.@-]+\.service', unit) for unit in units):
        raise RuntimeError('explicit shared writer services invalid')
    for unit in units:
        state = run(['systemctl', 'show', unit, '--property=ActiveState', '--property=ControlGroup'])
        fields = dict(line.split('=', 1) for line in state.splitlines() if '=' in line)
        if fields.get('ActiveState') != 'inactive':
            raise RuntimeError('declared shared writer is not inactive')
        groups = {fields.get('ControlGroup', ''), (initialGroups or {}).get(unit, '')}
        for group in groups - {''}:
            relative = PurePosixPath(group)
            if not relative.is_absolute() or '..' in relative.parts or group == '/':
                raise RuntimeError('invalid writer cgroup')
            root = Path('/sys/fs/cgroup') / group.lstrip('/')
            if root.exists():
                for processes in root.rglob('cgroup.procs'):
                    if processes.read_text().strip():
                        raise RuntimeError('writer cgroup retains processes')
                own = root / 'cgroup.procs'
                if own.exists() and own.read_text().strip():
                    raise RuntimeError('writer cgroup retains processes')
    containers = run(['docker', 'ps', '-q']).split()
    if containers:
        for container in json.loads(run(['docker', 'inspect', *containers])):
            for mount in container['Mounts']:
                source = mount.get('Source')
                if mount.get('RW') and source:
                    path = Path(source).resolve(strict=True)
                    if path == data or path.is_relative_to(data) or data.is_relative_to(path):
                        raise RuntimeError('running container still writes shared source')
    return units


def writePrivate(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle)
        handle.flush()
        os.fsync(handle.fileno())


def main():
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    config = rootJson('/etc/aivideo/release.json', private=True)
    business = rootJson(config['businessConfig'], private=True)
    request = json.load(sys.stdin)
    if request['environment'] != config['environment']:
        raise RuntimeError('environment mismatch')
    data, backup = sharedDirectories(config, business)
    lockFd = os.open(backup / 'sharedBackup.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lockFd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        estimateShared(config, business)
        units = config.get('sharedWriterServices', [config['service']])
        if not isinstance(units, list) or not units or config['service'] not in units or len(set(units)) != len(units) or not all(isinstance(unit, str) and re.fullmatch(r'[A-Za-z0-9_.@-]+\.service', unit) for unit in units):
            raise RuntimeError('invalid shared writer services')
        active = []
        initialGroups = {}
        for unit in units:
            fields = dict(line.split('=', 1) for line in run(['systemctl', 'show', unit, '--property=ActiveState', '--property=ControlGroup']).splitlines() if '=' in line)
            initialGroups[unit] = fields.get('ControlGroup', '')
            if fields.get('ActiveState') == 'active':
                if not initialGroups[unit]:
                    raise RuntimeError('active writer cgroup unavailable')
                active.append(unit)
            elif fields.get('ActiveState') != 'inactive':
                raise RuntimeError('writer initial state uncertain')
        key = str(time.time_ns())
        target = backup / key
        target.mkdir(mode=0o700)
        os.chmod(target, 0o700)
        writePrivate(target / 'transaction.json', {'backupId': key, 'activeServices': active, 'sourceSha': request['sourceSha']})
        restored = target / 'restored'
        restored.mkdir(mode=0o700)
        snapshot = target / 'data.tar'
        mounted = False
        ready = False
        try:
            for unit in units:
                run(['systemctl', 'stop', unit])
            requireStopped(config, data, initialGroups)
            # 此时本事务已创建；不再调用会拒绝 incomplete 事务的准入扫描。
            source = scanDirectory(data, withHashes=True)
            overhead = max(128 * 1024**2, len(source['entries']) * 32768)
            capacity = ((source['logicalBytes'] + overhead + 1024**2 - 1) // 1024**2) * 1024**2
            memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
            if capacity > 3 * 1024**3 or int(memory['MemAvailable'].split()[0]) * 1024 < capacity + reserve:
                raise RuntimeError('final shared restore capacity unavailable')
            requireSpace(target, source['logicalBytes'] + overhead + reserve)
            fd = os.open(snapshot, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            run(['tar', '--create', '--file', str(snapshot), '--acls', '--xattrs', '--xattrs-include=*', '--numeric-owner', '--one-file-system', '--directory', str(data), '.'])
            os.chmod(snapshot, 0o600)
            with snapshot.open('rb') as handle:
                os.fsync(handle.fileno())
            requireSpace(target, reserve)
            # 解压之前逐项校验完整归档；不允许 tar links、设备及越界路径。
            names = set()
            with tarfile.open(snapshot, 'r:') as archive:
                for item in archive:
                    path = PurePosixPath(item.name)
                    name = str(path)
                    if path.is_absolute() or '..' in path.parts or name in names or not (item.isfile() or item.isdir()):
                        raise RuntimeError('unsafe shared archive member')
                    names.add(name)
                    expected = source['entries'].get(name)
                    if expected is None or item.isfile() != (expected['kind'] == 'file') or (item.isfile() and item.size != expected['size']):
                        raise RuntimeError('archive content differs from stopped source')
                if names != set(source['entries']):
                    raise RuntimeError('archive omitted source entries')
            run(['mount', '-t', 'tmpfs', '-o', 'size=' + str(capacity) + ',mode=0700,nosuid,nodev,noexec', 'tmpfs', str(restored)])
            mounted = True
            run(['tar', '--extract', '--file', str(snapshot), '--acls', '--xattrs', '--xattrs-include=*', '--numeric-owner', '--same-owner', '--same-permissions', '--directory', str(restored)])
            recovered = scanDirectory(restored, withHashes=True)
            if recovered != source:
                raise RuntimeError('full shared restore content or metadata mismatch')
            for name in config['requiredBackupPaths']:
                path = restored / name
                if not path.exists():
                    raise RuntimeError('required shared backup content missing')
                if path.suffix.lower() == '.json':
                    with path.open() as handle:
                        json.load(handle)
            requireStopped(config, data, initialGroups)
            if scanDirectory(data, withHashes=True) != source:
                raise RuntimeError('source changed during stopped backup')
            run(['umount', str(restored)])
            mounted = False
            receipt = {'backupId': key, 'backupVerified': True, 'restoreVerified': True,
                       'restoreScope': 'sharedFiles', 'sha256': digest(snapshot),
                       'filesVerifiedReadable': sum(entry['kind'] == 'file' for entry in source['entries'].values()),
                       'databasesVerified': 0, 'sharedBypass': True, 'sourceSha': request['sourceSha'],
                       'storage': {'logicalBytes': source['logicalBytes'], 'restoreCapacityBytes': capacity}}
            writePrivate(target / 'receipt.json', receipt)
            for directory in (target, backup):
                directoryFd = os.open(directory, os.O_DIRECTORY)
                try:
                    os.fsync(directoryFd)
                finally:
                    os.close(directoryFd)
            ready = True
        finally:
            # SIGKILL 后留下的事务和挂载不伪装成功；下次准入必须拒绝并人工查验。
            cleanupErrors = []
            if mounted:
                try:
                    run(['umount', str(restored)])
                except Exception:
                    cleanupErrors.append('restoreMount')
            if not ready:
                for unit in reversed(active):
                    try:
                        run(['systemctl', 'start', unit])
                    except Exception:
                        cleanupErrors.append('restart')
            if cleanupErrors:
                raise RuntimeError('shared backup cleanup needs operator inspection')
        print(json.dumps(receipt))


if __name__ == '__main__':
    try:
        main()
    except Exception as failure:
        reason = str(failure) if isinstance(failure, RuntimeError) else type(failure).__name__
        print('共享目录备份或恢复未通过: ' + reason, file=sys.stderr)
        sys.exit(1)
