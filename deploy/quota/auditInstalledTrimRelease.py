#!/usr/bin/env python3
"""Root-only, read-only audit; never installs, starts or enables anything."""
import fcntl
import hashlib
import json
import os
import stat
import sys
import subprocess
import types

BASE = '/opt/toonflow-trim-release'
PIN = '/etc/toonflow-trim/release-pin.json'
TOOLS = '/etc/toonflow-trim/release-tools.json'
OUT = '/var/lib/toonflow-trim-release'
SELF = BASE + '/auditInstalledTrimRelease.py'
VERIFY = BASE + '/verifyTrimArtifact.py'
UNIT_PATHS = {
    'deploy/quota/toonflowTrimWorker.attested.service': '/etc/systemd/system/toonflowTrimWorker.service',
    'deploy/quota/toonflowTrimWorker.socket': '/etc/systemd/system/toonflowTrimWorker.socket',
    'deploy/quota/toonflowTrimWitness.service': '/etc/systemd/system/toonflowTrimWitness.service',
    'deploy/quota/toonflowTrimDocker.service': '/etc/systemd/system/toonflowTrimDocker.service',
    'deploy/quota/toonflowTrimContainerd.service': '/etc/systemd/system/toonflowTrimContainerd.service',
    'deploy/quota/toonflowTrimStore.attested.service': '/etc/systemd/system/toonflowTrimStore.service',
    'deploy/quota/toonflowTrimStore.socket': '/etc/systemd/system/toonflowTrimStore.socket',
}

def read_root(path, limit, private=False):
    if not os.path.isabs(path) or os.path.realpath(path) != path:
        raise ValueError('controlled file path invalid')
    parent = os.path.dirname(path)
    while True:
        entry = os.lstat(parent)
        if not stat.S_ISDIR(entry.st_mode) or entry.st_uid != 0 or entry.st_mode & 0o022:
            raise ValueError('controlled file ancestor invalid')
        if parent == '/': break
        parent = os.path.dirname(parent)
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_nlink != 1 or before.st_mode & (0o077 if private else 0o022) or before.st_size > limit:
        raise ValueError('controlled file identity invalid')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_uid, opened.st_nlink, opened.st_size) != (before.st_dev, before.st_ino, before.st_mode, before.st_uid, before.st_nlink, before.st_size):
            raise ValueError('controlled file changed')
        data = bytearray()
        while True:
            block = os.read(fd, min(1024 * 1024, limit - len(data) + 1))
            if not block: break
            data.extend(block)
            if len(data) > limit: raise ValueError('controlled file too large')
        after = os.fstat(fd)
        onpath = os.lstat(path)
        if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) or (onpath.st_dev, onpath.st_ino) != (opened.st_dev, opened.st_ino) or len(data) != opened.st_size:
            raise ValueError('controlled file changed during read')
        return bytes(data), opened
    finally: os.close(fd)

def hash_root(path, limit):
    if not os.path.isabs(path) or os.path.realpath(path) != path:
        raise ValueError('controlled file path invalid')
    parent = os.path.dirname(path)
    while True:
        entry = os.lstat(parent)
        if not stat.S_ISDIR(entry.st_mode) or entry.st_uid != 0 or entry.st_mode & 0o022:
            raise ValueError('controlled file ancestor invalid')
        if parent == '/': break
        parent = os.path.dirname(parent)
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_nlink != 1 or before.st_mode & 0o022 or before.st_size > limit:
        raise ValueError('controlled file identity invalid')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        held = os.fstat(fd)
        if (held.st_dev, held.st_ino, held.st_mode, held.st_uid, held.st_nlink, held.st_size) != (before.st_dev, before.st_ino, before.st_mode, before.st_uid, before.st_nlink, before.st_size):
            raise ValueError('controlled file changed')
        digest = hashlib.sha256()
        for block in iter(lambda: os.read(fd, 1024 * 1024), b''):
            digest.update(block)
        after = os.fstat(fd); onpath = os.lstat(path)
        if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (held.st_dev, held.st_ino, held.st_size, held.st_mtime_ns) or (onpath.st_dev, onpath.st_ino) != (held.st_dev, held.st_ino):
            raise ValueError('controlled file changed during read')
        return digest.hexdigest()
    finally: os.close(fd)

def verify_pid1_unit(name, path, expected_hash):
    if not os.path.isabs(path): raise ValueError('unit path invalid')
    out = subprocess.run(['/usr/bin/systemctl', 'show', name,
        '--property=LoadState,ActiveState,UnitFileState,MainPID,Job,FragmentPath,DropInPaths,NeedDaemonReload'],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=True).stdout
    if len(out) > 32768: raise ValueError('unit state too large')
    rows = out.decode('utf8').splitlines()
    fields = {}
    for line in rows:
        key, sep, value = line.partition('=')
        if not sep or key in fields: raise ValueError('unit state ambiguous')
        fields[key] = value
    if (fields.get('LoadState') != 'loaded' or fields.get('ActiveState') != 'inactive' or fields.get('UnitFileState') not in ('disabled', 'static')
        or fields.get('Job') or fields.get('FragmentPath') != path or fields.get('DropInPaths') or fields.get('NeedDaemonReload') != 'no'
        or name.endswith('.service') and fields.get('MainPID') != '0'):
        raise ValueError('unit is not inactive and disabled')
    visible = os.lstat(path)
    # /proc/1/root checks the exact file visible to PID1, not just the caller's namespace.
    host = os.stat('/proc/1/root' + path)
    if (visible.st_dev, visible.st_ino) != (host.st_dev, host.st_ino) or hash_root(path, 16 * 1024**2) != expected_hash:
        raise ValueError('PID1 unit identity differs')

