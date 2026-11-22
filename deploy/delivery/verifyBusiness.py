#!/usr/bin/env python3
"""发布运行时业务验收；只修改已明确配置的专用验收画布，不删除任何产物。

由 root 安装，stdin 接收 releaseHost 的版本请求。release.json 额外配置
businessConfig，指向 root:root 0600 JSON：
  environment/publicOrigin（与发布配置一致）、localOrigin（候选容器公开端口的回环地址）
  accounts（恰好两个：credentialFile/userId/directory/canvasPath）
  trim（source/start/end，source 为首账号工作区已有的专用视频）
businessMode 必填tenant或shared；shared仅staging，改配sharedWorkspace
（directory/canvasPath），专用已有seed画布必须有deliveryAcceptance=true。
shared不登录普通账号、不声称跨账号隔离，按旧原生FFmpeg协议截取，
并在验收前后校验已启用的公网逐帧拉片节点与候选容器构建包 SHA-256 一致。
accessCredentialFile 可指向root:root 0600 JSON（clientId/clientSecret），
仅向固定HTTPS publicOrigin附加CF Access服务凭据，回环请求不附加。
credentialFile 为 root:root 0600 JSON，只有 userName/password；仅可使用专用账号。
画布必须已存在；保存使用 expectedRevision，不覆写并发修改。每次裁剪保留新产物，
不清理、不自动重试未知结果，不调用模型。运行结果不回显凭据、路径或用户内容。

generationVerifier 为 root 安装的固定可执行程序：stdin 为版本请求，stdout 为
同五个身份字段、publicOrigin、result=passed、generationVerified=true；必须真实
验收本候选生成任务，不接受历史任务、stub或豁免。本程序不自带生成模型调用，
缺少该程序即失败；运维安装前应确认其费用授权及验收合同。
公网与候选容器回环 /api/delivery/identity 的sourceSha/image/bootId必须完全一致，
不能在反代注入静态版本。缺失上述能力时失败，不能使发布晋级。
"""
import hashlib
import http.cookiejar
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
import unicodedata


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def rootFile(path, private=False, executable=False):
    path = Path(path)
    require(path.is_absolute(), '配置路径必须为绝对路径')
    for current in [path, *path.parents]:
        info = current.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0
                and not info.st_mode & 0o022, '配置或父目录权限不安全')
    info = path.stat()
    require(stat.S_ISREG(info.st_mode), '控制文件类型错误')
    require(not private or stat.S_IMODE(info.st_mode) == 0o600, '私密配置必须为0600')
    require(not executable or os.access(path, os.X_OK), '固定生成验收器不可执行')
    return path


def rootJson(path, private=False):
    path = rootFile(path, private)
    require(path.stat().st_size <= 65536, '配置文件过大')
    return json.loads(path.read_text())


def run(args, timeout=30, input=None):
    result = subprocess.run(args, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
    require(result.returncode == 0, '本机候选或媒体核验失败')
    return result.stdout


class noRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newUrl):
        return None


