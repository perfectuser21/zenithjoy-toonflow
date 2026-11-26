#!/usr/bin/env python3
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen


product = 'ZenithJoy Canvas'
releaseRuns = 'https://github.com/perfectuser21/zenithjoy-toonflow/actions/runs/'
environments = {
    'staging': ('https://aivideo-staging.zenjoymedia.media', 'hk-vps', 'python3 -B -', '香港测试站', '香港发布记录'),
    'production': ('https://aivideo.zenithjoy.tech', 'aliyun-cn-public', 'sudo -n python3 -B -', '杭州正式站', '杭州发布记录'),
}

hostRead = '''
import json, pathlib, re, subprocess
config=json.loads(pathlib.Path('/etc/aivideo/release.json').read_text())
state=pathlib.Path(config['stateDirectory'])
live=json.loads(subprocess.check_output(['docker','inspect',config['container']]))[0]
assert live['State']['Running']
rows=[]
for file in state.glob('[0-9]*-[0-9]*.json'):
    if not re.fullmatch(r'[0-9]+-[0-9]+',file.stem): continue
    row=json.loads(file.read_text())
    request=row['request']
    if request['image'] == live['Config']['Image'] and request['environment'] == config['environment']:
        rows.append((row.get('startedAt',0),file,row))
assert rows, 'running image missing from release ledger'
_,file,row=max(rows,key=lambda entry:entry[0])
request=row['request']
prefix='diagnostic-'+file.stem
diagnostics=[state/(prefix+'.json'), *(entry for entry in state.glob(prefix+'-*.json')
             if re.fullmatch(re.escape(prefix)+r'-[0-9]+',entry.stem))]
current=[entry for entry in diagnostics if entry.exists()
         and entry.stat().st_mtime >= row.get('verificationResumedAt', 0)]
diagnostic=json.loads(max(current,key=lambda entry:entry.stat().st_mtime).read_text()) if current else {}
receipt=row.get('receipt') or {}
print(json.dumps({'environment':config['environment'],'origin':config['publicOrigin'],
    'sha':request['sourceSha'],'image':request['image'],'run':request['runId'],
    'phase':row['phase'],'diagnostic':{'exit':diagnostic.get('exit'),'timedOut':diagnostic.get('timedOut')},
    'rejected':(state/('rejected-'+file.name)).exists(),
    'verified':receipt.get('businessVerified') is True,'boot':receipt.get('bootId'),
    'started':live['State']['StartedAt']}))
'''


def request(url, *, method='GET', body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urlopen(Request(url, data=data, method=method, headers=headers or {}), timeout=15) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f'HTTP {error.code} for {method} {url}') from None


def select(value):
    return {'select': {'name': value}}


def minute(value):
    withoutFraction = re.sub(r'\.\d+(?=[Z+-])', '', value)
    timestamp = datetime.datetime.fromisoformat(withoutFraction.replace('Z', '+00:00'))
    return timestamp.astimezone(datetime.timezone.utc).replace(second=0, microsecond=0).isoformat()


def releaseProperties(env, identity, evidence):
    origin, _, _, stateField, linkField = environments[env]
    if (evidence['environment'], evidence['origin'], evidence['sha'], evidence['image']) != (
        env, origin, identity['sourceSha'], identity['image']
    ):
        raise ValueError('public identity and host release ledger disagree')
    if not re.fullmatch(r'[1-9][0-9]*', evidence['run']):
        raise ValueError('invalid release run')
    if evidence['phase'] == 'completed' and evidence['verified'] and evidence['boot'] == identity['bootId']:
        status = '验收通过' if env == 'staging' else '已上线'
    elif evidence['phase'] == 'verifying':
        diagnostic = evidence['diagnostic']
        exitCode = diagnostic.get('exit')
        failed = evidence['rejected'] or diagnostic.get('timedOut') is True or (type(exitCode) is int and exitCode != 0)
        status = '完整验收未通过' if failed else '验收中'
    else:
        raise ValueError('release ledger has no current verification state')
    properties = {stateField: select(status), linkField: {'url': releaseRuns + evidence['run']}}
    if env == 'staging':
        properties['香港切换时间'] = {'date': {'start': minute(evidence['started'])}}
    return properties


