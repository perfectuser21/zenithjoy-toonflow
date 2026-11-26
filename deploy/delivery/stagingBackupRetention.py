#!/usr/bin/env python3
"""Move completed Hong Kong rollback capsules to an encrypted off-host repository."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

from releaseHost import inspect, resolvedTransaction
from releasePolicy import publicOrigins
from verifyBusiness import rootFile, rootJson, require
from stagingBackupArchive import CosArchive, archiveKey, formatName


def syncDirectory(path):
    fd = os.open(path, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomicJson(path, data):
    fd, temporary = tempfile.mkstemp(prefix='.coldArchive-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        syncDirectory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def fingerprint(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'invalid backup file')
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def eligible(capsule, latest):
    folder = capsule.parent
    return (folder.name != latest and capsule.is_file() and not capsule.is_symlink()
            and not os.path.lexists(folder / 'compactArchive.json')
            and not any(folder.glob('referenceFor-*.json')))


def backupReceipt(backup, identifier):
    require(isinstance(identifier, str) and re.fullmatch(r'[1-9][0-9]{0,19}', identifier),
            'invalid backup identity')
    folder = backup / identifier
    receipt = rootJson(folder / 'receipt.json', private=True)
    require(receipt.get('backupId') == identifier
            and all(receipt.get(key) is True for key in
                    ('backupVerified', 'restoreVerified', 'quotaRestoreVerified'))
            and type(receipt.get('capsuleCapacityBytes')) is int
            and 0 < receipt['capsuleCapacityBytes'] <= 64 * 1024**3
            and re.fullmatch(r'[a-f0-9]{64}', receipt.get('capsuleSha256', '')), 'invalid backup receipt')
    return receipt


def releaseBackupReceipt(backup, identifier, transaction):
    receipt = backupReceipt(backup, identifier)
    require(transaction['backup'] == receipt
            and receipt.get('sourceSha') == transaction['request']['sourceSha'], 'release backup receipt mismatch')
    return receipt


def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=1800).stdout


def retire(capsule, expected, receipt, verified):
    archive = capsule.parent / 'coldArchive.json'
    require(verified.get('key') == archiveKey(receipt)
            and all(verified.get(field) == receipt[field] for field in
                    ('capsuleSha256', 'capsuleCapacityBytes')), 'archive identity mismatch')
    pointer = {'format': formatName, 'backupId': receipt['backupId'],
               'capsulePath': str(capsule), **verified}
    if os.path.lexists(archive):
        require(rootJson(archive, private=True) == pointer, 'archive pointer mismatch')
        if not capsule.exists():
            return False
    require(fingerprint(capsule) == expected, 'backup changed during archival')
    require(not command(['losetup', '--associated', str(capsule)]).strip(), 'backup is attached')
    if not archive.exists():
        atomicJson(archive, pointer)
    capsule.unlink()
    syncDirectory(capsule.parent)
    return True


@contextlib.contextmanager
def lock(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def completedBackups(config):
    state = Path(config['stateDirectory'])
    running = inspect(config['container'])
    require(running['State']['Running'], 'staging application is not running')
    completed = {}
    for path in state.glob('[0-9]*-[0-9]*.json'):
        transaction = rootJson(path, private=True)
        require(resolvedTransaction(state, path, 'staging'), 'unresolved release transaction')
        if transaction.get('phase') == 'completed':
            request = transaction['request']
            require(request['environment'] == 'staging', 'unexpected release environment')
            identifier = transaction['backup']['backupId']
            require(isinstance(identifier, str) and re.fullmatch(r'[1-9][0-9]{0,19}', identifier),
                    'invalid transaction backup identity')
            completed[identifier] = transaction
    require(completed, 'no verified staging release')
    latest = max(completed, key=int)
    current = completed[latest]
    require(running['Config']['Image'] == current['request']['image'], 'latest verified release is not running')
    backups = Path(config['backupDirectory'])
    receipt = releaseBackupReceipt(backups, latest, current)
    require(rootFile(backups / latest / 'capsule.ext4', private=True).stat().st_size
            == receipt['capsuleCapacityBytes'], 'latest local rollback unavailable')
    return latest, completed


def run(config, archive):
    require(config.get('environment') == 'staging' and config.get('publicOrigin') == publicOrigins['staging'],
            'retention is only available on Hong Kong staging')
    backup = Path(config['backupDirectory'])
    state = Path(config['stateDirectory'])
    allowed = set()
    with lock(state / 'release.lock'):
        latest, transactions = completedBackups(config)
        for identifier in transactions:
            if eligible(backup / identifier / 'capsule.ext4', latest):
                allowed.add(identifier)
    retired = []
    for identifier in sorted(allowed, key=int):
        capsule = rootFile(backup / identifier / 'capsule.ext4', private=True)
        receipt = releaseBackupReceipt(backup, identifier, transactions[identifier])
        expected = fingerprint(capsule)
        require(expected[2] == receipt['capsuleCapacityBytes'], 'backup size mismatch')
        archive.upload(capsule, receipt)
        # Do network reads without the release lock. Revalidate the archive
        # candidate under that lock before changing the local restore route.
        verified = archive.verify(receipt)
        with lock(state / 'release.lock'):
            latest, completed = completedBackups(config)
            if identifier in completed and eligible(capsule, latest):
                require(releaseBackupReceipt(backup, identifier, completed[identifier]) == receipt, 'backup receipt changed')
                if retire(capsule, expected, receipt, verified):
                    retired.append(identifier)
    return {'retiredBackups': retired}


def restore(config, archive, identifier, target):
    backup = Path(config['backupDirectory'])
    receipt = backupReceipt(backup, identifier)
    saved = rootJson(backup / identifier / 'coldArchive.json', private=True)
    require(saved == {'format': formatName, 'backupId': identifier, 'key': archiveKey(receipt),
                      'capsulePath': str(backup / identifier / 'capsule.ext4'),
                      'capsuleSha256': receipt['capsuleSha256'],
                      'capsuleCapacityBytes': receipt['capsuleCapacityBytes']}, 'cold archive pointer mismatch')
    require(target.is_absolute() and target.parent.resolve(strict=True) == target.parent,
            'restore requires a canonical output path')
    info = target.parent.lstat()
    require(info.st_uid == 0 and not info.st_mode & 0o077
            and not target.is_relative_to(Path(config['dataDirectory'])), 'unsafe restore destination')
    require(not os.path.lexists(target), 'restore output already exists')
    fd, temporary = tempfile.mkstemp(prefix='.capsuleRestore-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            archive.verify(receipt, output)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, target)
        syncDirectory(target.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return {'backupId': identifier, 'capsuleSha256': receipt['capsuleSha256']}


def main():
    require(os.geteuid() == 0, 'root required')
    config = rootJson('/etc/aivideo/release.json')
    require(config.get('environment') == 'staging' and config.get('publicOrigin') == publicOrigins['staging'],
            'retention is only available on Hong Kong staging')
    archive = CosArchive()
    if len(sys.argv) == 4 and sys.argv[1] == '--restore':
        print(json.dumps(restore(config, archive, sys.argv[2], Path(sys.argv[3]))))
        return
    require(len(sys.argv) == 1, 'invalid retention arguments')
    with lock(Path(config['stateDirectory']) / 'backupRetention.lock'):
        print(json.dumps(run(config, archive)), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # The downloader or cloud client can include credentials in errors.
        print('香港旧备份归档待重试: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
