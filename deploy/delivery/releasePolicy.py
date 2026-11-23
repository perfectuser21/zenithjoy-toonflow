"""公网发布入口与可晋级回执的固定合同。"""
import re


publicOrigins = {
    'staging': 'https://aivideo-staging.zenjoymedia.media',
    'production': 'https://aivideo.zenithjoy.tech',
}
requiredBusinessJourneys = {
    'staging': (
        'ordinaryAccountLogin',
        'customerBrandAndEntryAssets',
        'canvasSaveReadback',
        'crossAccountIsolation',
        'trimOutputReadback',
        'videoGenerationReadback',
        'customerPointsSettlement',
        'studioImageGatewayReadback',
    ),
    'production': (
        'ordinaryAccountLogin',
        'canvasSaveReadback',
        'crossAccountIsolation',
        'trimOutputReadback',
        'mediaGenerationReadback',
    ),
}
releaseIdentityFields = ('environment', 'sourceSha', 'image', 'runId', 'runAttempt')
imagePattern = r'ghcr.io/perfectuser21/zenithjoy-toonflow@sha256:[a-f0-9]{64}'
publicReceiptFields = (
    *releaseIdentityFields, 'publicOrigin', 'result', 'runningImage', 'bootId',
    'businessVerified', 'businessMode', 'trimVerified', 'generationVerified', 'generationMediaType',
    'crossAccountIsolationVerified', 'passedJourneys', 'frameAnalysisNodeSha256',
    'backupVerified', 'restoreVerified', 'quotaRestoreVerified', 'predecessorImage', 'backupId', 'transfer',
)


def requireQuotaVolume(config):
    if config.get('dataMode', 'quotaVolume') != 'quotaVolume':
        raise RuntimeError('发布必须使用配额卷')


def matchesString(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def validatePassedJourneys(passed, environment):
    required = requiredBusinessJourneys[environment]
    if (not isinstance(passed, list) or len(passed) != len(required)
            or not all(isinstance(journey, str) for journey in passed) or set(passed) != set(required)):
        raise RuntimeError('业务回执必须完整记录本环境已通过的验收旅程')


def validateReceipt(receipt, request, environment):
    if (not isinstance(receipt, dict) or receipt.get('environment') != environment
            or receipt.get('publicOrigin') != publicOrigins[environment]
            or any(receipt.get(key) != request[key] for key in releaseIdentityFields[1:])
            or not matchesString('[a-f0-9]{40}', receipt.get('sourceSha'))
            or not matchesString(imagePattern, receipt.get('image'))
            or any(not matchesString('[1-9][0-9]{0,19}', receipt.get(key)) for key in ('runId', 'runAttempt'))):
        raise RuntimeError('验收版本身份或固定公网入口不匹配')
    if (receipt.get('result') != 'passed' or receipt.get('runningImage') != request['image']
            or not matchesString('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', receipt.get('bootId'))
            or receipt.get('businessMode') != 'tenant'
            or receipt.get('generationMediaType') not in ('image', 'video', 'audio')
            or any(receipt.get(key) is not True for key in (
                'businessVerified', 'trimVerified', 'generationVerified', 'crossAccountIsolationVerified',
                'backupVerified', 'restoreVerified', 'quotaRestoreVerified'))
            or not receipt.get('predecessorImage') or not receipt.get('backupId')):
        raise RuntimeError('普通账号业务验收或配额卷恢复未通过')
    if environment == 'staging' and (
            receipt['generationMediaType'] != 'video'
            or not matchesString('[a-f0-9]{64}', receipt.get('frameAnalysisNodeSha256'))):
        raise RuntimeError('香港验收缺少视频生成或逐帧拉片构建包证据')
    validatePassedJourneys(receipt.get('passedJourneys'), environment)
    transfer = receipt.get('transfer')
    key = f"aivideoReleases/{request['sourceSha']}/{request['runId']}/{request['runAttempt']}/image.oci"
    if (not isinstance(transfer, dict) or set(transfer) != {'key', 'sha256', 'bytes'} or transfer['key'] != key
            or not matchesString('[a-f0-9]{64}', transfer['sha256'])
            or type(transfer['bytes']) is not int or transfer['bytes'] <= 0):
        raise RuntimeError('验收回执的COS对象身份不匹配')


def publicReceipt(receipt):
    return {key: receipt[key] for key in publicReceiptFields if key in receipt}