def value(properties, key, kind):
    candidate = properties.get(key, {}).get(kind)
    if kind == 'date':
        return minute(candidate['start']) if candidate else None
    if kind == 'select':
        return candidate['name'] if candidate else None
    return candidate


def updateVersion(notion, dataSource, version, changes, notes):
    result = notion('POST', f'/data_sources/{dataSource}/query', {'page_size': 2, 'filter': {'and': [
        {'property': '产品', 'select': {'equals': product}},
        {'property': '版本', 'rich_text': {'equals': 'v' + version}},
    ]}})
    rows = result['results']
    if len(rows) > 1 or result.get('has_more'):
        raise RuntimeError('duplicate Notion product and version')
    if rows:
        row = rows[0]
        updates = {key: new for key, new in changes.items() if any(
            value(row['properties'], key, kind) != value(changes, key, kind) for kind in new
        )}
        if not updates:
            return 'unchanged', row['id']
        saved = notion('PATCH', '/pages/' + row['id'], {'properties': updates})
        action = 'updated'
    else:
        def rich(text):
            return [{'type': 'text', 'text': {'content': text}}]
        properties = {'发布说明': {'title': rich(f'{product} v{version}')}, '产品': select(product),
                      '版本': {'rich_text': rich('v' + version)}, '香港测试站': select('待发布'),
                      '杭州正式站': select('待晋级'), **changes}
        saved = notion('POST', '/pages', {'parent': {'type': 'data_source_id', 'data_source_id': dataSource},
                                         'properties': properties, 'markdown': notes(version)})
        action = 'created'
    for key, new in changes.items():
        if any(value(saved['properties'], key, kind) != value(changes, key, kind) for kind in new):
            raise RuntimeError('Notion write did not preserve the release status')
    return action, saved['id']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--token-file', type=Path, required=True)
    parser.add_argument('--data-source', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', args.data_source):
        raise ValueError('invalid Notion data source')
    if args.token_file.stat().st_mode & 0o077:
        raise ValueError('token file must be private')
    headers = {'Authorization': 'Bearer ' + args.token_file.read_text().strip(),
               'Notion-Version': '2026-03-11', 'Content-Type': 'application/json'}

    def notion(method, path, body):
        return request('https://api.notion.com/v1' + path, method=method, body=body, headers=headers)

    def notes(version):
        subprocess.run(['/usr/bin/git', '-C', str(args.repo), 'fetch', '--quiet', 'origin', 'master'], check=True, timeout=35)
        return subprocess.check_output(['/usr/bin/git', '-C', str(args.repo), 'show', f'FETCH_HEAD:releaseNotes/v{version}.md'], text=True, timeout=20)

    with (args.token_file.parent / 'canvasReleaseNotes.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        observed = {}
        failed = False
        for env, (origin, sshHost, command, _, _) in environments.items():
            try:
                identity = request(origin + '/api/delivery/identity')['data']
                version = (identity.get('product') or {}).get('version')
                if not version:
                    continue  # Older builds predate product versioning.
                if identity['product']['name'] != product or not re.fullmatch(r'\d+\.\d+\.\d+', version):
                    raise ValueError('invalid product identity')
                evidence = json.loads(subprocess.check_output(['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', sshHost, command], input=hostRead, text=True, timeout=25))
                props = releaseProperties(env, identity, evidence)
                observed.setdefault(version, {}).update(props)
            except Exception as error:
                print(f'{env} 未同步: {error}', file=sys.stderr)
                failed = True
        for version, changes in observed.items():
            action, page = updateVersion(notion, args.data_source, version, changes, notes)
            print(f'{product} v{version} {action} {page}', flush=True)
        return int(failed)


if __name__ == '__main__':
    sys.exit(main())
