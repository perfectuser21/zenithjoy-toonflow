#!/usr/bin/env python3
"""Identity checks for an authenticated, pre-pinned GitHub Actions build.

This module does not fetch credentials or establish trust in API responses. The
release control plane must obtain those responses over authenticated GitHub API
and provision the pin from an independently approved release decision.
"""
import re

_REPO = 'perfectuser21/zenithjoy-toonflow'
_WORKFLOW = '.github/workflows/serverBuild.yml'
_PIN_FIELDS = {'repository', 'workflow', 'run_id', 'run_attempt', 'commit', 'artifact_id', 'artifact_digest'}

def verify_github_identity(pin, run, artifacts):
    if not isinstance(pin, dict) or set(pin) != _PIN_FIELDS:
        raise ValueError('invalid release pin')
    if pin['repository'] != _REPO or pin['workflow'] != _WORKFLOW:
        raise ValueError('unexpected repository or workflow')
    if type(pin['run_id']) is not int or pin['run_id'] < 1 or type(pin['artifact_id']) is not int or pin['artifact_id'] < 1 or type(pin['run_attempt']) is not int or pin['run_attempt'] < 1:
        raise ValueError('invalid run or artifact id')
    if not isinstance(pin['commit'], str) or not re.fullmatch(r'[a-f0-9]{40}', pin['commit']):
        raise ValueError('invalid commit')
    if not isinstance(pin['artifact_digest'], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', pin['artifact_digest']):
        raise ValueError('invalid artifact digest')
    if not isinstance(run, dict) or (run.get('id'), run.get('run_attempt'), run.get('path'), run.get('event'), run.get('status'), run.get('conclusion'), run.get('head_sha')) != (pin['run_id'], pin['run_attempt'], pin['workflow'], 'pull_request', 'completed', 'success', pin['commit']):
        raise ValueError('run does not match release pin')
    if not isinstance(run.get('repository'), dict) or run['repository'].get('full_name') != _REPO or not isinstance(run.get('head_repository'), dict) or run['head_repository'].get('full_name') != _REPO:
        raise ValueError('run repository mismatch')
    if not isinstance(artifacts, list):
        raise ValueError('invalid artifacts')
    rows = [a for a in artifacts if isinstance(a, dict) and a.get('id') == pin['artifact_id']]
    if len(rows) != 1 or len(artifacts) != 1:
        raise ValueError('ambiguous artifact')
    row = rows[0]
    if row.get('name') != 'toonflow-build-' + pin['commit'] or row.get('digest') != pin['artifact_digest'] or row.get('expired') is not False or type(row.get('size_in_bytes')) is not int or not 0 < row['size_in_bytes'] <= 2 * 1024**3:
        raise ValueError('artifact does not match release pin')

def verify_artifact_digest(pin, source):
    import hashlib
    expected = pin.get('artifact_digest') if isinstance(pin, dict) else None
    if not isinstance(expected, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', expected):
        raise ValueError('invalid artifact digest')
    digest = hashlib.sha256()
    while True:
        block = source.read(1024 * 1024)
        if not block:
            break
        digest.update(block)
    if 'sha256:' + digest.hexdigest() != expected:
        raise ValueError('artifact bytes do not match release pin')

REQUIRED_UNITS = (
    'deploy/quota/toonflowTrimWorker.attested.service',
    'deploy/quota/toonflowTrimWorker.socket',
    'deploy/quota/toonflowTrimWitness.service',
    'deploy/quota/toonflowTrimDocker.service',
    'deploy/quota/toonflowTrimContainerd.service',
)

def verify_artifact_contents(pin, source):
    """Verify a pinned ZIP and its tar contents without extracting any path."""
    import hashlib
    import json
    import stat
    import tarfile
    import zipfile
    verify_artifact_digest(pin, source)
    source.seek(0)
    try:
        with zipfile.ZipFile(source) as z:
            items = z.infolist()
            names = [i.filename for i in items]
            if sorted(names) != ['toonflow-build.tar.gz', 'toonflow-build.tar.gz.sha256']:
                raise ValueError('artifact members are not exact')
            if any(i.file_size > 2 * 1024**3 or i.is_dir() or i.flag_bits & 1 or (stat.S_IFMT(i.external_attr >> 16) not in (0, stat.S_IFREG)) for i in items):
                raise ValueError('unsafe artifact member')
            checksum_info = z.getinfo('toonflow-build.tar.gz.sha256')
            if checksum_info.file_size > 256:
                raise ValueError('checksum too large')
            with z.open(checksum_info) as checksum_file:
                checksum = checksum_file.read(257)
            if len(checksum) != checksum_info.file_size or len(checksum) > 256:
                raise ValueError('checksum size mismatch')
            inner = hashlib.sha256()
            with z.open('toonflow-build.tar.gz') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    inner.update(block)
            if checksum.decode('ascii').strip() != inner.hexdigest() + '  toonflow-build.tar.gz':
                raise ValueError('inner checksum mismatch')
            found, unit_files, manifest, seen, files, total = {}, {}, None, set(), set(), 0
            with z.open('toonflow-build.tar.gz') as stream, tarfile.open(fileobj=stream, mode='r|gz') as tar:
                for member in tar:
                    name = member.name.rstrip('/')
                    if not name or any(x in ('', '.', '..') for x in name.split('/')) or name.startswith('/') or name in seen:
                        raise ValueError('unsafe or duplicate tar path')
                    parents = name.split('/')
                    if any('/'.join(parents[:i]) in files for i in range(1, len(parents))):
                        raise ValueError('tar file/directory conflict')
                    if not member.isdir() and any(old.startswith(name + '/') for old in seen):
                        raise ValueError('tar file/directory conflict')
                    seen.add(name)
                    if not member.isdir():
                        files.add(name)
                    if len(seen) > 100000 or member.size > 512 * 1024**2:
                        raise ValueError('tar limits exceeded')
                    if member.isdir():
                        if name not in ('build', 'release-units') and not name.startswith('build/'):
                            raise ValueError('unexpected directory')
                        continue
                    if not member.isfile() or not (name == 'artifact-manifest.json' or name.startswith('build/') or name.startswith('release-units/')):
                        raise ValueError('unsafe tar member')
                    total += member.size
                    if total > 8 * 1024**3:
                        raise ValueError('tar size exceeded')
                    entry = tar.extractfile(member)
                    if entry is None:
                        raise ValueError('unreadable tar member')
                    if name == 'artifact-manifest.json':
                        if member.size > 8 * 1024**2:
                            raise ValueError('manifest too large')
                        manifest = json.load(entry)
                    else:
                        digest = hashlib.sha256()
                        for block in iter(lambda: entry.read(1024 * 1024), b''):
                            digest.update(block)
                        if name.startswith('release-units/'):
                            unit_files[name[len('release-units/'):]] = digest.hexdigest()
                        else:
                            found[name[len('build/'):]] = digest.hexdigest()
            if not isinstance(manifest, dict) or manifest.get('source_sha') != pin.get('commit') or manifest.get('repository') != pin.get('repository') or manifest.get('run_id') != str(pin.get('run_id')) or manifest.get('run_attempt') != str(pin.get('run_attempt')) or manifest.get('architecture') != 'linux/amd64':
                raise ValueError('manifest provenance mismatch')
            if not found or found != manifest.get('files_sha256') or 'server/trimWorker.js' not in found:
                raise ValueError('build manifest mismatch')
            units = manifest.get('unit_sources_sha256')
            if not isinstance(units, dict) or set(units) != set(REQUIRED_UNITS) or any(not isinstance(v, str) or not re.fullmatch(r'[a-f0-9]{64}', v) for v in units.values()):
                raise ValueError('unit sources are not pinned')
            expected_unit_files = {name.rsplit('/', 1)[1]: units[name] for name in REQUIRED_UNITS}
            if unit_files != expected_unit_files:
                raise ValueError('unit bytes do not match CI manifest')
            return manifest
    except (zipfile.BadZipFile, tarfile.TarError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError('invalid build artifact') from error

def verify_release(pin, run, artifacts, source):
    """One entry point for authenticated API identity and pinned artifact bytes."""
    verify_github_identity(pin, run, artifacts)
    return verify_artifact_contents(pin, source)

def verify_installed_bytes(manifest, installed):
    """Match exact installed unit and critical script bytes to verified CI manifest."""
    import hashlib
    names = (*REQUIRED_UNITS, 'server/trimWorker.js', 'server/captureTrimRuntimeProof.js', 'server/recoverTrimActive.js', 'server/prepareTrimCgroup.js')
    if not isinstance(installed, dict) or set(installed) != set(names):
        raise ValueError('installed file set mismatch')
    unit_hashes = manifest.get('unit_sources_sha256', {}) if isinstance(manifest, dict) else {}
    script_hashes = manifest.get('files_sha256', {}) if isinstance(manifest, dict) else {}
    for name in names:
        data = installed[name]
        expected = unit_hashes.get(name) if name in REQUIRED_UNITS else script_hashes.get(name)
        if not isinstance(data, bytes) or not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected) or hashlib.sha256(data).hexdigest() != expected:
            raise ValueError('installed file differs from CI manifest')

def pin_authenticated_candidate(candidate, run, artifacts):
    """Pin only the selected candidate's digest from an authenticated API response."""
    expected = _PIN_FIELDS - {'artifact_digest'}
    if not isinstance(candidate, dict) or set(candidate) != expected or not isinstance(artifacts, list):
        raise ValueError('invalid release candidate')
    matches = [row for row in artifacts if isinstance(row, dict) and row.get('id') == candidate['artifact_id']]
    if len(matches) != 1:
        raise ValueError('selected artifact missing or ambiguous')
    pin = {**candidate, 'artifact_digest': matches[0].get('digest')}
    verify_github_identity(pin, run, artifacts)
    return pin

def collect_install_members(pin, source):
    """Collect only the small, fully verified files needed by a fresh installer."""
    import tarfile
    import zipfile
    manifest = verify_artifact_contents(pin, source)
    wanted = {name: 'release-units/' + name.rsplit('/', 1)[1] for name in REQUIRED_UNITS}
    for name in ('trimWorker.js', 'captureTrimRuntimeProof.js', 'recoverTrimActive.js', 'prepareTrimCgroup.js'):
        wanted['server/' + name] = 'build/server/' + name
    reverse = {path: key for key, path in wanted.items()}
    found = {}
    source.seek(0)
    with zipfile.ZipFile(source) as z, z.open('toonflow-build.tar.gz') as stream, tarfile.open(fileobj=stream, mode='r|gz') as tar:
        for member in tar:
            key = reverse.get(member.name)
            if key is None: continue
            if key in found or not member.isfile() or member.size > 16 * 1024**2:
                raise ValueError('unsafe install member')
            f = tar.extractfile(member)
            if f is None: raise ValueError('install member unreadable')
            data = f.read(16 * 1024**2 + 1)
            if len(data) != member.size or len(data) > 16 * 1024**2:
                raise ValueError('install member size mismatch')
            found[key] = data
    verify_installed_bytes(manifest, found)
    source.seek(0)
    verify_artifact_digest(pin, source)
    return manifest, found