class publicClient:
    def __init__(self, origin, accessCredentialFile=None):
        self.origin = origin
        self.accessHeaders = {}
        if accessCredentialFile:
            require(origin.startswith('https://'), 'Access凭据只能发送至固定HTTPS公网入口')
            credentials = rootJson(accessCredentialFile, private=True)
            require(set(credentials) == {'clientId', 'clientSecret'}
                    and all(isinstance(value, str) and value and '\r' not in value and '\n' not in value
                            for value in credentials.values()), 'Access专用凭据配置错误')
            self.accessHeaders = {'CF-Access-Client-Id': credentials['clientId'],
                                  'CF-Access-Client-Secret': credentials['clientSecret']}
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), noRedirect(), urllib.request.HTTPCookieProcessor(self.jar))

    def request(self, method, path, query=None, body=None, raw=False, expected=200, limit=20 * 1024 * 1024, sse=False, timeout=240):
        require(path.startswith('/api/') and '?' not in path, '接口路径非法')
        url = self.origin + path + ('?' + urllib.parse.urlencode(query) if query else '')
        headers = {'Origin': self.origin, 'Referer': self.origin + '/', 'x-toonflow-workspace': '1',
                   'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity', **self.accessHeaders}
        if body is not None:
            headers['Content-Type'] = 'application/octet-stream' if raw else 'application/json'
            if not raw:
                body = json.dumps(body).encode()
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            require(response.status == expected, '公网业务接口状态不符合合同: ' + path
                    + ' HTTP ' + str(response.status))
            content = response.read(limit + 1)
            require(len(content) <= limit, '公网业务响应过大')
            if expected != 200:
                return None
            if raw:
                return content
            if sse:
                require(response.headers.get_content_type() == 'text/event-stream', '原生截取未返回事件流')
                events = []
                for block in content.decode().replace('\r\n', '\n').split('\n\n'):
                    data = '\n'.join(line[5:].lstrip() for line in block.split('\n') if line.startswith('data:'))
                    if data:
                        events.append(json.loads(data))
                require(events and not any(event.get('event') == 'error' for event in events)
                        and sum(event.get('event') == 'end' for event in events) == 1
                        and events[-1].get('event') == 'end', '原生截取失败或未确认结束')
                return events
            value = json.loads(content)
            require(isinstance(value, dict) and value.get('code') == 200, '公网业务接口未成功: ' + path)
            return value.get('data')

    def login(self, account):
        credentials = rootJson(account['credentialFile'], private=True)
        require(set(credentials) == {'userName', 'password'}
                and all(isinstance(value, str) and value for value in credentials.values()), '专用账号配置错误')
        result = self.request('POST', '/api/multiTenant/user/login', body=credentials)
        require(result.get('user') == {'id': account['userId'], 'role': 'user',
                                      'userName': credentials['userName']}, '登录身份不是固定普通验收账号')
        self.session(account)

    def session(self, account):
        result = self.request('GET', '/api/multiTenant/user/session')
        user = result.get('user') or {}
        require(result.get('enabled') is True and result.get('publicWeb') is True
                and result.get('host') is False and user.get('role') == 'user'
                and user.get('id') == account['userId'], '公网未进入普通账号多租户模式')


def fileQuery(account, path=None):
    return {'directory': account['directory'], 'path': path or account['canvasPath']}


def newPublicClient(config):
    return publicClient(config['publicOrigin'], config.get('accessCredentialFile'))


def relativeFile(value):
    require(isinstance(value, str) and value and '\\' not in value
            and not PurePosixPath(value).is_absolute()
            and all(part not in ('', '.', '..') for part in value.split('/')), '专用文件路径非法')


