#!/usr/bin/env python3
import fcntl
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen


product = 'ZenithJoy Canvas'
repository = 'perfectuser21/zenithjoy-toonflow'
releaseRuns = f'https://github.com/{repository}/actions/runs/'
sourceFiles = f'https://raw.githubusercontent.com/{repository}/'
environments = {
    'staging': ('https://aivideo-staging.zenjoymedia.media', '香港测试站', '香港发布记录', '验收通过'),
    'production': ('https://aivideo.zenithjoy.tech', '杭州正式站', '杭州发布记录', '已上线'),
}
serviceHome = Path('/var/lib/canvas-notes')
settingsPath = Path('/etc/aivideo/canvas-notion.json')


def request(url, *, method='GET', body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urlopen(Request(url, data=data, method=method, headers=headers or {}), timeout=15) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f'HTTP {error.code} for {method} {url}') from None


def select(value):
    return {'select': {'name': value}}


def sourceText(sha, path):
    with urlopen(sourceFiles + sha + '/' + path, timeout=15) as response:
        content = response.read(100001)
    if len(content) > 100000:
        raise ValueError('release source file is too large')
    return content.decode()


def releaseProperties(event, version, identity):
    env = event['environment']
    _, stateField, linkField, passed = environments[env]
    running = identity.get('sourceSha') == event['sourceSha']
    receipt = event.get('receipt')
    if event['outcome'] == 'success':
        if (not receipt or receipt.get('businessVerified') is not True
                or (receipt.get('environment'), receipt.get('sourceSha')) != (env, event['sourceSha'])
                or not re.fullmatch(r'ghcr\.io/' + re.escape(repository) + r'@sha256:[a-f0-9]{64}', receipt.get('image') or '')
                or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', receipt.get('bootId') or '')):
            raise ValueError('invalid successful release receipt')
        if not event['replay'] and (not running or receipt['image'] != identity.get('image')
                                    or receipt['bootId'] != identity.get('bootId')
                                    or identity.get('product') != {'name': product, 'version': version}):
            raise ValueError('published identity does not match the successful release receipt')
        status = passed
    else:
        status = '完整验收未通过' if running else '发布未完成'
    return {stateField: select(status), linkField: {'url': releaseRuns + event['run']}}


def value(properties, key, kind):
    candidate = properties.get(key, {}).get(kind)
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
        linkField = next(field for field in changes if field.endswith('发布记录'))
        previous = value(row['properties'], linkField, 'url') or ''
        expected = changes[linkField]['url']
        if previous.startswith(releaseRuns) and previous[len(releaseRuns):].isdigit():
            if int(previous[len(releaseRuns):]) > int(expected[len(releaseRuns):]):
                return 'unchanged', row['id']
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
    if os.environ.get('SSH_ORIGINAL_COMMAND'):
        raise ValueError('unexpected SSH command')
    payload = sys.stdin.buffer.read(20001)
    if len(payload) > 20000:
        raise ValueError('release event is too large')
    event = json.loads(payload)
    fields = {'environment', 'sourceSha', 'run', 'outcome', 'receipt', 'replay'}
    if (set(event) != fields or event['environment'] not in environments
            or event['outcome'] not in {'success', 'failure', 'cancelled', 'timed_out'}
            or type(event['replay']) is not bool
            or not re.fullmatch(r'[a-f0-9]{40}', event['sourceSha'])
            or not re.fullmatch(r'[1-9][0-9]{0,19}', event['run'])):
        raise ValueError('invalid Canvas delivery event')
    settings = json.loads(settingsPath.read_text())
    dataSource = settings['dataSource']
    if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', dataSource):
        raise ValueError('invalid Notion data source')
    headers = {'Authorization': 'Bearer ' + settings['token'],
               'Notion-Version': '2026-03-11', 'Content-Type': 'application/json'}

    def notion(method, path, body):
        return request('https://api.notion.com/v1' + path, method=method, body=body, headers=headers)

    sha = event['sourceSha']
    source = sourceText(sha, 'canvasRelease.ts')
    versionMatch = re.search(r'\bversion:\s*"([0-9]+\.[0-9]+\.[0-9]+)"', source)
    if not versionMatch or not re.search(r'\bname:\s*"' + re.escape(product) + '"', source):
        raise ValueError('invalid Canvas product version manifest')
    version = versionMatch.group(1)
    origin = environments[event['environment']][0]
    identity = request(origin + '/api/delivery/identity')['data']
    properties = releaseProperties(event, version, identity)
    with (serviceHome / 'sync.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        action, page = updateVersion(notion, dataSource, version, properties,
                                     lambda _: sourceText(sha, 'releaseNotes/v' + version + '.md'))
    print(f'{product} v{version} {action} https://app.notion.com/p/{page.replace("-", "")}', flush=True)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, TypeError, KeyError) as error:
        print(f'Canvas release notes sync failed: {type(error).__name__}', file=sys.stderr)
        sys.exit(1)
