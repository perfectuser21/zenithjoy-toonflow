#!/usr/bin/env python3
"""固定 OCI digest 的完整性校验及香港只读中继；不接触业务服务。"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import shutil
import tarfile
import tempfile
import time
import urllib.request
from contextlib import contextmanager

from stagingWitness import witnessCommand, witnessPayload

imagePattern = r'ghcr.io/perfectuser21/zenithjoy-toonflow@sha256:[a-f0-9]{64}'
processEnvironment = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin', 'LANG':'C.UTF-8'}


class DiagnosticFailure(Exception):
    pass


class TransferProcessError(RuntimeError):
    def __init__(self, message, exitCode):
        super().__init__(message)
        self.exitCode = exitCode


def errorClass(error):
    for kind in (subprocess.TimeoutExpired, subprocess.SubprocessError, OSError, ValueError, KeyError, RuntimeError):
        if isinstance(error, kind):
            return kind.__name__
    return 'OtherError'


def recordEvent(handle, phase, status, error=None, exitCode=None, stderrTruncated=None):
    event = {'phase':phase, 'status':status, 'errorClass':errorClass(error) if error else None,
             'exit':exitCode, 'stderrTruncated':stderrTruncated, 'time':time.time()}
    try:
        handle.write(json.dumps(event, separators=(',', ':')) + '\n')
        handle.flush()
        os.fsync(handle.fileno())
    except (OSError, ValueError) as failure:
        raise DiagnosticFailure('private diagnostic write failed') from failure


@contextmanager
def transferPhase(handle, phase):
    recordEvent(handle, phase, 'started')
    try:
        yield
    except Exception as error:
        recordEvent(handle, phase, 'failed', error,
                    error.exitCode if isinstance(error, TransferProcessError) else None)
        raise
    recordEvent(handle, phase, 'completed')


def importArchive(archive, temporary, handle):
    # 仅固定 ctr import 的 stderr 可写入 root 私有诊断，输入为已校验 OCI 文件，不含 registry 凭据。
    process = subprocess.Popen(ctrCommand() + ['images', 'import', '--all-platforms', '--snapshotter', 'overlayfs', str(archive)],
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                               env=processEnvironment)
    stderrPath = Path(temporary) / 'import.stderr'
    selector = selectors.DefaultSelector()
    deadline = time.monotonic() + 1800
    try:
        selector.register(process.stderr, selectors.EVENT_READ)
        with stderrPath.open('xb') as output:
            os.chmod(stderrPath, 0o600)
            size = 0; truncated = False
            try:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired('ctr images import', 1800)
                    if not selector.select(timeout=min(1, remaining)):
                        continue
                    block = os.read(process.stderr.fileno(), 65536)
                    if not block:
                        break
                    available = max(0, 65536 - size)
                    output.write(block[:available])
                    size += min(len(block), available)
                    truncated = truncated or len(block) > available
            finally:
                output.flush()
                os.fsync(output.fileno())
        result = process.wait(timeout=max(0.01, deadline - time.monotonic()))
        recordEvent(handle, 'import', 'exit', exitCode=result, stderrTruncated=truncated)
        if result != 0:
            raise TransferProcessError('镜像导入失败', result)
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        selector.close()
        process.stderr.close()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def ctrCommand():
    socket = Path('/run/containerd/containerd.sock')
    for parent in socket.parents:
        info = parent.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'containerd socket父目录不受root保护')
    info = socket.lstat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
            and not info.st_mode & 0o007, 'containerd socket须root专属')
    return ['/usr/bin/ctr', '--address', str(socket), '--namespace', 'moby']


def archiveLimit(config):
    maximum = config.get('imageArchiveMaxBytes', 4 * 1024 ** 3)
    require(type(maximum) is int and 1024 ** 2 <= maximum <= 4 * 1024 ** 3, '镜像归档容量配置不合法')
    return maximum


def privateDirectory(config):
    path = Path(config['imageTransferDirectory'])
    require(path.is_absolute(), '镜像临时目录须绝对路径')
    for parent in [path, *path.parents]:
        info = parent.lstat()
        require(not parent.is_symlink() and info.st_uid == 0 and not info.st_mode & 0o022,
                '镜像临时目录不受root保护')
    require(path.is_dir() and not path.stat().st_mode & 0o077, '镜像临时目录须root私有')
    space = os.statvfs(path)
    require(space.f_bavail * space.f_frsize >= 2 * archiveLimit(config) + 1024 ** 3, '镜像传输空间不足')
    return path


def boundedArchive(command, path, maximum, payload=None, timeout=300):
    # stderr仅保留退出码，防止认证头或远端错误内容流入CI日志。
    with path.open('xb') as output:
        os.chmod(path, 0o600)
        process = subprocess.Popen(command, stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=processEnvironment)
        try:
            if payload is not None:
                process.stdin.write(json.dumps(payload).encode())
                process.stdin.close()
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + timeout
            size = 0
            while True:
                require(time.monotonic() < deadline, '镜像传输超时')
                if not selector.select(timeout=1):
                    continue
                block = os.read(process.stdout.fileno(), 1024 * 1024)
                if not block:
                    break
                size += len(block)
                require(size <= maximum, '镜像归档超容量')
                output.write(block)
            result = process.wait(timeout=max(1, deadline - time.monotonic()))
            if result != 0:
                raise TransferProcessError('镜像导出或中继失败', result)
            output.flush()
            os.fsync(output.fileno())
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdout.close()
            if 'selector' in locals():
                selector.close()


def verifyArchive(path, request, maximum):
    require(re.fullmatch(imagePattern, request['image']) is not None, '镜像引用不合法')
    require(0 < path.stat().st_size <= maximum, '镜像归档大小不合法')
    with tarfile.open(path, mode='r:') as archive:
        members = {}
        total = 0
        for member in archive:
            require(len(members) < 16384 and member.name not in members, '归档成员重复或过多')
            require(member.name in ('index.json', 'oci-layout', 'blobs', 'blobs/sha256')
                    or re.fullmatch(r'blobs/sha256/[a-f0-9]{64}', member.name), '归档包含额外路径')
            require(member.isdir() if member.name in ('blobs', 'blobs/sha256') else member.isfile(),
                    '归档禁止链接或特殊文件')
            require(not member.pax_headers and member.sparse is None, '归档不接受扩展路径或稀疏元数据')
            total += member.size
            require(total <= maximum and member.size >= 0, '归档内容超容量')
            members[member.name] = member
        def readJson(name):
            require(name in members and members[name].size <= 8 * 1024 ** 2, 'OCI元数据不存在或过大')
            return json.load(archive.extractfile(members[name]))
        require(readJson('oci-layout') == {'imageLayoutVersion':'1.0.0'}, 'OCI布局不合法')
        blobs = {}
        for name, member in members.items():
            if not name.startswith('blobs/sha256/'):
                continue
            digest = hashlib.sha256()
            actualSize = 0
            with archive.extractfile(member) as content:
                while block := content.read(1024 * 1024):
                    digest.update(block)
                    actualSize += len(block)
            require(actualSize == member.size, 'OCI blob实际大小错误')
            require(digest.hexdigest() == name.rsplit('/', 1)[1], 'OCI blob哈希错误')
            blobs['sha256:' + digest.hexdigest()] = member
        index = readJson('index.json')
        require(index.get('schemaVersion') == 2 and len(index.get('manifests', [])) == 1, '归档须仅含一个镜像')
        root = index['manifests'][0]
        require(root.get('digest') == request['image'].split('@')[1], '归档根digest不匹配')
        annotations = root.get('annotations', {})
        require(annotations.get('io.containerd.image.name') == request['image'], '归档仓库身份不匹配')
        reference = annotations.get('org.opencontainers.image.ref.name')
        require(reference in (None, request['image'], '@' + request['image'].split('@')[1]),
                '归档包含额外镜像名称')
        visited = set()
        runtimeCount = 0
        runtimeDigests = set()
        attestationReferences = []
        def visit(descriptor, depth=0, attestation=False):
            nonlocal runtimeCount
            require(depth < 8 and isinstance(descriptor, dict), 'OCI图过深或描述符不合法')
            digest = descriptor.get('digest')
            require(digest in blobs and type(descriptor.get('size')) is int
                    and descriptor['size'] == blobs[digest].size, 'OCI内容缺失或大小错误')
            if digest in visited:
                return
            visited.add(digest)
            mediaType = descriptor.get('mediaType')
            if mediaType in ('application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'):
                document = readJson(blobs[digest].name)
                require(document.get('schemaVersion') == 2 and document.get('manifests'), 'OCI索引不合法')
                for child in document['manifests']:
                    annotation = child.get('annotations', {})
                    isAttestation = annotation.get('vnd.docker.reference.type') == 'attestation-manifest'
                    if isAttestation:
                        attestationReferences.append(annotation.get('vnd.docker.reference.digest'))
                    visit(child, depth + 1, isAttestation)
            elif mediaType in ('application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'):
                document = readJson(blobs[digest].name)
                require(document.get('schemaVersion') == 2 and isinstance(document.get('layers'), list), 'OCI manifest不合法')
                visit(document['config'], depth + 1)
                imageConfig = readJson(blobs[document['config']['digest']].name)
                if attestation:
                    require(imageConfig.get('os') == 'unknown' and imageConfig.get('architecture') == 'unknown', '证明镜像平台不合法')
                    require(all(layer.get('mediaType') == 'application/vnd.in-toto+json' for layer in document['layers']),
                            '证明镜像含额外运行层')
                else:
                    require(imageConfig.get('os') == 'linux' and imageConfig.get('architecture') == 'amd64', '镜像平台须linux/amd64')
                    require((imageConfig.get('config', {}).get('Labels') or {}).get('org.opencontainers.image.revision')
                            == request['sourceSha'], 'OCI源码SHA不匹配')
                    runtimeCount += 1
                    runtimeDigests.add(digest)
                for layer in document['layers']:
                    visit(layer, depth + 1)
            else:
                require(mediaType in ('application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json',
                        'application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip',
                        'application/vnd.oci.image.layer.v1.tar+zstd', 'application/vnd.docker.image.rootfs.diff.tar.gzip',
                        'application/vnd.in-toto+json'), 'OCI blob类型不许可')
        visit(root)
        require(runtimeCount == 1 and visited == set(blobs)
                and all(reference in runtimeDigests for reference in attestationReferences),
                '归档含额外镜像、无关联证明或未引用blob')


def exportCommand(image):
    require(re.fullmatch(imagePattern, image) is not None, '镜像引用不合法')
    return ctrCommand() + ['images', 'export', '--all-platforms', '--skip-manifest-json', '-', image]


def fetchContent(registry, image, directory):
    basic = base64.b64encode((registry['user'] + ':' + registry['token']).encode()).decode()
    request = urllib.request.Request('https://ghcr.io/token?service=ghcr.io&scope=repository:perfectuser21/zenithjoy-toonflow:pull',
                                     headers={'Authorization':'Basic ' + basic})
    # 禁止重定向，避免把短期凭据发往其他域名。
    class noRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, filePointer, code, message, headers, newUrl):
            return None
    with urllib.request.build_opener(noRedirect).open(request, timeout=30) as response:
        bearer = json.loads(response.read(65537))['token']
    require(isinstance(bearer, str) and 0 < len(bearer) <= 16384
            and re.fullmatch(r'[A-Za-z0-9._~+/-]+=*', bearer), 'registry bearer不合法')
    hosts = Path(directory) / 'ghcr.io'
    hosts.mkdir(mode=0o700)
    config = hosts / 'hosts.toml'
    config.write_text('server = "https://ghcr.io"\n[host."https://ghcr.io"]\n  capabilities = ["pull", "resolve"]\n'
                      '  [host."https://ghcr.io".header]\n    Authorization = ["Bearer ' + bearer + '"]\n')
    os.chmod(config, 0o600)
    result = subprocess.run(ctrCommand() + ['content', 'fetch', '--hosts-dir', directory, '--all-platforms', image],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1800, env=processEnvironment)
    if result.returncode != 0:
        raise TransferProcessError('镜像完整内容拉取失败', result.returncode)


def registryRuntimeDirectory():
    path = Path('/run')
    for parent in (path, *path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                and info.st_uid == 0 and not info.st_mode & 0o022, '临时凭据目录不受root保护')
    result = subprocess.run(['/usr/bin/findmnt', '-n', '-o', 'FSTYPE', '--target', str(path)],
                            capture_output=True, text=True, timeout=10, env=processEnvironment)
    require(result.returncode == 0 and result.stdout.strip() == 'tmpfs', '临时凭据须位于tmpfs')
    return path


def ensureImage(config, request, registry):
    directory = privateDirectory(config)
    maximum = archiveLimit(config)
    # 未决 scratch 必须先由运维读回处理，禁止并发或反复失败无限积累。
    with os.scandir(directory) as entries:
        require(not any(entry.name.startswith('imageTransfer') for entry in entries), '存在未处理的镜像传输诊断')
    temporary = tempfile.mkdtemp(prefix='imageTransfer-' + request['runId'] + '-' + request['runAttempt'] + '-', dir=directory)
    succeeded = False
    try:
        os.chmod(temporary, 0o700)
        directoryFd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directoryFd)
        finally:
            os.close(directoryFd)
        events = open(Path(temporary) / 'events.jsonl', 'x', encoding='utf-8',
                      opener=lambda p, flags: os.open(p, flags, 0o600))
        with events:
            identity = {key:request[key] for key in ('environment','sourceSha','image','runId','runAttempt')}
            with open(Path(temporary) / 'identity.json', 'x', encoding='utf-8',
                      opener=lambda p, flags: os.open(p, flags, 0o600)) as identityFile:
                json.dump(identity, identityFile, separators=(',', ':'))
                identityFile.flush()
                os.fsync(identityFile.fileno())
            scratchFd = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(scratchFd)
            finally:
                os.close(scratchFd)
            _ensureImage(config, request, registry, temporary, maximum, events)
        succeeded = True
    finally:
        # 失败保留本次有界归档和诊断；未知结果不得自动删除或重试。
        if succeeded:
            shutil.rmtree(temporary)


def _ensureImage(config, request, registry, temporary, maximum, events):
    archive = Path(temporary) / 'image.oci'
    # 完整导出并校验才算缓存命中；docker inspect成功不代表压缩blob齐全。
    try:
        with transferPhase(events, 'cache_export'):
            boundedArchive(exportCommand(request['image']), archive, maximum)
        with transferPhase(events, 'cache_verify'):
            verifyArchive(archive, request, maximum)
        return
    except (RuntimeError, OSError, ValueError, KeyError, tarfile.TarError, subprocess.SubprocessError):
        archive.unlink(missing_ok=True)
    if request['environment'] == 'production':
        with transferPhase(events, 'witness_export'):
            boundedArchive(witnessCommand(config), archive, maximum, witnessPayload(request, 'exportImage'), timeout=7200)
    else:
        require(isinstance(registry, dict) and set(registry) == {'user', 'token'}, '缺少短期镜像读取身份')
        require(isinstance(registry['user'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,99}(?:\[bot\])?', registry['user'])
                and isinstance(registry['token'], str) and 0 < len(registry['token']) <= 4096
                and not any(character in registry['token'] for character in '\r\n'), '镜像读取身份不合法')
        # 凭据不放进保留的 OCI 诊断目录；非正常退出时仅遗留 root 私有 tmpfs 至重启。
        with tempfile.TemporaryDirectory(prefix='aivideo-registry-', dir=registryRuntimeDirectory()) as credentialDirectory:
            os.chmod(credentialDirectory, 0o700)
            auth = {'auths':{'ghcr.io':{'auth':base64.b64encode((registry['user'] + ':' + registry['token']).encode()).decode()}}}
            dockerConfig = Path(credentialDirectory) / 'config.json'
            dockerConfig.write_text(json.dumps(auth))
            os.chmod(dockerConfig, 0o600)
            with transferPhase(events, 'registry_pull'):
                result = subprocess.run(['docker', '--config', credentialDirectory, 'pull', request['image']],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1800, env=processEnvironment)
                if result.returncode != 0:
                    raise TransferProcessError('镜像拉取失败', result.returncode)
            with transferPhase(events, 'registry_content'):
                fetchContent(registry, request['image'], credentialDirectory)
        with transferPhase(events, 'registry_export'):
            boundedArchive(exportCommand(request['image']), archive, maximum)
    with transferPhase(events, 'archive_verify'):
        verifyArchive(archive, request, maximum)
    with transferPhase(events, 'import'):
        importArchive(archive, temporary, events)
    # 再导出读回实际containerd内容；不允许导入后以缺blob镜像进入停机阶段。
    readback = Path(temporary) / 'readback.oci'
    with transferPhase(events, 'readback_export'):
        boundedArchive(exportCommand(request['image']), readback, maximum)
    with transferPhase(events, 'readback_verify'):
        verifyArchive(readback, request, maximum)