def audit_locked(tools, pin, module, artifact_id):
    receipt = json.loads(read_root(f'{OUT}/verified-{artifact_id}.json', 8 * 1024**2, True)[0])
    if not isinstance(receipt, dict) or receipt.get('version') != 1 or receipt.get('pin') != pin:
        raise ValueError('verified receipt mismatch')
    archive = f'{OUT}/artifact-{artifact_id}.zip'
    # A root-controlled file is opened once, and the verified receipt binds its inode.
    before = os.lstat(archive)
    if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_nlink != 1 or before.st_mode & 0o077 or str(before.st_dev) != receipt.get('artifactDev') or str(before.st_ino) != receipt.get('artifactIno') or str(before.st_size) != receipt.get('artifactSize') or not 0 < before.st_size <= 2 * 1024**3:
        raise ValueError('artifact identity mismatch')
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as f:
        held = os.fstat(f.fileno())
        if (held.st_dev, held.st_ino) != (before.st_dev, before.st_ino): raise ValueError('artifact changed')
        manifest = module.verify_artifact_contents(pin, f)
        after = os.fstat(f.fileno())
        if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (held.st_dev, held.st_ino, held.st_size, held.st_mtime_ns): raise ValueError('artifact changed during audit')
    if receipt.get('manifest') != manifest:
        raise ValueError('receipt manifest mismatch')
    commit = pin.get('commit', '')
    if not isinstance(commit, str) or len(commit) != 40 or any(c not in '0123456789abcdef' for c in commit):
        raise ValueError('commit invalid')
    release = '/opt/toonflow-trim/releases/' + commit
    current = '/opt/toonflow-trim/current'
    current_entry = os.lstat(current)
    if not stat.S_ISLNK(current_entry.st_mode) or current_entry.st_uid != 0 or os.path.realpath(current) != release:
        raise ValueError('active release link mismatch')
    installed = {name: read_root(path, 16 * 1024**2)[0] for name, path in UNIT_PATHS.items()}
    installed['server/trimWorker.js'] = read_root(release + '/trimWorker.js', 16 * 1024**2)[0]
    installed['server/trimStore.js'] = read_root(release + '/trimStore.js', 16 * 1024**2)[0]
    installed['server/provisionTrimStore.js'] = read_root(release + '/provisionTrimStore.js', 16 * 1024**2)[0]
    installed['server/captureTrimRuntimeProof.js'] = read_root(release + '/captureTrimRuntimeProof.js', 16 * 1024**2)[0]
    installed['server/recoverTrimActive.js'] = read_root(release + '/recoverTrimActive.js', 16 * 1024**2)[0]
    installed['server/prepareTrimCgroup.js'] = read_root(release + '/prepareTrimCgroup.js', 16 * 1024**2)[0]
    module.verify_installed_bytes(manifest, installed)
    if hash_root(release + '/bun', 512 * 1024**2) != tools['bun_sha256']:
        raise ValueError('Bun binary differs from pinned runtime')
    for source, path in UNIT_PATHS.items():
        verify_pid1_unit(os.path.basename(path), path, manifest['unit_sources_sha256'][source])
    print('安装字节与 PID1 当前停用状态符合固定候选；未核验发布授权或后续状态')

def main():
    if os.geteuid() != 0 or sys.argv[1:] != ['--confirm-audit-installed-release'] or os.path.realpath(__file__) != SELF:
        raise ValueError('root and fixed audit command required')
    tools = json.loads(read_root(TOOLS, 16384, True)[0])
    if not isinstance(tools, dict) or set(tools) != {'gh_sha256', 'verifier_sha256', 'fetcher_sha256', 'auditor_sha256', 'installer_sha256', 'bun_sha256'}:
        raise ValueError('tool pin invalid')
    own = read_root(SELF, 1024 * 1024)[0]
    verifier = read_root(VERIFY, 1024 * 1024)[0]
    if hashlib.sha256(own).hexdigest() != tools['auditor_sha256'] or hashlib.sha256(verifier).hexdigest() != tools['verifier_sha256']:
        raise ValueError('audit tool mismatch')
    module = types.ModuleType('pinned_trim_artifact_verifier')
    exec(compile(verifier, VERIFY, 'exec'), module.__dict__)
    pin = json.loads(read_root(PIN, 16384, True)[0])
    artifact_id = pin.get('artifact_id') if isinstance(pin, dict) else None
    if type(artifact_id) is not int or artifact_id < 1:
        raise ValueError('release pin invalid')
    output_dir = os.lstat(OUT)
    if not stat.S_ISDIR(output_dir.st_mode) or output_dir.st_uid != 0 or output_dir.st_mode & 0o077 or os.path.realpath(OUT) != OUT: raise ValueError('release directory invalid')
    lockfd = os.open(OUT + '/release.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        lock = os.fstat(lockfd); entry = os.lstat(OUT + '/release.lock')
        if not stat.S_ISREG(lock.st_mode) or lock.st_uid != 0 or lock.st_nlink != 1 or stat.S_IMODE(lock.st_mode) != 0o600 or (lock.st_dev, lock.st_ino) != (entry.st_dev, entry.st_ino):
            raise ValueError('release lock invalid')
        fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        audit_locked(tools, pin, module, artifact_id)
    finally: os.close(lockfd)

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('安装核验失败：' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
