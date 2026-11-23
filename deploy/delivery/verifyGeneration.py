#!/usr/bin/env python3
"""真实生成发布验收；只提交一次，不取消、不删除、不自动恢复未知任务。

复用同目录root安装的verifyBusiness.py。businessConfig增加：
generationRequest：generate API扁平请求（directory/mediaType/providerId/modelId/
prompt及该媒体类型已有schema可选项），不允许taskId/nodeId/canvasPath。
directory必须等于首个普通验收账号的工作区。staging必须生成视频。
generationExpected：fileCount（1至4）、timeoutSeconds（1至420）、
pollSeconds（1至30）；video/audio另必填minDuration/maxDuration。
模型及供应商由root配置明确选择，不内置默认模型或假供应商。
香港另要求 studioImageVerification={modelId,gatewayHost,maxPoints}，以第二个专用账号
生成一张测试图，校验积分结算、落盘 PNG 与 Mac Studio 网关回执。

提交前在release.stateDirectory持久化generation-<run>-<attempt>.json；
同一发布编号再次调用一律拒绝，避免未知结果重复扣费。任务ID输出至stderr，
超时/断网/进程变化均保留事务与线上任务，运维必须核对后另行处置。
提交前要求公网及本机身份声明capabilities.mediaTaskReadOnly=true且版本/boot一致。
仅使用readOnly=true、resume=false轮询；旧API没有能力声明则拒绝提交，
避免旧状态入口忽略未知字段后隐式恢复任务。每次轮询先检查同一bootId。
"""
from decimal import Decimal
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
from releasePolicy import imagePattern, publicOrigins, releaseIdentityFields, requireQuotaVolume
from verifyBusiness import (newPublicClient, publicClient, relativeFile, require,
                            rootJson, run, validateBusinessConfig, verifyContainer, verifyPublicCandidate)


