"""校验杭州独立候选，公网在整个验收期间继续指向前驱。"""
import json
from pathlib import Path

from releasePolicy import generationProfile, releaseIdentityFields, validatePassedJourneys
from verifyBusiness import (localClient, loopbackAddress, newPublicClient, require,
                            rootFile, rootJson, verifyContainer, verifyPublicCandidate)


def pathsOverlap(left, right):
    return left == right or left in right.parents or right in left.parents


def verifyIsolation(profile, candidate, incumbent):
    require(candidate['Id'] != incumbent['Id'], '隔离验收不能使用正式容器')
    settings = candidate['HostConfig']
    require(not settings['Privileged'] and not settings.get('PublishAllPorts')
            and not settings.get('CapAdd') and not settings.get('Devices')
            and settings.get('NetworkMode') not in (None, 'host')
            and not any((settings.get(key) or '').startswith(('host', 'container:'))
                        for key in ('NetworkMode', 'PidMode', 'IpcMode')),
            '杭州候选容器必须隔离宿主命名空间')
    candidateNetworks = set(candidate['NetworkSettings']['Networks'])
    require(candidateNetworks and not candidateNetworks & set(incumbent['NetworkSettings']['Networks']),
            '杭州候选必须使用独立容器网络')
    bindings = [binding for port in candidate['NetworkSettings']['Ports'].values() for binding in port or []]
    require(len(bindings) == 1 and bindings[0]['HostIp'] in ('127.0.0.1', '::1'),
            '杭州候选只允许一个回环端口')
    candidatePaths = [Path(profile[key]).resolve(strict=True)
                      for key in ('dataDirectory', 'stateDirectory', 'runtimeDirectory')]
    liveSources = [Path(mount['Source']).resolve(strict=True) for mount in incumbent['Mounts']]
    require(all(path != path.parent for path in candidatePaths), '杭州候选不能共享宿主根目录')
    require(not any(pathsOverlap(path, live) for path in candidatePaths for live in liveSources),
            '杭州候选数据、收据和运行目录不能重叠正式挂载')
    for mount in candidate['Mounts']:
        source = Path(mount['Source']).resolve(strict=True)
        require(mount['Type'] == 'bind' and any(source.is_relative_to(path) for path in candidatePaths)
                and not any(pathsOverlap(source, live) for live in liveSources)
                and mount['Destination'] not in ('/var/run/docker.sock', '/run/docker.sock'),
                '杭州候选包含不独立的挂载')


def verifyProductionCandidate(config, request, incumbent, inspect, run):
    profilePath = rootFile(config.get('productionCandidateConfig', ''), private=True)
    profile = rootJson(profilePath, private=True)
    require(profile['environment'] == config['environment'] == 'production'
            and profile['publicOrigin'] == config['publicOrigin']
            and profile['businessConfig'] != config['businessConfig']
            and profile['container'] != config['container'], '杭州独立候选发布配置缺失')
    require(not any(pathsOverlap(Path(profile[key]).resolve(strict=True), Path(config[key]).resolve(strict=True))
                    for key in ('dataDirectory', 'stateDirectory')), '杭州候选与正式环境目录重叠')
    require(Path(profile['dataDirectory']).stat().st_dev != Path(config['dataDirectory']).stat().st_dev,
            '杭州候选必须使用独立文件系统')
    business = rootJson(config['businessConfig'], private=True)
    isolatedBusiness = rootJson(profile['businessConfig'], private=True)
    expected = generationProfile(business)
    require(expected == generationProfile(isolatedBusiness) == request['stagingReceipt'].get('generationProfile'),
            '香港验收、杭州候选与杭州正式的媒体生成模型必须一致')
    require(isolatedBusiness['generationVerifier'] == business['generationVerifier'],
            '杭州候选必须使用正式环境的生成验收器')
    isolatedHost, isolatedPort = loopbackAddress(isolatedBusiness['localOrigin'])
    require(isolatedPort != loopbackAddress(business['localOrigin'])[1],
            '杭州候选与正式环境端口重叠')
    public = newPublicClient(business)
    incumbentIdentity = public.request('GET', '/api/delivery/identity', timeout=10)
    require(incumbentIdentity['image'] == incumbent['Config']['Image'], '公网当前没有指向正式前驱')

    def verifyCandidateIdentity():
        candidate = inspect(profile['container'])
        verifyIsolation(profile, candidate, incumbent)
        require(verifyContainer(profile, request, isolatedBusiness['localOrigin'], isolated=True) == candidate['Id'],
                '杭州候选容器在核验期间发生变化')
        local = localClient(isolatedBusiness)
        require(isolatedHost == next(binding['HostIp'] for port in candidate['NetworkSettings']['Ports'].values()
                                    for binding in port or []), '杭州候选回环监听地址不匹配')
        return candidate['Id'], verifyPublicCandidate(local, local, request, timeout=10)

    candidateId, bootId = verifyCandidateIdentity()
    verifier = rootFile(config['businessVerifier'], executable=True)
    receipt = json.loads(run([str(verifier), str(profilePath)], input=json.dumps(request), timeout=1200))
    require(all(receipt.get(field) == request[field] for field in releaseIdentityFields)
            and receipt.get('bootId') == bootId and receipt.get('runningImage') == request['image']
            and receipt.get('result') == 'passed'
            and all(receipt.get(field) is True for field in ('businessVerified', 'trimVerified',
                                                            'generationVerified', 'crossAccountIsolationVerified')),
            '杭州未取得本次候选完整业务验收')
    validatePassedJourneys(receipt.get('passedJourneys'), 'production')
    require(verifyCandidateIdentity() == (candidateId, bootId), '杭州候选已重启，验收失效')
    final = inspect(config['container'])
    require(final['Id'] == incumbent['Id'] and final['State']['Running']
            and public.request('GET', '/api/delivery/identity', timeout=10) == incumbentIdentity,
            '杭州公网前驱在候选验收期间发生变化')
    return {'containerId': candidateId, 'predecessorId': incumbent['Id'], 'bootId': bootId,
            'generationProfile': expected,
            'passedJourneys': receipt['passedJourneys']}