def validateBusinessConfig(config):
    """只读配置校验；不访问业务HTTP、不写文件。凭据仅从root保护文件读取。

    返回需由readiness检查真实deliveryAcceptance=true标记的workspace列表。
    此函数只校验seed坐标，不将配置存在冒充真实seed标记验收。
    """
    require(isinstance(config, dict), '业务验收配置必须为对象')
    origins = {'staging': 'https://toonflow.zenjoymedia.media', 'production': 'https://aivideo.zenithjoy.tech'}
    require(config.get('environment') in origins and config.get('publicOrigin') == origins[config['environment']],
            '业务验收固定环境或公网入口配置错误')
    local = urllib.parse.urlsplit(config.get('localOrigin', ''))
    require(local.scheme == 'http' and local.hostname in ('127.0.0.1', '::1') and local.port
            and not local.username and not local.password and local.path in ('', '/')
            and not local.query and not local.fragment, '业务验收本机入口必须为HTTP回环端口')
    mode = config.get('businessMode')
    require(mode in ('tenant', 'shared') and (mode == 'tenant' or config['environment'] == 'staging'),
            '生产强制tenant模式；shared仅允许员工staging')
    workspaces = config.get('accounts') if mode == 'tenant' else [config.get('sharedWorkspace')]
    require(isinstance(workspaces, list) and len(workspaces) == (2 if mode == 'tenant' else 1),
            '缺少固定专用验收工作区；tenant必须恰好两个账号')
    for workspace in workspaces:
        require(isinstance(workspace, dict), '专用验收工作区配置必须为对象')
        directory = workspace.get('directory')
        require(isinstance(directory, str) and 1 <= len(directory) <= 4096
                and PurePosixPath(directory).is_absolute() and '..' not in directory.split('/')
                and '\\' not in directory and not re.search(r'[\x00-\x1f]', directory),
                '验收工作区必须为固定安全绝对路径')
        relativeFile(workspace.get('canvasPath'))
        require(len(workspace['canvasPath']) <= 4096
                and not re.search(r'[\x00-\x1f]', workspace['canvasPath']), '专用seed画布路径非法')
        if mode == 'tenant':
            userId = workspace.get('userId')
            require(isinstance(userId, str) and re.fullmatch(
                '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', userId), '验收账号ID非法')
            credentials = rootJson(workspace.get('credentialFile', ''), private=True)
            require(isinstance(credentials, dict) and set(credentials) == {'userName', 'password'}, '专用账号凭据字段错误')
            userName, password = credentials['userName'], credentials['password']
            require(isinstance(userName, str) and userName == unicodedata.normalize('NFKC', userName.strip())
                    and 1 <= len(userName) <= 64 and not re.search(r'[\s\x00-\x1f\x7f]', userName)
                    and isinstance(password, str) and 8 <= len(password) <= 128, '专用账号用户名或密码格式错误')
    if mode == 'tenant':
        require(workspaces[0]['userId'] != workspaces[1]['userId']
                and workspaces[0]['directory'] != workspaces[1]['directory'], '专用验收账号及工作区必须不同')
    if config.get('accessCredentialFile'):
        credentials = rootJson(config['accessCredentialFile'], private=True)
        require(isinstance(credentials, dict) and set(credentials) == {'clientId', 'clientSecret'}
                and all(isinstance(value, str) and value and not re.search(r'[\x00-\x20\x7f]', value)
                        for value in credentials.values()), 'Access专用凭据内容格式错误')
    trim = config.get('trim')
    require(isinstance(trim, dict) and {'source', 'start', 'end'} <= set(trim), '缺少专用截取源及时间配置')
    source = trim['source']
    if mode == 'shared' and isinstance(source, str) and PurePosixPath(source).is_absolute():
        require('..' not in source.split('/') and '\\' not in source, '共享截取源绝对路径非法')
        try:
            relativeFile(str(PurePosixPath(source).relative_to(PurePosixPath(workspaces[0]['directory']))))
        except ValueError:
            raise RuntimeError('共享截取源必须在专用工作区内') from None
    else:
        relativeFile(source)
    require(isinstance(source, str) and len(source) <= 4096 and not re.search(r'[\x00-\x1f]', source)
            and all(type(trim[key]) in (int, float) and math.isfinite(trim[key]) for key in ('start', 'end'))
            and 0 <= trim['start'] < trim['end'] <= 120, '专用截取参数非法')
    require(config.get('generationVerifier'), '缺少本候选真实生成任务验收器')
    rootFile(config['generationVerifier'], executable=True)
    return workspaces


def snapshot(client, account):
    result = client.request('GET', '/api/workspaces/files/read',
                            {**fileQuery(account), 'snapshot': 'true', 'maxBytes': 4 * 1024 * 1024})
    require(re.fullmatch('[a-f0-9]{64}', result.get('revision', '')) is not None, '画布缺少读回版本')
    canvas = json.loads(result['text'])
    require(isinstance(canvas, dict) and canvas.get('toonflowCanvas') is True
            and isinstance(canvas.get('nodes'), list) and isinstance(canvas.get('edges'), list)
            and isinstance(canvas.get('viewport'), dict), '专用验收文件不是有效画布')
    return result, canvas


