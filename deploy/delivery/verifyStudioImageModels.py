#!/usr/bin/env python3
"""Opt-in Hong Kong staging smoke for two paid image requests using the delivery test accounts."""

from decimal import Decimal
import hashlib
import os
from pathlib import Path
import re
import struct
import time
from uuid import uuid4

from verifyBusiness import newPublicClient, relativeFile, require, rootJson
from verifyGeneration import durableJson, inspectArtifact, verifyGatewayReceipt


def points(value):
    require(isinstance(value,str) and re.fullmatch(r'[0-9]{1,18}(?:\.[0-9]{1,6})?',value), '积分金额精度不合法')
    return Decimal(value)


def read_budget(client,payload,studio,identity):
    before = client.request('GET','/api/multiTenant/user/balance',timeout=20)
    quote_input = {key:value for key,value in payload.items() if key != 'taskId'}
    quote = client.request('POST','/api/ai/media/price',body=quote_input,timeout=30)
    client.request('GET','/api/multiTenant/user/providerKey',expected=403,timeout=20)
    denomination = identity['capabilities'].get('customerPointsPerCny',1000)
    require(denomination in (1,1000), '积分面额不合法')
    limit = points(studio['maxPoints']) * Decimal(denomination) / 1000
    value = points(quote['points'])
    require(quote['price'] == quote['points'] + ' 积分' and 0 < value <= limit, '图片报价不合法或超测试上限')
    require(points(before['balance'])-points(before['reserved']) == points(before['available']) >= value, '账号余额不足或不一致')
    return before,value


def read_settlement(client,before,task_id,quote):
    after = client.request('GET','/api/multiTenant/user/balance',timeout=20)
    matches = [row for row in after['transactions'] if row['id']==task_id]
    require(len(matches)==1 and matches[0]['kind']=='model' and matches[0]['status']=='settled', '找不到唯一已结算的积分流水')
    actual = points(matches[0]['points'])
    require(0 < actual <= quote and points(before['balance']) - points(after['balance']) == actual
            and points(before['reserved']) == points(after['reserved']), '积分结算没有读回一致')
    return str(actual)


def case(client, outsider, config, identity, workspace, model, prompt, reference=None):
    origin = config['publicOrigin']
    directory = workspace['directory']
    task_id = str(uuid4())
    studio = config['studioImageVerification']
    payload = {
        'directory': directory, 'taskId': task_id, 'mediaType':'image', 'providerId':'multiTenant',
        'modelId': model, 'prompt': prompt, 'size':'1K', 'ratio':'1:1', 'outputDirectory':'assets/deliveryStudio26',
    }
    if reference:
        payload['images'] = [reference]
    before, quote = read_budget(client,payload,studio,identity)
    created_at = time.time()
    ledger = Path('/var/lib/aivideoCustomerDelivery/ledger')
    journal = ledger / f'studioImage26-{task_id}.json'
    transaction = {'model': model, 'operation': 'edit' if reference else 'generate', 'taskId': task_id, 'phase':'prepared',
                   'sourceSha':identity['sourceSha'], 'bootId':identity['bootId'], 'createdAt':created_at}
    durableJson(journal, transaction, create=True)
    print(f'已登记香港验收 {model} {task_id}', flush=True)
    submitted = client.request('POST','/api/ai/media/generate',body=payload,timeout=30)
    require(submitted.get('taskId') == task_id, '生成提交回执不匹配')
    transaction.update(phase='submitted')
    durableJson(journal, transaction)
    status_request = {'directory':directory,'taskIds':[task_id],'resume':False,'readOnly':True}
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        current = client.request('GET','/api/delivery/identity')
        require(current['bootId'] == identity['bootId'] and current['sourceSha'] == identity['sourceSha'], '验收期间香港版本变化')
        statuses = client.request('POST','/api/ai/media/tasks/status',body=status_request,timeout=20)
        require(len(statuses) == 1 and statuses[0]['taskId'] == task_id, '任务状态回执不匹配')
        status = statuses[0]
        if status['state'] == 'succeeded':
            break
        require(status['state'] == 'running', f'任务状态为 {status["state"]}')
        time.sleep(6)
    else:
        raise RuntimeError('任务等待超时，保留原任务编号')
    files = status.get('result',{}).get('data')
    require(status['result']['code']==200 and isinstance(files,list) and len(files)==1, '图片产物数量异常')
    file = files[0]
    require(file.get('mimeType') == 'image/png' and file.get('mediaType') == 'image', '产物不是 PNG')
    path = file['path']
    relativeFile(path)
    fresh = newPublicClient(config)
    fresh.login(workspace)
    outsider.request('POST','/api/ai/media/tasks/status',body=status_request,expected=403)
    query = {'directory':directory,'path':path}
    content = client.request('GET','/api/workspaces/files/read',query,raw=True,limit=16*1024*1024)
    persisted = fresh.request('GET','/api/workspaces/files/read',query,raw=True,limit=16*1024*1024)
    require(content == persisted and content[:8] == b'\x89PNG\r\n\x1a\n', '重新登录后 PNG 读回不同')
    require(struct.unpack('>II',content[16:24]) == (1024,1024), 'PNG 尺寸不符')
    inspectArtifact(content,'image',{})
    settled = read_settlement(fresh,before,task_id,quote)
    verifyGatewayReceipt('zenithjoy-aivideo-customer-hk',task_id,created_at,studio['gatewayHost'])
    transaction.update(phase='completed', png={'width':1024,'height':1024,'bytes':len(content),'sha256':hashlib.sha256(content).hexdigest()},
                       gatewayVerified=True, pointsSettled=settled, outsiderDenied=True, rereadAfterSeparateLogin=True)
    durableJson(journal, transaction)
    print(f'完成香港验收 {model} {task_id} {len(content)} bytes', flush=True)
    return {'path':path,'mimeType':file['mimeType']}


def main():
    require(os.geteuid() == 0, '使用香港发布运维身份运行')
    release = rootJson(Path('/etc/aivideo/release.json'),private=True)
    require(release['environment']=='staging' and release['publicOrigin']=='https://aivideo-staging.zenjoymedia.media', '环境不匹配')
    config = rootJson(Path(release['businessConfig']),private=True)
    require(config['environment']=='staging' and config['publicOrigin']==release['publicOrigin'], '验收配置不匹配')
    client, outsider = newPublicClient(config), newPublicClient(config)
    workspace, other_workspace = config['accounts'][1], config['accounts'][0]
    client.login(workspace)
    outsider.login(other_workspace)
    identity = client.request('GET','/api/delivery/identity')
    require(identity['capabilities']['mediaTaskReadOnly'] is True, '服务缺少只读任务状态能力')
    catalog = client.request('GET','/api/ai/media/models')
    public_ids = {row['modelId'] for row in catalog}
    require({'gpt-image-2.5-sunburst','gpt-image-2.6-sunburst','gpt-image-2.6-flare'} <= public_ids, '普通账号未看全图片目录')
    print('香港普通账号能看到 2.5 Sunburst、2.6 Sunburst 与 2.6 Flare', flush=True)
    reference = case(client,outsider,config,identity,workspace,'gpt-image-2.6-flare',
                     'A centered orange circle on a charcoal background, single flat geometric shape, no text.')
    case(client,outsider,config,identity,workspace,'gpt-image-2.6-sunburst',
         'Keep the exact layout of the reference image; change only the central orange circle to sky blue.',reference)


if __name__ == '__main__':
    main()