def durableJson(path, value, create=False):
    target = path if create else path.with_name(path.name + '.' + str(uuid.uuid4()) + '.pending')
    with open(target, 'x', opener=lambda name, flags: os.open(name, flags, 0o600)) as handle:
        json.dump(value, handle)
        handle.flush()
        os.fsync(handle.fileno())
    if not create:
        os.replace(target, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def inspectArtifact(content, mediaType, expected):
    require(content, '生成产物为空')
    with tempfile.TemporaryDirectory(prefix='aivideoGeneration') as temporary:
        path = Path(temporary) / 'artifact'
        path.write_bytes(content)
        probe = json.loads(run(['ffprobe', '-v', 'error', '-count_frames', '-show_entries',
                                'format=duration,format_name:stream=codec_type,codec_name,width,height,nb_read_frames',
                                '-of', 'json', str(path)], timeout=60))
    streams = probe.get('streams', [])
    videos = [stream for stream in streams if stream.get('codec_type') == 'video']
    audios = [stream for stream in streams if stream.get('codec_type') == 'audio']
    if mediaType in ('image', 'video'):
        require(videos and all(stream.get('width', 0) > 0 and stream.get('height', 0) > 0
                               and int(stream.get('nb_read_frames', '0')) > 0 for stream in videos),
                '生成产物没有可解码的视频或图片帧')
    if mediaType == 'image':
        require(not audios and len(videos) == 1 and int(videos[0]['nb_read_frames']) == 1
                and videos[0].get('codec_name') in ('png', 'mjpeg', 'webp', 'bmp', 'tiff', 'gif', 'av1', 'jpeg2000'),
                '生成产物不是支持的单帧图片')
    else:
        if mediaType == 'audio':
            require(audios and not videos and any(int(stream.get('nb_read_frames', '0')) > 0
                                                  for stream in audios), '生成产物不是可解码音频')
        duration = float(probe.get('format', {}).get('duration', 'nan'))
        require(math.isfinite(duration) and expected['minDuration'] <= duration <= expected['maxDuration'],
                '真实生成产物时长不在审定范围内')


def validateGenerationConfig(config):
    """只读校验生成请求和产物合同；不调用HTTP、不提交任务、不写文件。"""
    require(isinstance(config, dict), '生成验收配置必须为对象')
    require(config.get('environment') in publicOrigins and config.get('businessMode') == 'tenant',
            '生成验收必须使用普通账号tenant模式')
    configured = config.get('generationRequest')
    require(isinstance(configured, dict), '缺少实际生成请求配置')
    payload = dict(configured)
    mediaType = payload.get('mediaType')
    require(mediaType in ('image', 'video', 'audio'), '实际生成媒体类型非法')
    require(config['environment'] != 'staging' or mediaType == 'video', '香港验收必须生成视频')
    common = {'directory', 'mediaType', 'providerId', 'modelId', 'prompt', 'other', 'outputDirectory', 'images'}
    optional = {'image': {'ratio', 'size'},
                'video': {'ratio', 'referenceOrder', 'videos', 'audios', 'firstFrame', 'lastFrame',
                          'resolution', 'duration', 'generateAudio', 'mode'},
                'audio': {'audios', 'voice', 'speed', 'volume', 'pitch', 'language', 'format', 'sampleRate'}}
    require({'directory', 'mediaType', 'providerId', 'modelId', 'prompt'} <= set(payload)
            <= common | optional[mediaType], '生成请求缺字段或包含未授权字段')
    require(isinstance(payload['providerId'], str) and re.fullmatch('[a-z][a-zA-Z0-9]{0,95}', payload['providerId'])
            and isinstance(payload['modelId'], str) and 1 <= len(payload['modelId'].strip()) <= 256
            and isinstance(payload['prompt'], str) and 1 <= len(payload['prompt'].strip()) <= 100000,
            '必须明确配置实际供应商、模型及提示词')
    accounts = config.get('accounts')
    require(isinstance(accounts, list) and len(accounts) == 2, '生成验收缺少固定专用账号')
    workspace = accounts[0]
    require(isinstance(workspace, dict) and isinstance(payload['directory'], str)
            and 1 <= len(payload['directory']) <= 4096 and PurePosixPath(payload['directory']).is_absolute()
            and '..' not in payload['directory'].split('/') and '\\' not in payload['directory']
            and not re.search(r'[\x00-\x1f]', payload['directory'])
            and payload['directory'] == workspace.get('directory'), '生成目录必须为固定专用验收工作区')
    if 'outputDirectory' in payload:
        relativeFile(payload['outputDirectory'])
        require(len(payload['outputDirectory']) <= 2048 and not re.search(r'[:\x00-\x1f]', payload['outputDirectory']),
                '生成输出目录格式非法')
    require('other' not in payload or isinstance(payload['other'], dict), '生成other参数必须为JSON对象')
    try:
        json.dumps(payload, allow_nan=False)
    except (ValueError, TypeError):
        raise RuntimeError('生成请求必须为有限数值的合法JSON') from None
    for key in ('size', 'resolution', 'voice', 'language', 'format'):
        if key in payload:
            maximum = 256 if key == 'voice' else 64
            require(isinstance(payload[key], str) and 1 <= len(payload[key].strip()) <= maximum,
                    '生成文本可选参数格式非法: ' + key)
    if 'ratio' in payload:
        require(isinstance(payload['ratio'], str) and re.fullmatch(r'[1-9]\d{0,3}:[1-9]\d{0,3}', payload['ratio']),
                '生成画幅比例格式非法')
    for key in ('duration', 'speed', 'volume', 'pitch'):
        if key in payload:
            require(type(payload[key]) in (int, float) and math.isfinite(payload[key]), '生成数值参数非法: ' + key)
    require('duration' not in payload or 0 < payload['duration'] <= 3600, '视频生成时长非法')
    require('speed' not in payload or payload['speed'] > 0, '音频生成速度非法')
    require('sampleRate' not in payload or type(payload['sampleRate']) is int and payload['sampleRate'] > 0,
            '音频生成采样率非法')
    require('generateAudio' not in payload or type(payload['generateAudio']) is bool, '生成音轨开关必须为布尔值')
    for key, kind in (('images', 'image'), ('videos', 'video'), ('audios', 'audio'),
                      ('firstFrame', 'image'), ('lastFrame', 'image')):
        if key not in payload:
            continue
        references = [payload[key]] if key in ('firstFrame', 'lastFrame') else payload[key]
        require(isinstance(references, list) and len(references) <= 64, '生成参考媒体数量或格式非法')
        for reference in references:
            require(isinstance(reference, dict) and set(reference) == {'path', 'mimeType'}, '生成参考媒体字段非法')
            relativeFile(reference['path'])
            require(len(reference['path']) <= 2048 and not re.search(r'[:\x00-\x1f]', reference['path'])
                    and isinstance(reference['mimeType'], str)
                    and re.fullmatch(kind + r'/[a-z0-9.+-]+', reference['mimeType'], re.I), '生成参考媒体路径或类型非法')
    if 'mode' in payload:
        value = payload['mode']
        if isinstance(value, str):
            require(value in ('singleImage', 'startEndRequired', 'endFrameOptional', 'startFrameOptional', 'text'),
                    '视频生成模式非法')
        else:
            require(isinstance(value, list) and 1 <= len(value) <= 3 and all(isinstance(item, str)
                    and re.fullmatch(r'(image|video|audio)Reference:([1-9]\d?|1\d{2}|2[0-4]\d|25[0-6])', item)
                    for item in value), '视频参考生成模式非法')
    if 'referenceOrder' in payload:
        order = payload['referenceOrder']
        require(isinstance(order, list) and len(order) <= 256, '视频参考顺序格式非法')
        for reference in order:
            require(isinstance(reference, dict) and reference.get('type') in
                    ('image', 'video', 'audio', 'firstFrame', 'lastFrame', 'text'), '视频参考顺序类型非法')
            if reference['type'] in ('image', 'video', 'audio'):
                require(set(reference) == {'type', 'index'} and type(reference['index']) is int
                        and 0 <= reference['index'] <= 63, '视频参考索引非法')
            else:
                require(set(reference) == {'type'}, '视频参考顺序字段非法')
    expected = config.get('generationExpected')
    require(isinstance(expected, dict) and {'fileCount', 'timeoutSeconds', 'pollSeconds'} <= set(expected),
            '缺少generationExpected真实产物验收配置')
    require(type(expected['fileCount']) is int and 1 <= expected['fileCount'] <= 4
            and type(expected['timeoutSeconds']) is int and 1 <= expected['timeoutSeconds'] <= 420
            and type(expected['pollSeconds']) is int and 1 <= expected['pollSeconds'] <= 30,
            '生成验收文件数或等待时间配置缺失/非法')
    if mediaType != 'image':
        require({'minDuration', 'maxDuration'} <= set(expected)
                and all(type(expected[key]) in (int, float) and math.isfinite(expected[key])
                    for key in ('minDuration', 'maxDuration'))
                and 0 < expected['minDuration'] <= expected['maxDuration'] <= 3600,
                '视频/音频必须配置审定时长范围')
    if config['environment'] == 'staging':
        studio = config.get('studioImageVerification')
        require(isinstance(studio, dict) and set(studio) == {'modelId', 'gatewayHost', 'maxPoints'}
                and studio['modelId'] == 'gpt-image-2.5-sunburst'
                and isinstance(studio['gatewayHost'], str)
                and re.fullmatch(r'[a-z0-9-]+\.[a-z0-9-]+\.ts\.net', studio['gatewayHost'])
                and asPoints(studio['maxPoints']) > 0,
                '香港缺少固定 Mac Studio 图片模型、私网目标或积分上限')
    return payload, expected, workspace


def asPoints(value):
    require(isinstance(value, str) and re.fullmatch(r'[0-9]{1,18}(?:\.[0-9]{1,3})?', value),
            '客户积分钱包或报价金额格式非法')
    return Decimal(value)


def readPoints(client):
    result = client.request('GET', '/api/multiTenant/user/balance', timeout=20)
    require(isinstance(result, dict) and set(result) == {'balance', 'reserved', 'available', 'transactions'}
            and isinstance(result['transactions'], list), '客户积分钱包未开放或返回了内部字段')
    for key in ('balance', 'reserved', 'available'):
        asPoints(result[key])
    for row in result['transactions']:
        require(isinstance(row, dict) and set(row) == {'id', 'kind', 'status', 'points', 'createdAt'},
                '客户积分流水包含非公开字段')
        asPoints(row['points'])
    require(asPoints(result['balance']) - asPoints(result['reserved']) == asPoints(result['available']),
            '客户积分余额与预占不一致')
    return result


def readGenerationQuote(client, payload):
    reply = client.request('POST', '/api/ai/media/price', body=payload, timeout=30)
    require(isinstance(reply, dict) and set(reply) == {'points', 'price', 'tips'}
            and reply['price'] == reply['points'] + ' 积分', '客户生成报价未以积分公开')
    points = asPoints(reply['points'])
    require(points > 0, '发布验收必须使用真实计费的模型')
    return points


def verifyPointsBudget(client, payload, studio=None):
    client.request('GET', '/api/multiTenant/user/providerKey', expected=403, timeout=20)
    startingPoints = readPoints(client)
    quote = readGenerationQuote(client, payload)
    require(not studio or quote <= asPoints(studio['maxPoints']), 'Mac Studio 验收报价超出积分上限')
    require(asPoints(startingPoints['available']) >= quote, '专用发布验收账号积分低于本次报价')
    return startingPoints, quote


def studioGenerationCase(config):
    studio = config['studioImageVerification']
    workspace = config['accounts'][1]
    payload = {'directory': workspace['directory'], 'mediaType': 'image', 'providerId': 'multiTenant',
               'modelId': studio['modelId'], 'prompt': 'A blue glass cube on white, no people or text',
               'size': '1K', 'ratio': '1:1', 'outputDirectory': 'assets/deliveryStudio'}
    return payload, {'fileCount': 1, 'timeoutSeconds': 210, 'pollSeconds': 5}, workspace


def verifyPointsSettlement(before, after, taskId, quote):
    matches = [row for row in after['transactions'] if row['id'] == taskId]
    require(len(matches) == 1 and matches[0]['kind'] == 'model' and matches[0]['status'] == 'settled',
            '本次生成没有唯一已结算的客户积分流水')
    actual = asPoints(matches[0]['points'])
    require(0 < actual <= quote and asPoints(before['balance']) - asPoints(after['balance']) == actual
            and before['reserved'] == after['reserved'], '本次实际积分扣款、余额或预占读回不一致')


def verifyGatewayReceipt(container, taskId, createdAt, gatewayHost):
    result = subprocess.run(['docker', 'logs', '--since', str(int(createdAt)), container],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            timeout=20, check=True, text=True)
    matches = []
    for line in result.stdout.splitlines():
        if not line.startswith('{') or taskId not in line or 'canvasOpenaiImageGateway' not in line:
            continue
        event = json.loads(line)
        if event.get('event') == 'canvasOpenaiImageGateway' and event.get('taskId') == taskId:
            matches.append(event)
    require(len(matches) == 1 and matches[0].get('status') == 200
            and matches[0].get('gatewayHost') == gatewayHost
            and re.fullmatch(r'req_[A-Za-z0-9_-]{1,120}', matches[0].get('upstreamRequestId') or '')
            and re.fullmatch(r'[a-f0-9-]{36}', matches[0].get('requestId') or ''),
            '未读回同一真实图片任务的 Mac Studio 目标和 OpenAI 回执')


def main():
    require(os.geteuid() == 0, '必须由固定root生成验收入口运行')
    release = rootJson('/etc/aivideo/release.json')
    raw = sys.stdin.buffer.read(32769)
    require(len(raw) <= 32768, '请求过大')
    request = json.loads(raw)
    fields = set(releaseIdentityFields)
    require(fields <= set(request) <= fields | {'operation', 'stagingReceipt'}, '生成验收版本请求字段非法')
    require(request['environment'] in publicOrigins and request['environment'] == release['environment']
            and release['publicOrigin'] == publicOrigins[request['environment']], '生成验收环境或公网入口不匹配')
    requireQuotaVolume(release)
    require(isinstance(request['sourceSha'], str) and re.fullmatch('[a-f0-9]{40}', request['sourceSha'])
            and isinstance(request['image'], str) and re.fullmatch(imagePattern, request['image']), '生成验收候选非法')
    require(all(isinstance(request[key], str) and re.fullmatch('[1-9][0-9]{0,19}', request[key])
                for key in ('runId', 'runAttempt')), '生成验收发布编号非法')
    config = rootJson(release['businessConfig'], private=True)
    require(config['environment'] == request['environment'] and config['publicOrigin'] == release['publicOrigin'],
            '生成验收配置不属于本环境')
    validateBusinessConfig(config)
    payload, expected, workspace = validateGenerationConfig(config)
    verifyContainer(release, request, config['localOrigin'])
    client = newPublicClient(config)
    local = publicClient(config['localOrigin'].rstrip('/'))
    bootId = verifyPublicCandidate(client, local, request)
    publicIdentity = client.request('GET', '/api/delivery/identity', {'nonce': str(uuid.uuid4())})
    localIdentity = local.request('GET', '/api/delivery/identity', {'nonce': str(uuid.uuid4())})
    require(publicIdentity == localIdentity and isinstance(publicIdentity, dict)
            and publicIdentity.get('sourceSha') == request['sourceSha']
            and publicIdentity.get('image') == request['image'] and publicIdentity.get('bootId') == bootId
            and isinstance(publicIdentity.get('capabilities'), dict)
            and publicIdentity['capabilities'].get('mediaTaskReadOnly') is True,
            '公网/本机候选缺少真实只读任务状态能力，拒绝提交生成')
    checkPoints = request['environment'] == 'staging'
    receipt = verifyGenerationCase(config, release, request, bootId, (payload, expected, workspace), checkPoints)
    if checkPoints:
        studioReceipt = verifyGenerationCase(config, release, request, bootId,
                                             studioGenerationCase(config), True, studio=config['studioImageVerification'])
        require(studioReceipt.get('studioImageGatewayVerified') is True, 'Mac Studio 出图验收缺失')
        receipt['studioImageGatewayVerified'] = True
    print(json.dumps(receipt))


def verifyGenerationCase(config, release, request, bootId, case, checkPoints, studio=None):
    payload, expected, workspace = case
    mediaType = payload['mediaType']
    client = newPublicClient(config)
    local = publicClient(config['localOrigin'].rstrip('/'))
    verifyPublicCandidate(client, local, request, bootId)
    client.login(workspace)
    other = newPublicClient(config)
    other.login(next(account for account in config['accounts'] if account['userId'] != workspace['userId']))
    if checkPoints:
        startingPoints, quote = verifyPointsBudget(client, payload, studio)
    # root账本与主发布事务共用受保护目录；原子独占创建杜绝相同run再次提交。
    state = Path(release['stateDirectory'])
    identity = rootJson(state / 'identity.json')
    require(identity['environment'] == request['environment'], '生成事务账本环境不匹配')
    require(state.stat().st_mode & 0o077 == 0, '生成事务目录必须为root私有')
    taskId = str(uuid.uuid4())
    payload['taskId'] = taskId
    journalPrefix = 'studioImageGeneration-' if studio else 'generation-'
    journal = state / (journalPrefix + request['runId'] + '-' + request['runAttempt'] + '.json')
    transaction = {'request': {key: request[key] for key in releaseIdentityFields}, 'publicOrigin': config['publicOrigin'],
                   'taskId': taskId, 'bootId': bootId, 'phase': 'prepared', 'createdAt': time.time(),
                   'requestSha256': hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()}
    durableJson(journal, transaction, create=True)
    print('生成验收已占位 taskId=' + taskId, file=sys.stderr)
    # 不重试此POST。断线、超时或异常时prepared仍可能代表已提交，禁止再造任务。
    submitted = client.request('POST', '/api/ai/media/generate', body=payload)
    require(isinstance(submitted, dict) and submitted.get('taskId') == taskId, '生成提交回执身份不匹配，结果待核对')
    transaction.update(phase='submitted', submittedAt=time.time())
    durableJson(journal, transaction)
    deadline = time.monotonic() + expected['timeoutSeconds']
    statusRequest = {'directory': payload['directory'], 'taskIds': [taskId],
                     'resume': False, 'readOnly': True}
    while True:
        require(time.monotonic() < deadline, '生成等待超时，保留原taskId待核对')
        verifyContainer(release, request, config['localOrigin'])
        verifyPublicCandidate(client, local, request, bootId)
        statuses = client.request('POST', '/api/ai/media/tasks/status', body=statusRequest)
        require(isinstance(statuses, list) and len(statuses) == 1 and statuses[0].get('taskId') == taskId,
                '生成状态回执身份不匹配')
        status = statuses[0]
        require(status.get('state') in ('running', 'succeeded'), '生成任务失败、取消或中断，保留taskId待核对')
        if status['state'] == 'succeeded':
            break
        time.sleep(min(expected['pollSeconds'], max(0, deadline - time.monotonic())))
    result = status.get('result') or {}
    files = result.get('data')
    require(result.get('code') == 200 and isinstance(files, list) and len(files) == expected['fileCount'],
            '生成任务未返回审定数量的成功产物')
    transaction.update(phase='generated', generatedAt=time.time())
    durableJson(journal, transaction)
    fresh = newPublicClient(config)
    fresh.login(workspace)
    other.request('POST', '/api/ai/media/tasks/status', body=statusRequest, expected=403)
    artifacts = []
    for file in files:
        require(isinstance(file, dict) and file.get('mediaType') == mediaType
                and isinstance(file.get('mimeType'), str) and file['mimeType'].startswith(mediaType + '/'),
                '生成产物声明类型不匹配')
        relativeFile(file['path'])
        query = {'directory': payload['directory'], 'path': file['path']}
        content = client.request('GET', '/api/workspaces/files/read', query, raw=True, limit=128 * 1024 * 1024)
        persisted = fresh.request('GET', '/api/workspaces/files/read', query, raw=True, limit=128 * 1024 * 1024)
        digest = hashlib.sha256(content).hexdigest()
        require(content and digest == hashlib.sha256(persisted).hexdigest(), '新会话生成产物持久化读回不同')
        other.request('GET', '/api/workspaces/files/read', query, raw=True, expected=403)
        inspectArtifact(persisted, mediaType, expected)
        artifacts.append({'sha256': digest, 'bytes': len(content), 'mediaType': mediaType})
    verifyContainer(release, request, config['localOrigin'])
    verifyPublicCandidate(fresh, local, request, bootId)
    if checkPoints:
        verifyPointsSettlement(startingPoints, readPoints(fresh), taskId, quote)
    receipt = {**{key: request[key] for key in releaseIdentityFields}, 'publicOrigin': config['publicOrigin'],
               'result': 'passed', 'generationVerified': True, 'taskId': taskId,
               'businessMode': 'tenant', 'generationMediaType': mediaType, 'bootId': bootId, 'artifacts': artifacts}
    if checkPoints:
        receipt['customerPointsSettled'] = True
    if studio:
        verifyGatewayReceipt(release['container'], taskId, transaction['createdAt'], studio['gatewayHost'])
        receipt['studioImageGatewayVerified'] = True
    transaction.update(phase='completed', receipt=receipt, completedAt=time.time())
    durableJson(journal, transaction)
    return receipt


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print('真实生成验收未通过: ' + message + '；如已占位请先核对原事务与taskId。', file=sys.stderr)
        sys.exit(1)