def verifyNode(client, name, displayName):
    nodes = client.request('GET', '/api/nodes/get')
    require(isinstance(nodes, list) and any(
        isinstance(node, dict) and node.get('name') == name
        and node.get('enabled') is True and not node.get('loadError')
        for node in nodes), '当前工作区无法添加节点 ' + displayName)
    bundle = client.request('GET', '/api/nodes/files', {'name': name}, raw=True)
    header = re.match(rb'/\*! toonflowNode:([^\r\n]+) \*/\r?\n', bundle)
    try:
        manifest = json.loads(header[1]) if header else None
    except ValueError:
        raise RuntimeError('公网节点脚本清单无效 ' + displayName) from None
    require(isinstance(manifest, dict) and manifest.get('displayName') == displayName
            and len(bundle) > header.end(), '公网未返回节点脚本 ' + displayName)
    return bundle


def verifySharedFrameNode(client, containerId):
    bundle = verifyNode(client, 'frameAnalysisNode', '逐帧拉片')
    path = '/app/build/nodes/frameAnalysisNode.umd.js'
    try:
        checksum = run(['docker', 'exec', containerId, 'sha256sum', path])
    except (RuntimeError, subprocess.TimeoutExpired, OSError) as error:
        raise RuntimeError('无法读取候选容器中的逐帧拉片构建包') from error
    match = re.fullmatch(rb'([a-f0-9]{64})  ' + re.escape(path.encode()) + rb'\n', checksum)
    require(match, '候选容器中的逐帧拉片构建包 SHA-256 格式错误')
    digest = hashlib.sha256(bundle).hexdigest()
    require(digest.encode() == match[1],
            '公网逐帧拉片节点 SHA-256 与候选容器构建包不一致')
    return digest


def saveCanvas(client, fresh, workspace, request, required, dedicated=False):
    previous, canvas = snapshot(client, workspace)
    require(not dedicated or canvas.get('deliveryAcceptance') is True, '缺少明确标记的专用验收seed画布')
    canvas['deliveryVerification'] = {key: request[key] for key in required}
    canvas['deliveryVerification']['nonce'] = str(uuid.uuid4())
    content = json.dumps(canvas, ensure_ascii=False, separators=(',', ':')).encode()
    client.request('PUT', '/api/workspaces/files/write',
                   {**fileQuery(workspace), 'expectedRevision': previous['revision'], 'encoding': 'utf-8'}, content, raw=True)
    _, persisted = snapshot(fresh, workspace)
    require(persisted == canvas, '新会话画布保存内容读回不同')


def denyCrossAccount(client, target):
    # 明确要求403；404、跳转、未登录或服务器错误均不能算隔离通过。
    client.request('GET', '/api/workspaces/files/read', {**fileQuery(target), 'snapshot': 'true'}, expected=403)
    client.request('PUT', '/api/workspaces/files/write',
                   {**fileQuery(target), 'expectedRevision': '0' * 64}, b'{}', raw=True, expected=403)


