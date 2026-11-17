#!/usr/bin/env python3
"""tenant裁剪宿主组件准入；只读进程/socket，候选镜像仅create/cp，绝不启动。

root release.json必填trimRuntimeManifest/trimArtifactDirectory，及
trimWorkerService/trimStoreService、trimWorkerSocket/trimStoreSocket、
trimWorkerSocketPath/trimStoreSocketPath。manifest的hashes只允许下列七文件，
workerUid/storeUid/storeGid/accessGid均为正整数。不把sourceSha相等当作字节证据。
"""
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import resource
import stat
import subprocess
import tarfile
import tempfile
import uuid

from verifyBusiness import require, rootFile, rootJson, run


componentPaths = {
    'bun': '/usr/local/bin/bun',
    'trimWorker.js': '/app/build/server/trimWorker.js',
    'trimStore.js': '/app/build/server/trimStore.js',
    'provisionTrimStore.js': '/app/build/server/provisionTrimStore.js',
    'migrateBackgroundJobs.js': '/app/build/server/migrateBackgroundJobs.js',
    'quotaHelper.py': '/app/deploy/quota/quotaHelper.py',
    'trimQuota.py': '/app/deploy/quota/trimQuota.py',
}


def rootDirectory(path):
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts, '裁剪目录必须为固定绝对路径')
    for current in [path, *path.parents]:
        info = current.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                '裁剪目录或父目录不是root独占控制')
    return path


