#!/usr/bin/env python3
"""受限发布入口。配置与调用的验收程序均由 root 安装，CI 只传版本身份。"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
from imageTransfer import ensureImage, errorClass, validateCosTransfer, validateCosIdentity
from productionCandidate import verifyProductionCandidate
from releasePolicy import generationProfile, imagePattern, publicOrigins, publicReceipt, releaseIdentityFields, requireQuotaVolume, validateReceipt
from verifyBusiness import (newPublicClient, publicClient, rootJson, validateBusinessConfig,
                            verifyContainer, verifyPublicCandidate, localClient)
from verifyGeneration import studioGenerationCase, validateGenerationConfig

configPath = Path('/etc/aivideo/release.json')
diagnosticPath = None
diagnosticPhase = 'preflight'


def recordTopFailure(error):
    if diagnosticPath is None:
        return
    safeMessages = {'镜像传输超时', '镜像归档超容量', '镜像导出或中继失败',
                    '镜像加载失败', '镜像拉取失败', '镜像完整内容拉取失败',
                    '镜像传输空间不足', 'OCI blob类型不许可', '存在未处理的镜像传输诊断'}
    message = str(error) if isinstance(error, RuntimeError) and str(error) in safeMessages else None
    fd, name = tempfile.mkstemp(prefix=diagnosticPath.stem + '-top-', suffix='.json', dir=diagnosticPath.parent)
    path = Path(name)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        json.dump({'phase':diagnosticPhase, 'errorClass':errorClass(error), 'message':message}, handle)
        handle.flush()
        os.fsync(handle.fileno())
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def rootFile(path, executable=False):
    path = Path(path)
    require(path.is_absolute(), '配置路径必须为绝对路径')
    for parent in [path, *path.parents]:
        info = parent.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                '控制文件或父目录权限不安全')
    require(path.is_file(), '控制文件不存在')
    if executable:
        require(os.access(path, os.X_OK), '控制程序不可执行')
    return str(path)


def run(args, timeout=120, input=None):
    try:
        result = subprocess.run(args, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=timeout, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
    except subprocess.TimeoutExpired as error:
        if diagnosticPath is not None:
            def text(value):
                return value.decode('utf-8', errors='replace') if isinstance(value, bytes) else value or ''
            atomicJson(diagnosticPath, {'command': Path(args[0]).name, 'timedOut': True,
                                       'stdout': text(error.stdout)[-1048576:],
                                       'stderr': text(error.stderr)[-1048576:]})
        raise RuntimeError('子操作超时: ' + Path(args[0]).name) from None
    if result.returncode != 0:
        if diagnosticPath is not None:
            # 只写root发布账本，不把供应商响应、配置或子进程stderr输出至CI。
            atomicJson(diagnosticPath, {'command': Path(args[0]).name,
                                       'exit': result.returncode,
                                       'stdout': result.stdout[-1048576:],
                                       'stderr': result.stderr[-1048576:]})
        raise RuntimeError('子操作失败: ' + Path(args[0]).name)
    return result.stdout


def atomicJson(path, value):
    temporary = path.with_suffix('.pending')
    with open(temporary, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as handle:
        json.dump(value, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def imageId(image):
    return json.loads(run(['docker', 'image', 'inspect', image]))[0]['Id']


def verifyTransaction(config, request, transaction, journal):
    rootFile(config['businessVerifier'], executable=True)
    backup = transaction['backup']
    require(backup.get('backupVerified') is True and backup.get('restoreVerified') is True
            and backup.get('quotaRestoreVerified') is True and backup.get('backupId'), '本事务缺少已验证的配额卷备份')
    running = inspect(config['container'])
    require(running['State']['Running'] and running['Image'] == imageId(request['image']), '待验收候选已改变')
    profile = generationProfile(rootJson(config['businessConfig'], private=True))
    receipt = json.loads(run([config['businessVerifier']], input=json.dumps(request), timeout=1200))
    receipt.update(backupVerified=True, restoreVerified=True, quotaRestoreVerified=True,
                   backupId=backup['backupId'], predecessorImage=transaction['predecessorImage'],
                   transfer=transaction['transfer'], generationProfile=profile)
    validateReceipt(receipt, request, request['environment'])
    final = inspect(config['container'])
    require(final['State']['Running'] and final['Image'] == imageId(request['image']), '验收后容器停止或运行镜像改变')
    transaction.update(phase='completed', receipt=receipt)
    atomicJson(journal, transaction)
    print(json.dumps(publicReceipt(receipt)))


def resolvedTransaction(state, journal, environment):
    transaction = json.loads(journal.read_text())
    if transaction.get('phase') == 'completed':
        return True
    if environment != 'staging' or transaction.get('phase') != 'verifying':
        return False
    marker = state / ('rejected-' + journal.name)
    if not marker.exists():
        return False
    rejection = rootJson(marker, private=True)
    return (rejection.get('transactionSha256') == hashlib.sha256(journal.read_bytes()).hexdigest()
            and rejection.get('result') == 'verificationRejected'
            and rejection.get('environment') == 'staging'
            and 'receipt' not in transaction)


def rejectStagingVerification(key):
    # This operation is available only through the root operator CLI. The restricted
    # release and witness wrappers accept no arguments and do not route stdin here.
    require(os.geteuid() == 0 and re.fullmatch(r'[1-9][0-9]{0,19}-[1-9][0-9]{0,19}', key),
            '只能显式核销一笔香港测试发布')
    config = rootJson(configPath)
    require(config['environment'] == 'staging' and config['publicOrigin'] == publicOrigins['staging'], '只支持香港测试服')
    state = Path(config['stateDirectory'])
    require(rootJson(state / 'identity.json')['environment'] == 'staging', '发布账本身份不匹配')
    with (state / 'release.lock').open('rb') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        journal = state / (key + '.json')
        transaction = rootJson(journal, private=True)
        request = transaction['request']
        require(transaction.get('phase') == 'verifying' and 'receipt' not in transaction
                and request.get('environment') == 'staging'
                and key == request['runId'] + '-' + request['runAttempt'], '仅核销尚未通过验收的指定事务')
        marker = state / ('rejected-' + journal.name)
        require(not marker.exists() and not marker.is_symlink(), '验收失败已登记')
        failure = rootJson(state / ('diagnostic-' + key + '.json'), private=True)
        require(failure.get('exit') == 1, '缺少原验收失败证据')
        backup = transaction['backup']
        require(all(backup.get(field) is True for field in ('backupVerified', 'restoreVerified', 'quotaRestoreVerified'))
                and re.fullmatch(r'[0-9]{19}', backup['backupId']), '缺少原事务回滚证据')
        backupFolder = Path(config['backupDirectory']) / backup['backupId']
        rootFile(backupFolder / 'capsule.ext4')
        receipt = rootJson(backupFolder / 'receipt.json', private=True)
        require(receipt.get('backupId') == backup['backupId']
                and all(receipt.get(field) is True for field in ('backupVerified', 'restoreVerified', 'quotaRestoreVerified')),
                '原事务回滚证据不一致')
        business = rootJson(config['businessConfig'], private=True)
        require(business.get('environment') == 'staging' and business.get('publicOrigin') == config['publicOrigin'], '业务配置不属于香港测试服')
        validateBusinessConfig(business)
        payload, _, account = validateGenerationConfig(business)
        studioPayload, _, studioAccount = studioGenerationCase(business)
        verifyContainer(config, request, business['localOrigin'])
        bootId = verifyPublicCandidate(newPublicClient(business), localClient(business), request)
        cases = [('generation-', payload, account), ('studioImageGeneration-', studioPayload, studioAccount)]
        outcomes = []
        for prefix, modelRequest, owner in cases:
            job = rootJson(state / (prefix + key + '.json'), private=True)
            taskId = job.get('taskId', '')
            hashed = hashlib.sha256(json.dumps({**modelRequest, 'taskId': taskId}, sort_keys=True).encode()).hexdigest()
            require(job.get('request') == {field: request[field] for field in releaseIdentityFields}
                    and job.get('bootId') == bootId and job.get('publicOrigin') == config['publicOrigin']
                    and job.get('phase') in ('generated', 'completed')
                    and job.get('requestSha256') == hashed and re.fullmatch(r'[a-f0-9-]{36}', taskId),
                    '原模型任务身份或阶段无法核对')
            client = newPublicClient(business)
            client.login(owner)
            status = client.request('POST', '/api/ai/media/tasks/status',
                                    body={'directory': modelRequest['directory'], 'taskIds': [taskId],
                                          'resume': False, 'readOnly': True})
            require(isinstance(status, list) and len(status) == 1 and status[0].get('taskId') == taskId
                    and status[0].get('state') == 'succeeded', '原模型任务尚无确定终态')
            outcomes.append({'case': prefix.rstrip('-'), 'taskId': taskId, 'state': 'succeeded'})
        verifyContainer(config, request, business['localOrigin'])
        verifyPublicCandidate(newPublicClient(business), localClient(business), request, bootId)
        rejection = {'result': 'verificationRejected', 'environment': 'staging',
                     'transactionSha256': hashlib.sha256(journal.read_bytes()).hexdigest(),
                     'rejectedAt': time.time(), 'backupId': backup['backupId'], 'tasks': outcomes}
        atomicJson(marker, rejection)
        require(resolvedTransaction(state, journal, 'staging'), '验收失败记录读回不一致')
        print(json.dumps({'run': key, 'result': rejection['result'], 'terminalModelTasks': len(outcomes)}))


def main():
    global diagnosticPath, diagnosticPhase
    require(os.geteuid() == 0, '必须通过受限 sudo 入口运行')
    rootFile(configPath)
    config = json.loads(configPath.read_text())
    raw = sys.stdin.buffer.read(32769)
    require(len(raw) <= 32768, '请求过大')
    request = json.loads(raw)
    transfer = request.pop('transfer', None)
    required = set(releaseIdentityFields)
    require(set(request) <= required | {'stagingReceipt', 'operation'} and required <= set(request), '请求字段不合法')
    require(request['environment'] in publicOrigins and request['environment'] == config['environment'], '主机环境不匹配')
    requireQuotaVolume(config)
    require(config.get('publicOrigin') == publicOrigins[request['environment']], '主机发布入口配置不匹配')
    require(re.fullmatch(r'[a-f0-9]{40}', request['sourceSha']) is not None, '源码版本不合法')
    require(re.fullmatch(imagePattern, request['image']) is not None, '镜像必须为固定 digest')
    for key in ('runId', 'runAttempt'):
        require(isinstance(request[key], str) and re.fullmatch(r'[1-9][0-9]{0,19}', request[key]) is not None, '发布编号不合法')
    operation = request.get('operation', 'deploy')
    require(operation in ('preflight', 'deploy', 'receipt', 'verify'), '操作不合法')
    if operation == 'deploy':
        validateCosTransfer(config, request, transfer)
        transferIdentity = {key:transfer[key] for key in ('key','sha256','bytes')}
    else:
        require(transfer is None, '非发布操作不接受COS签名')
        transferIdentity = None
        if operation == 'preflight' and request['environment'] == 'production':
            stage = request.get('stagingReceipt')
            require(isinstance(stage, dict), '缺少香港验收回执')
            transferIdentity = stage.get('transfer')
            validateCosIdentity(config, request, transferIdentity)
    state = Path(config['stateDirectory'])
    require(state.is_dir(), '发布账本目录不存在')
    rootFile(state / 'identity.json')
    identity = json.loads((state / 'identity.json').read_text())
    require(identity['environment'] == request['environment'], '部署账本身份不匹配')
    with open(state / 'release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        key = request['runId'] + '-' + request['runAttempt']
        diagnosticPath = state / ('diagnostic-' + key + '.json')
        journal = state / (key + '.json')
        require(not any(not resolvedTransaction(state, p, request['environment'])
                        and not (operation == 'verify' and p == journal and not (state / ('rejected-' + p.name)).exists())
                        for p in state.glob('[0-9]*-[0-9]*.json')), '有尚未结束的发布事务')
        if journal.exists():
            previous = json.loads(journal.read_text())
            if operation == 'verify':
                require(not (state / ('rejected-' + journal.name)).exists(), '已核销的验收禁止重放')
                diagnosticPath = state / ('diagnostic-' + key + '-' + str(time.time_ns()) + '.json')
                require(previous.get('phase') == 'verifying', '仅能继续已完成切换的验收阶段')
                require({k:v for k,v in previous['request'].items() if k != 'operation'}
                        == {k:v for k,v in request.items() if k != 'operation'}, '继续验收的版本身份发生变化')
                generation = state / ('generation-' + key + '.json')
                require(not generation.exists() and not generation.is_symlink(), '已占位生成任务；禁止再次提交模型验收')
                if request['environment'] == 'production':
                    validateReceipt(request.get('stagingReceipt', {}), request, 'staging')
                    witness = rootFile(config['stagingWitness'], executable=True)
                    authoritative = json.loads(run([witness], input=json.dumps(request)))
                    validateReceipt(authoritative, request, 'staging')
                    require(authoritative['transfer'] == previous['transfer'], 'COS对象身份不匹配')
                    require(publicReceipt(authoritative) == publicReceipt(request['stagingReceipt']), '香港回执与只读见证不一致')
                previous['verificationResumedAt'] = time.time()
                atomicJson(journal, previous)
                verifyTransaction(config, request, previous, journal)
                return
            if operation == 'receipt':
                for field in required:
                    require(previous['request'][field] == request[field], '历史回执身份不匹配')
            else:
                require(previous['request'] == request, '相同发布编号的请求发生变化')
                require(previous.get('transfer') == transferIdentity, '相同发布编号的COS对象发生变化')
            require(previous.get('phase') == 'completed', '上次发布结果未知，需要读取事务后人工处理')
            receipt = previous['receipt']
            validateReceipt(receipt, request, request['environment'])
            if operation == 'receipt' and request['environment'] == 'staging':
                business = rootJson(config['businessConfig'], private=True)
                require(business.get('environment') == 'staging' and business.get('publicOrigin') == publicOrigins['staging']
                        and business.get('businessMode') == 'tenant', '香港见证配置与当前客户服务不一致')
                verifyContainer(config, request, business['localOrigin'])
                local = publicClient(business['localOrigin'].rstrip('/'))
                verifyPublicCandidate(newPublicClient(business), local, request, receipt['bootId'], timeout=10)
            else:
                running = inspect(config['container'])
                require(running['State']['Running'] and running['Image'] == imageId(request['image']), '历史回执与当前运行版本不一致')
            print(json.dumps(publicReceipt(receipt)))
            return
        require(operation not in ('receipt', 'verify'), '对应发布事务不存在')
        business = rootJson(config['businessConfig'], private=True)
        require(business.get('environment') == request['environment'] and business.get('publicOrigin') == config['publicOrigin'],
                '业务验收配置不属于本环境')
        validateBusinessConfig(business)
        validateGenerationConfig(business)
        # 配额 helper 是宿主组件，不随应用镜像隐式升级。
        helper = Path(rootFile(config['quotaHelper']))
        require(hashlib.sha256(helper.read_bytes()).hexdigest() == config['quotaHelperSha256'], '配额 helper 版本变化')
        rootFile(config['businessVerifier'], executable=True)
        rootFile(config['backupCommand'], executable=True)
        rootFile(config['restoreVerifier'], executable=True)
        rootFile(config['switchCommand'], executable=True)
        rootFile(config['readinessCommand'], executable=True)
        current = inspect(config['container'])
        require(current['State']['Running'] is True, '当前应用未运行')
        run(['mountpoint', '-q', config['dataDirectory']])
        if request['environment'] == 'production':
            validateReceipt(request.get('stagingReceipt', {}), request, 'staging')
            require(request['stagingReceipt'].get('transfer') == transferIdentity, 'COS对象身份不匹配')
            # 独立取回香港的可信验收回执；不信任 CI 传入的 passed 声明。
            witness = rootFile(config['stagingWitness'], executable=True)
            authoritative = json.loads(run([witness], input=json.dumps(request)))
            validateReceipt(authoritative, request, 'staging')
            require(publicReceipt(authoritative) == publicReceipt(request['stagingReceipt']), '香港回执与只读见证不一致')
        execution = run(['systemctl', 'show', config['service'], '--property=ExecStart', '--value'])
        require('/usr/bin/docker start -a ' + config['container'] in execution, '服务尚未接入固定容器启动模式')
        # preflight 无拉取、停机、创建事务或写入业务数据。
        if operation == 'preflight':
            preflight = {'environment':request['environment'], 'sourceSha':request['sourceSha'],
                         'image':request['image'], 'result':'ready', 'deployed':False}
            if request['environment'] == 'production':
                rootJson(config.get('productionCandidateConfig', ''), private=True)
                preflight['productionCandidateGate'] = True
            print(json.dumps(preflight))
            return
        # 生产仅用完整本机缓存或独立香港只读见证中继，不再直接访问GHCR。
        diagnosticPhase = 'image_transfer'
        ensureImage(config, request, transfer)
        transfer = None

        diagnosticPhase = 'image_inspect'
        metadata = json.loads(run(['docker', 'image', 'inspect', request['image']]))[0]
        labels = metadata['Config'].get('Labels') or {}
        require(labels.get('org.opencontainers.image.revision') == request['sourceSha'], '镜像源码标签不匹配')
        # 准入在停机前完成；缺少 worker、备份空间或生成验收均应在此拒绝。
        diagnosticPhase = 'readiness'
        run([config['readinessCommand']], input=json.dumps(request), timeout=300)
        transaction = {'request': request, 'transfer':transferIdentity, 'phase':'preparing', 'predecessorId':current['Image'],
                       'predecessorImage':current['Config']['Image'], 'startedAt':time.time()}
        if request['environment'] == 'production':
            diagnosticPhase = 'production_candidate_verification'
            transaction['candidateVerification'] = verifyProductionCandidate(config, request, current, inspect, run)
        diagnosticPhase = 'transaction'
        atomicJson(journal, transaction)
        # 备份成功后持续停写直到切换，避免回退备份遗漏期间的新数据。
        backup = json.loads(run([config['backupCommand']], input=json.dumps(request), timeout=900))
        require(backup.get('backupVerified') is True and backup.get('restoreVerified') is True
                and backup.get('quotaRestoreVerified') is True and backup.get('backupId'), '完整配额卷备份恢复验证未通过')
        transaction.update(phase='backupVerified', backup=backup)
        atomicJson(journal, transaction)
        transaction['phase'] = 'switching'
        atomicJson(journal, transaction)
        run([config['switchCommand']], input=json.dumps({**request, 'predecessorId':current['Image']}), timeout=300)
        running = inspect(config['container'])
        require(running['State']['Running'] and running['Image'] == imageId(request['image']), '运行镜像读回不一致')
        transaction['phase'] = 'verifying'
        atomicJson(journal, transaction)
        # 验收由固定本机程序实际执行业务请求，不能传入任意验证脚本。
        verifyTransaction(config, request, transaction, journal)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--reject-staging-verification':
            rejectStagingVerification(sys.argv[2])
        else:
            require(len(sys.argv) == 1, '发布入口参数非法')
            main()
    except Exception as error:
        try:
            recordTopFailure(error)
        except Exception:
            print('发布诊断写入失败；结果仍未完成。', file=sys.stderr)
        # 不回显配置、供应商凭据或原始子进程错误；详细阶段在 root 账本内读回。
        print('发布未完成；请读取主机发布事务及配置检查结果。', file=sys.stderr)
        sys.exit(1)
