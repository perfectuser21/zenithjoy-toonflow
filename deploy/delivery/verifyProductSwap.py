#!/usr/bin/env python3
"""读回从普通账号画布提交并完成的一键换品。此程序不提交或恢复生成任务。"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import uuid

from releasePolicy import publicOrigins
from verifyBusiness import newPublicClient, relativeFile, require, rootJson, run, snapshot, validateBusinessConfig, verifyNode


def savedSwap(canvas, jobId):
    matches = []
    for node in canvas['nodes']:
        if node.get('type') != 'remote-frameAnalysisNode':
            continue
        state = node.get('data', {}).get('guidedRemake') or {}
        job = state.get('job') or {}
        if job.get('id') == jobId:
            matches.append((state, job))
    require(len(matches) == 1, '专用画布必须包含一个匹配的换品任务')
    state, job = matches[0]
    reference = (state.get('productSwap') or {}).get('reference') or {}
    require(job.get('phase') == 'completed' and reference.get('mimeType', '').startswith('image/'),
            '换品任务未完成或缺少新商品参考图')
    for path in (state.get('source'), job.get('result'), reference.get('path')):
        relativeFile(path)
    duration = state['analysis']['duration']
    require(type(duration) in (float, int) and math.isfinite(duration) and 0 < duration <= 120,
            '原片分析时长无效')
    outputs = [node for node in canvas['nodes'] if node.get('id') == job.get('outputId')]
    require(len(outputs) == 1 and outputs[0].get('type') == 'remote-videoNode', '画布缺少换品输出节点')
    output = outputs[0].get('data', {})
    video = output.get('outputs', {}).get('video', {}).get('value', {})
    require(output.get('label') == '换品成片' and video.get('url') == job['result']
            and video.get('mimeType') == 'video/mp4', '换品输出节点未引用生成的成片')
    require(state['source'] != job['result'], '成片引用了原视频')
    return state['source'], job['result'], duration


def verifyVideoTimeline(original, result, duration):
    def probe(path):
        streams = json.loads(run(['ffprobe', '-v', 'error', '-show_entries',
                                  'stream=codec_type,duration,nb_frames', '-of', 'json', str(path)]))['streams']
        video = next((stream for stream in streams if stream['codec_type'] == 'video'), None)
        require(video is not None and video.get('nb_frames', '').isdigit(), 'MP4 缺少可核验的视频帧')
        return float(video['duration']), video['nb_frames'], any(s['codec_type'] == 'audio' for s in streams)

    def audioHash(path):
        return run(['ffmpeg', '-v', 'error', '-i', str(path), '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-'])

    with tempfile.TemporaryDirectory(prefix='toonflowProductSwap') as temporary:
        paths = [Path(temporary) / name for name in ('original.mp4', 'result.mp4')]
        for path, content in zip(paths, (original, result)):
            path.write_bytes(content)
        sourceInfo, resultInfo = map(probe, paths)
        require(abs(resultInfo[0] - duration) <= 0.15 and abs(sourceInfo[0] - resultInfo[0]) <= 0.05
                and sourceInfo[1:] == resultInfo[1:], '成片时长、视频帧数或音轨与原片不一致')
        if sourceInfo[2]:
            require(audioHash(paths[0]) == audioHash(paths[1]), '成片原音轨读回不一致')


def verifySavedSwap(canvas, freshCanvas, jobId, read):
    source, result, duration = savedSwap(canvas, jobId)
    require((source, result, duration) == savedSwap(freshCanvas, jobId), '重新登录后画布读回不一致')
    original, output = read(0, source), read(0, result)
    require(output != original and output == read(1, result), '换品成片与原视频相同或重新登录后读回不一致')
    read(2, result, 403)
    verifyVideoTimeline(original, output, duration)
    return {'jobId': jobId, 'sha256': hashlib.sha256(output).hexdigest(), 'bytes': len(output),
            'outputNodeReadback': True, 'anotherAccountDenied': True, 'videoTimelineAndAudioVerified': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--boot-id', required=True, type=uuid.UUID)
    parser.add_argument('--job-id', required=True, type=uuid.UUID)
    args = parser.parse_args()
    require(os.geteuid() == 0 and re.fullmatch('[a-f0-9]{40}', args.source_sha), '必须在发布主机使用固定候选版本')
    release = rootJson('/etc/aivideo/release.json')
    environment = release['environment']
    config = rootJson(release['businessConfig'], private=True)
    require(environment in publicOrigins and config['environment'] == environment
            and release['publicOrigin'] == config['publicOrigin'] == publicOrigins[environment], '固定发布环境不匹配')
    accounts = validateBusinessConfig(config)
    clients = [newPublicClient(config) for _ in range(3)]
    for client, account in zip(clients, (accounts[0], accounts[0], accounts[1])):
        client.login(account)

    def verifyIdentity():
        live = clients[0].request('GET', '/api/delivery/identity')
        require(live['sourceSha'] == args.source_sha and live['bootId'] == str(args.boot_id),
                '候选版本或启动编号变化')
        return live

    live = verifyIdentity()
    bundle = verifyNode(clients[0], 'frameAnalysisNode', '逐帧拉片')
    require('一键换品'.encode() in bundle, '本候选的逐帧拉片节点未提供一键换品')
    first, fresh = (snapshot(client, accounts[0])[1] for client in clients[:2])
    require(first.get('deliveryAcceptance') is True and fresh.get('deliveryAcceptance') is True, '需要专用验收画布')

    def read(client, path, expected=200):
        return clients[client].request('GET', '/api/workspaces/files/read',
                                       {'directory': accounts[0]['directory'], 'path': path},
                                       expected=expected, raw=True, limit=64 * 1024 * 1024)

    receipt = verifySavedSwap(first, fresh, str(args.job_id), read)
    verifyIdentity()
    print(json.dumps({**receipt, 'environment': environment, 'sourceSha': args.source_sha, 'bootId': live['bootId'],
                      'frameAnalysisNodeSha256': hashlib.sha256(bundle).hexdigest()}))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, TypeError) as error:
        reason = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print('换品成片读回未通过: ' + reason, file=sys.stderr)
        sys.exit(1)