def fileHash(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def unitProperties(unit, suffix, fields):
    require(isinstance(unit, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.' + suffix, unit),
            '裁剪systemd单元名称非法')
    output = run(['systemctl', 'show', unit, *['--property=' + field for field in fields]]).decode()
    result = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
    require(set(result) == set(fields) and result.get('ActiveState') == 'active', '裁剪单元未active或属性缺失')
    # 单元覆盖项也必须由root控制；禁止借systemd加载可写文件绕过组件合同。
    for path in [result['FragmentPath'], *result['DropInPaths'].split()]:
        rootFile(path)
    return result


def numericIdentity(value, group=False):
    if value.isdecimal():
        return int(value)
    return grp.getgrnam(value).gr_gid if group else pwd.getpwnam(value).pw_uid


def processIdentity(service, uid, gid, arguments, executable, dependencies=()):
    properties = unitProperties(service, 'service',
                                ['ActiveState', 'MainPID', 'FragmentPath', 'DropInPaths'])
    require(properties['MainPID'].isdecimal() and int(properties['MainPID']) > 1, '裁剪服务MainPID无效')
    process = Path('/proc') / properties['MainPID']
    before = (process / 'stat').read_text()
    status = dict(line.split(':', 1) for line in (process / 'status').read_text().splitlines() if ':' in line)
    require([int(value) for value in status['Uid'].split()] == [uid] * 4, '裁剪服务真实UID不匹配')
    require([int(value) for value in status['Gid'].split()] == [gid] * 4, '裁剪服务真实GID不匹配')
    actual = (process / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
    expected = [os.fsencode(value) for value in arguments]
    require(actual[:len(expected)] == expected, '裁剪服务未使用固定版本执行文件')
    actualExe = (process / 'exe').stat()
    fixedExe = Path(executable).stat()
    require((actualExe.st_dev, actualExe.st_ino) == (fixedExe.st_dev, fixedExe.st_ino),
            '裁剪服务正在运行的可执行文件已变化')
    startTicks = int(before.rsplit(') ', 1)[1].split()[19])
    bootTimes = [line.split()[1] for line in Path('/proc/stat').read_text().splitlines()
                 if line.startswith('btime ')]
    require(len(bootTimes) == 1 and bootTimes[0].isdecimal(), '无法确定裁剪进程启动时刻')
    # btime仅有秒精度，向下取整作为保守下界；同秒新安装文件也必须重启后再验。
    startedBefore = (int(bootTimes[0]) + startTicks // os.sysconf('SC_CLK_TCK')) * 10**9
    controlled = [Path(executable).resolve(strict=True), Path(arguments[1]), *dependencies]
    for path in controlled:
        info = rootFile(path).stat()
        require(info.st_ctime_ns < startedBefore and info.st_mtime_ns < startedBefore,
                '裁剪组件在进程启动后发生变化，必须重启对应服务')
    require((process / 'stat').read_text().rsplit(') ', 1)[1].split()[19]
            == str(startTicks), '裁剪服务进程发生变化')
    return process


def socketIdentity(unit, service, path, uid, gid, descriptorName, process):
    socket = Path(path)
    require(socket.is_absolute() and '..' not in socket.parts, '裁剪socket路径非法')
    rootDirectory(socket.parent)
    info = socket.lstat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == uid and info.st_gid == gid
            and stat.S_IMODE(info.st_mode) == 0o660, '裁剪socket类型/属主/权限不匹配')
    properties = unitProperties(unit, 'socket', ['ActiveState', 'FragmentPath', 'DropInPaths',
                                              'SocketUser', 'SocketGroup', 'SocketMode',
                                              'FileDescriptorName', 'Listen', 'Triggers'])
    require(numericIdentity(properties['SocketUser']) == uid
            and numericIdentity(properties['SocketGroup'], group=True) == gid
            and properties['SocketMode'] in ('0660', '660')
            and properties['FileDescriptorName'] == descriptorName
            and properties['Listen'] == str(socket) + ' (Stream)'
            and properties['Triggers'].split() == [service], '裁剪socket激活协议不匹配')
    # 确认目标进程持有该路径的实际监听fd，不能只看一个同名socket文件。
    inodes = set()
    for line in Path('/proc/net/unix').read_text().splitlines()[1:]:
        fields = line.split()
        if len(fields) == 8 and fields[7] == str(socket) and fields[3] == '00010000' and fields[4] == '0001':
            inodes.add('socket:[' + fields[6] + ']')
    require(inodes and any(os.readlink(fd) in inodes for fd in (process / 'fd').iterdir()),
            '裁剪进程未持有指定socket监听描述符')


def limitArchive():
    resource.setrlimit(resource.RLIMIT_FSIZE, (256 * 1024**2, 256 * 1024**2))


def candidateHashes(image):
    require(isinstance(image, str) and re.fullmatch(
        r'ghcr.io/perfectuser21/zenithjoy-toonflow@sha256:[a-f0-9]{64}', image), '候选镜像必须固定digest')
    metadata = json.loads(run(['docker', 'image', 'inspect', image]))[0]
    require(not metadata['Config'].get('Volumes'), '裁剪候选extractor禁止隐式数据卷')
    rootDirectory('/run')
    name = 'aivideoTrimReadiness' + uuid.uuid4().hex
    container = None
    with tempfile.TemporaryDirectory(prefix='aivideoTrimReadiness', dir='/run') as temporary:
        rootDirectory(temporary)
        try:
            container = run(['docker', 'create', '--name', name, '--pull=never', '--network=none',
                             '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                             '--entrypoint=/bin/false', image]).decode().strip()
            require(re.fullmatch('[a-f0-9]{64}', container), '候选extractor身份无效')
            inspected = json.loads(run(['docker', 'inspect', container]))[0]
            require(inspected['State']['Status'] == 'created' and not inspected['Mounts']
                    and inspected['Image'] == metadata['Id']
                    and inspected['HostConfig']['ReadonlyRootfs'] is True
                    and inspected['HostConfig']['NetworkMode'] == 'none', '候选extractor隔离合同不匹配')
            hashes = {}
            archivePath = Path(temporary) / 'component.tar'
            for filename, source in componentPaths.items():
                with open(archivePath, 'wb') as output:
                    result = subprocess.run(['docker', 'cp', container + ':' + source, '-'],
                                            stdout=output, stderr=subprocess.PIPE, timeout=120,
                                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'},
                                            preexec_fn=limitArchive)
                require(result.returncode == 0, '无法提取候选裁剪组件: ' + filename)
                with tarfile.open(archivePath, 'r:') as archive:
                    member = archive.next()
                    require(member is not None and member.name == filename and member.isfile()
                            and not member.issym() and not member.islnk() and 0 < member.size <= 256 * 1024**2,
                            '候选裁剪组件不是固定路径常规文件: ' + filename)
                    digest = hashlib.sha256()
                    with archive.extractfile(member) as content:
                        for block in iter(lambda: content.read(1024 * 1024), b''):
                            digest.update(block)
                    require(archive.next() is None, '候选组件archive包含额外文件')
                    hashes[filename] = digest.hexdigest()
            return hashes
        finally:
            # 仅本次create的未启动代码容器；不挂用户数据，不删除volume或业务产物。
            if container is not None and re.fullmatch('[a-f0-9]{64}', container):
                run(['docker', 'rm', container])


def verifyRuntimeReadiness(config, business, request):
    if business.get('businessMode') == 'shared':
        require(request['environment'] == 'staging', 'shared裁剪不能证明生产tenant')
        return {'trimRuntimeVerified': False, 'trimRuntimeScope': 'sharedBypass'}
    require(business.get('businessMode') == 'tenant', '裁剪业务模式缺失')
    manifest = rootJson(config['trimRuntimeManifest'])
    directory = rootDirectory(config['trimArtifactDirectory'])
    require(isinstance(manifest.get('hashes'), dict) and set(manifest['hashes']) == set(componentPaths)
            and all(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value)
                    for value in manifest['hashes'].values()), '裁剪manifest组件hash合同不完整')
    for field in ('workerUid', 'storeUid', 'storeGid', 'accessGid'):
        require(type(manifest.get(field)) is int and 0 < manifest[field] < 2**31, '裁剪manifest身份无效')
    require(manifest['workerUid'] != manifest['storeUid'], '裁剪worker/store必须使用独立UID')
    for filename, expected in manifest['hashes'].items():
        require(fileHash(rootFile(directory / filename)) == expected, '宿主裁剪组件hash变化: ' + filename)
    require(Path(config['quotaHelper']) == directory / 'quotaHelper.py', '配额helper未使用同一版本目录')
    require(candidateHashes(request['image']) == manifest['hashes'], '候选镜像与宿主裁剪组件字节不一致')
    bun = rootFile(directory / 'bun', executable=True)
    for role, script, descriptor in [('Worker', 'trimWorker.js', 'trimWorker'), ('Store', 'trimStore.js', 'trimStore')]:
        service = config['trim' + role + 'Service']
        uid = manifest[role.lower() + 'Uid']
        gid = manifest['storeGid'] if role == 'Store' else manifest['accessGid']
        process = processIdentity(service, uid, gid, [str(bun), str(directory / script)], bun)
        socketIdentity(config['trim' + role + 'Socket'], service, config['trim' + role + 'SocketPath'],
                       uid, manifest['accessGid'], descriptor, process)
    quotaProcess = processIdentity(config['quotaService'], 0, 0,
                                   ['/usr/bin/python3', str(directory / 'quotaHelper.py')], '/usr/bin/python3',
                                   [directory / 'trimQuota.py'])
    require(quotaProcess.exists(), '配额helper进程已退出')
    return {'trimRuntimeVerified': True, 'trimRuntimeScope': 'tenant',
            'trimRuntimeHashes': manifest['hashes']}