def verifyContainer(config, request, localOrigin):
    current = json.loads(run(['docker', 'inspect', config['container']]))[0]
    metadata = json.loads(run(['docker', 'image', 'inspect', request['image']]))[0]
    require(current['State']['Running'] is True and not current['State']['Restarting']
            and current['Image'] == metadata['Id'], '运行容器不是固定候选')
    require((metadata['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')
            == request['sourceSha'], '候选源码标签不匹配')
    local = urllib.parse.urlsplit(localOrigin)
    require(local.scheme == 'http' and local.hostname in ('127.0.0.1', '::1') and local.port
            and not local.username and not local.password and local.path in ('', '/')
            and not local.query and not local.fragment, '本机候选入口必须是固定HTTP回环端口')
    bindings = current['NetworkSettings'].get('Ports') or {}
    require(any(binding.get('HostPort') == str(local.port)
                and binding.get('HostIp') in ('127.0.0.1', '::1', '0.0.0.0', '::')
                for items in bindings.values() for binding in items or []),
            '本机验收端口未绑定当前候选容器')
    return current['Id']


def verifyPublicCandidate(client, local, request, expectedBoot=None):
    result = client.request('GET', '/api/delivery/identity', {'nonce': str(uuid.uuid4())})
    direct = local.request('GET', '/api/delivery/identity', {'nonce': str(uuid.uuid4())})
    require(isinstance(result, dict) and result.get('sourceSha') == request['sourceSha']
            and result.get('image') == request['image'] and result == direct
            and isinstance(result.get('bootId'), str)
            and re.fullmatch('[a-f0-9-]{36}', result['bootId'])
            and (expectedBoot is None or result['bootId'] == expectedBoot), '公网与本机候选后端身份不匹配或进程变化')
    return result['bootId']


def verifyGeneration(config, request, publicOrigin):
    require(config.get('generationVerifier'), '缺少本候选真实生成任务验收器，禁止晋级')
    program = rootFile(config['generationVerifier'], executable=True)
    receipt = json.loads(run([str(program)], timeout=600, input=json.dumps(request).encode()))
    require(isinstance(receipt, dict) and all(receipt.get(key) == request[key]
            for key in ('environment', 'sourceSha', 'image', 'runId', 'runAttempt'))
            and receipt.get('publicOrigin') == publicOrigin and receipt.get('result') == 'passed'
            and receipt.get('generationVerified') is True, '真实生成任务验收未通过')


def verifyTrim(client, fresh, other, account, config):
    capabilities = client.request('GET', '/api/ffmpeg/trim/capabilities')
    require(capabilities.get('create') is True, '安全截取没有开放新建能力')
    trim = config['trim']
    relativeFile(trim['source'])
    start, end = trim['start'], trim['end']
    require(type(start) in (int, float) and type(end) in (int, float)
            and math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= 120,
            '专用截取时间范围非法')
    operationId = str(uuid.uuid4())
    print('业务验收阶段: 安全截取 operationId=' + operationId, file=sys.stderr)
    payload = {'directory': account['directory'], 'source': trim['source'],
               'start': start, 'end': end, 'operationId': operationId}
    # 不自动重试POST；未知终态保留operationId供运维读回，不调用discard或remove。
    result = client.request('POST', '/api/ffmpeg/trim', body=payload)
    outputPath = 'assets/' + operationId + '/video.mp4'
    require(result.get('nodeId') == operationId and result.get('outputPath') == outputPath
            and type(result.get('duration')) in (int, float)
            and abs(result['duration'] - (end - start)) <= 0.15, '截取结果身份或时长错误')
    status = fresh.request('POST', '/api/ffmpeg/trim/status', body=payload)
    require(status.get('status') == 'ready' and status.get('nodeId') == operationId
            and status.get('outputPath') == outputPath, '新会话未读回持久化截取记录')
    other.request('POST', '/api/ffmpeg/trim/status', body=payload, expected=403)
    query = fileQuery(account, outputPath)
    first = client.request('GET', '/api/workspaces/files/read', query, raw=True, limit=128 * 1024 * 1024)
    second = fresh.request('GET', '/api/workspaces/files/read', query, raw=True, limit=128 * 1024 * 1024)
    require(first and hashlib.sha256(first).digest() == hashlib.sha256(second).digest(), '截取素材刷新读回不同')
    other.request('GET', '/api/workspaces/files/read', query, raw=True, expected=403)
    verifyClip(second, end - start)


def verifyClip(content, expectedDuration):
    # ffprobe只读取本机私密临时副本；TemporaryDirectory只清理该本机副本，不碰线上文件。
    with tempfile.TemporaryDirectory(prefix='aivideoBusiness') as temporary:
        path = Path(temporary) / 'clip.mp4'
        path.write_bytes(content)
        probe = json.loads(run(['ffprobe', '-v', 'error', '-show_entries',
                                'format=duration:stream=codec_type,width,height', '-of', 'json', str(path)]))
    duration = float(probe['format']['duration'])
    require(math.isfinite(duration) and abs(duration - expectedDuration) <= 0.15
            and any(stream.get('codec_type') == 'video' and stream.get('width', 0) > 0
                    and stream.get('height', 0) > 0 for stream in probe['streams']), '持久化视频实测时长或视频流错误')


def verifyShared(client, config, request, required):
    workspace = config['sharedWorkspace']
    require(isinstance(workspace['directory'], str) and PurePosixPath(workspace['directory']).is_absolute(),
            '共享验收工作区必须为已审定绝对路径')
    relativeFile(workspace['canvasPath'])
    # shared由root配置固定；不调用只适用于普通账号或MCP的登录/session接口。
    snapshot(client, workspace)
    fresh = newPublicClient(config)
    verifyNode(fresh, 'mashupNode', '批量混剪')
    saveCanvas(client, fresh, workspace, request, required, dedicated=True)
    status = client.request('GET', '/api/ffmpeg/status')
    require(all(status.get('tools', {}).get(name, {}).get('path')
                and not status['tools'][name].get('error') for name in ('ffmpeg', 'ffprobe')),
            '共享原生FFmpeg工具不可用')
    trim = config['trim']
    source = trim['source']
    if isinstance(source, str) and PurePosixPath(source).is_absolute():
        require('..' not in source.split('/') and '\\' not in source, '共享截取源绝对路径非法')
        try:
            relativeFile(str(PurePosixPath(source).relative_to(PurePosixPath(workspace['directory']))))
        except ValueError:
            raise RuntimeError('共享截取源必须在专用工作区内') from None
    else:
        relativeFile(source)
    start, end = trim['start'], trim['end']
    require(type(start) in (int, float) and type(end) in (int, float)
            and math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= 120,
            '专用截取时间范围非法')
    # 只采用工作区相对源路径和随机新输出路径；没有删除、shell、任意额外参数。
    operationId = str(uuid.uuid4())
    outputPath = 'deliveryClip' + operationId + '.mp4'
    client.request('GET', '/api/workspaces/files/read', fileQuery(workspace, outputPath), raw=True, expected=404)
    print('业务验收阶段: 共享原生截取 requestId=' + operationId, file=sys.stderr)
    payload = {'directory': workspace['directory'], 'requestId': operationId,
               'options': {'source': trim['source'], 'timeout': 180},
               'calls': [{'method': 'seekInput', 'args': [start]},
                         {'method': 'duration', 'args': [end - start]},
                         {'method': 'videoCodec', 'args': ['libx264']},
                         {'method': 'noAudio', 'args': []},
                         {'method': 'outputOptions', 'args': [['-preset ultrafast', '-movflags +faststart']]}],
               'operation': {'method': 'save', 'args': [outputPath]}}
    client.request('POST', '/api/ffmpeg/execute', body=payload, sse=True, limit=4 * 1024 * 1024)
    query = fileQuery(workspace, outputPath)
    first = client.request('GET', '/api/workspaces/files/read', query, raw=True, limit=128 * 1024 * 1024)
    second = newPublicClient(config).request('GET', '/api/workspaces/files/read', query, raw=True, limit=128 * 1024 * 1024)
    require(first and hashlib.sha256(first).digest() == hashlib.sha256(second).digest(), '共享截取素材新会话持久化读回不同')
    verifyClip(second, end - start)
    return fresh


def main():
    require(os.geteuid() == 0, '必须从固定root发布入口运行')
    release = rootJson('/etc/aivideo/release.json')
    raw = sys.stdin.buffer.read(32769)
    require(len(raw) <= 32768, '请求过大')
    request = json.loads(raw)
    required = {'environment', 'sourceSha', 'image', 'runId', 'runAttempt'}
    require(required <= set(request) <= required | {'operation', 'stagingReceipt'}, '请求字段非法')
    origins = {'staging': 'https://toonflow.zenjoymedia.media', 'production': 'https://aivideo.zenithjoy.tech'}
    require(request['environment'] in origins and release['environment'] == request['environment']
            and release['publicOrigin'] == origins[request['environment']], '固定环境或公网入口不匹配')
    require(isinstance(request['sourceSha'], str) and re.fullmatch('[a-f0-9]{40}', request['sourceSha'])
            and isinstance(request['image'], str) and re.fullmatch(
                r'ghcr.io/perfectuser21/zenithjoy-toonflow@sha256:[a-f0-9]{64}', request['image']), '候选版本身份非法')
    require(all(isinstance(request[key], str) and re.fullmatch('[1-9][0-9]{0,19}', request[key])
                for key in ('runId', 'runAttempt')), '发布编号非法')
    config = rootJson(release['businessConfig'], private=True)
    require(config['environment'] == request['environment'] and config['publicOrigin'] == release['publicOrigin'],
            '业务验收配置环境不匹配')
    workspaces = validateBusinessConfig(config)
    mode = config['businessMode']
    accounts = workspaces if mode == 'tenant' else []
    containerId = verifyContainer(release, request, config['localOrigin'])
    local = publicClient(config['localOrigin'].rstrip('/'))
    client = newPublicClient(config)
    bootId = verifyPublicCandidate(client, local, request)
    if mode == 'shared':
        frameNodeDigest = verifySharedFrameNode(client, containerId)
        fresh = verifyShared(client, config, request, required)
        verifyGeneration(config, request, config['publicOrigin'])
        require(verifyContainer(release, request, config['localOrigin']) == containerId, '共享验收期间候选容器变化')
        verifyPublicCandidate(fresh, local, request, bootId)
        require(verifySharedFrameNode(fresh, containerId) == frameNodeDigest, '共享验收期间逐帧拉片构建包变化')
        print(json.dumps({**{key: request[key] for key in required}, 'publicOrigin': config['publicOrigin'],
                          'result': 'passed', 'businessVerified': True, 'runningImage': request['image'],
                          'businessMode': mode, 'generationVerified': True, 'bootId': bootId,
                          'frameAnalysisNodeSha256': frameNodeDigest,
                          'crossAccountIsolationVerified': False}))
        return
    clients = [newPublicClient(config) for _ in accounts]
    for client, account in zip(clients, accounts):
        client.login(account)
        verifyNode(client, 'mashupNode', '批量混剪')
        _, seed = snapshot(client, account)
        require(seed.get('deliveryAcceptance') is True, '账号画布未明确标记为专用验收seed，禁止写入')
    denyCrossAccount(clients[0], accounts[1])
    denyCrossAccount(clients[1], accounts[0])
    for client, account in zip(clients, accounts):
        fresh = newPublicClient(config)
        fresh.login(account)
        saveCanvas(client, fresh, account, request, required, dedicated=True)
    fresh = newPublicClient(config)
    fresh.login(accounts[0])
    verifyTrim(clients[0], fresh, clients[1], accounts[0], config)
    verifyGeneration(config, request, config['publicOrigin'])
    verifyContainer(release, request, config['localOrigin'])
    verifyPublicCandidate(fresh, local, request, bootId)
    print(json.dumps({**{key: request[key] for key in required}, 'publicOrigin': config['publicOrigin'],
                      'result': 'passed', 'businessVerified': True, 'runningImage': request['image'],
                      'businessMode': mode, 'generationVerified': True, 'bootId': bootId,
                      'crossAccountIsolationVerified': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # 仅输出本程序固定诊断；不输出服务器响应、配置、密码或用户文件内容。
        message = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print('业务验收未通过: ' + message, file=sys.stderr)
        sys.exit(1)
