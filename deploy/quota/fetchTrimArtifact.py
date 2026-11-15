#!/usr/bin/env python3
"""Fetch a pinned build from authenticated GitHub API for a root release controller.

The pin is fixed and root-controlled; this program never derives the trust anchor
from an artifact or frontend request. It does not install or enable services.
"""
import hashlib
import io
import selectors
import signal
import time
import json
import os
import pathlib
import fcntl
import types
import stat
import subprocess
import sys
import tempfile

PIN = '/etc/toonflow-trim/release-pin.json'
CANDIDATE = '/etc/toonflow-trim/release-candidate.json'
OUT = '/var/lib/toonflow-trim-release'
GH = '/usr/bin/gh'
TOOLS = '/etc/toonflow-trim/release-tools.json'
VERIFY = '/opt/toonflow-trim-release/verifyTrimArtifact.py'
SELF = '/opt/toonflow-trim-release/fetchTrimArtifact.py'
GH_CONFIG = '/etc/toonflow-trim/gh'
SOFT_FREE = 3 * 1024**3

def controlled(path, directory=False, private=False):
    path = os.path.abspath(path)
    if os.path.realpath(path) != path:
        raise ValueError('controlled path contains symlink')
    current = path if directory else os.path.dirname(path)
    while True:
        st = os.lstat(current)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise ValueError('uncontrolled directory')
        if current == '/': break
        current = os.path.dirname(current)
    if directory:
        st = os.lstat(path)
        if private and st.st_mode & 0o077:
            raise ValueError('release directory is not private')
        return None
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_nlink != 1 or before.st_mode & (0o077 if private else 0o022):
        raise ValueError('uncontrolled file')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    opened = os.fstat(fd)
    if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_uid, opened.st_nlink, opened.st_size) != (before.st_dev, before.st_ino, before.st_mode, before.st_uid, before.st_nlink, before.st_size):
        os.close(fd)
        raise ValueError('file changed during open')
    return fd

def run_bounded(argv, env, output, limit, seconds, healthy=lambda: True, pass_fds=()):
    """Bound stdout, time and disk polling; stop the trusted process group on error."""
    if limit < 1 or seconds <= 0:
        raise ValueError('invalid process limits')
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            env=env, start_new_session=True, pass_fds=pass_fds)
    selector = selectors.DefaultSelector()
    total = 0
    deadline = time.monotonic() + seconds
    try:
        os.set_blocking(proc.stdout.fileno(), False)
        selector.register(proc.stdout, selectors.EVENT_READ)
        while selector.get_map():
            if not healthy(): raise ValueError('release disk below safety threshold')
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise TimeoutError('release command timed out')
            for key, _ in selector.select(min(remaining, 0.25)):
                try: block = os.read(key.fd, min(1024 * 1024, limit - total + 1))
                except BlockingIOError: continue
                if not block:
                    selector.unregister(proc.stdout)
                    break
                total += len(block)
                if total > limit: raise ValueError('release output exceeds limit')
                if output.write(block) != len(block): raise OSError('short write')
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError('release command timed out')
        if proc.wait(timeout=remaining) != 0: raise ValueError('release command failed')
        # A surviving process in the trusted command group makes outcome unknown.
        try: os.killpg(proc.pid, 0)
        except ProcessLookupError: pass
        else: raise ValueError('release command group still alive')
        return total
    except BaseException as original:
        try: os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try: os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            proc.wait(timeout=5)
        try: os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        # A surviving process group makes cleanup unknown; do not publish.
        until = time.monotonic() + 3
        while True:
            try: os.killpg(proc.pid, 0)
            except ProcessLookupError: break
            if time.monotonic() >= until:
                raise RuntimeError('release process group did not exit') from original
            time.sleep(0.05)
        raise
    finally:
        selector.close()
        proc.stdout.close()

def read_controlled_json(path, limit=16384):
    fd = controlled(path, private=True)
    with os.fdopen(fd, 'rb') as f:
        before = os.fstat(f.fileno())
        if before.st_size > limit: raise ValueError('control file too large')
        data = f.read(limit + 1)
        after = os.fstat(f.fileno())
        if len(data) != before.st_size or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError('control file changed')
        return json.loads(data)

def pinned_fd(path, digest, max_size):
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise ValueError('invalid tool digest')
    fd = controlled(path)
    try:
        before = os.fstat(fd)
        if before.st_size > max_size: raise ValueError('tool exceeds limit')
        h = hashlib.sha256()
        while True:
            data = os.read(fd, 1024 * 1024)
            if not data: break
            h.update(data)
        after = os.fstat(fd)
        if h.hexdigest() != digest or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError('tool identity mismatch')
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except BaseException:
        os.close(fd)
        raise

def api(path, env, ghfd):
    output = io.BytesIO()
    run_bounded([f'/proc/self/fd/{ghfd}', 'api', path], env, output, 8 * 1024 * 1024, 30, pass_fds=(ghfd,))
    return json.loads(output.getvalue())

def main():
    if os.geteuid() != 0 or sys.argv[1:] not in (['--confirm-pin-candidate'], ['--confirm-fetch-pinned-artifact']):
        raise ValueError('root and explicit release command required')
    pin_mode = sys.argv[1] == '--confirm-pin-candidate'
    if os.path.realpath(__file__) != SELF:
        raise ValueError('release controller must run from fixed path')
    request = read_controlled_json(CANDIDATE if pin_mode else PIN)
    tools = read_controlled_json(TOOLS)
    if not isinstance(tools, dict) or set(tools) != {'gh_sha256', 'verifier_sha256', 'fetcher_sha256', 'auditor_sha256', 'installer_sha256', 'bun_sha256'}:
        raise ValueError('invalid pre-pinned tools')
    self_fd = pinned_fd(SELF, tools['fetcher_sha256'], 1024 * 1024)
    os.close(self_fd)
    verify_fd = pinned_fd(VERIFY, tools['verifier_sha256'], 1024 * 1024)
    try:
        module = types.ModuleType('pinned_trim_artifact_verifier')
        source = os.read(verify_fd, 1024 * 1024 + 1)
        if len(source) > 1024 * 1024: raise ValueError('verifier too large')
        exec(compile(source, VERIFY, 'exec'), module.__dict__)
    finally: os.close(verify_fd)
    ghfd = pinned_fd(GH, tools['gh_sha256'], 512 * 1024 * 1024)
    try:
        controlled(OUT, directory=True, private=True)
        controlled(GH_CONFIG, directory=True, private=True)
        token = os.environ.get('GH_TOKEN', '')
        if not 16 <= len(token) <= 4096: raise ValueError('release credential unavailable')
        env = {'PATH': '/usr/bin:/bin', 'HOME': '/root', 'GH_CONFIG_DIR': GH_CONFIG,
               'GH_HOST': 'github.com', 'GH_PROMPT_DISABLED': '1', 'GH_TOKEN': token}
        lockfd = os.open(f'{OUT}/release.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            lock = os.fstat(lockfd)
            on_path = os.lstat(f'{OUT}/release.lock')
            if not stat.S_ISREG(lock.st_mode) or lock.st_uid != 0 or lock.st_nlink != 1 or stat.S_IMODE(lock.st_mode) != 0o600 or (lock.st_dev, lock.st_ino) != (on_path.st_dev, on_path.st_ino):
                raise ValueError('release lock identity invalid')
            fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            repo = request.get('repository', '') if isinstance(request, dict) else ''
            run_id = request.get('run_id') if isinstance(request, dict) else None
            artifact_id = request.get('artifact_id') if isinstance(request, dict) else None
            if repo != 'perfectuser21/zenithjoy-toonflow' or type(run_id) is not int or run_id < 1 or type(artifact_id) is not int or artifact_id < 1:
                raise ValueError('release pin identity invalid')
            run = api(f'repos/{repo}/actions/runs/{run_id}', env, ghfd)
            listing = api(f'repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100', env, ghfd)
            artifacts = listing.get('artifacts') if isinstance(listing, dict) else None
            if pin_mode:
                pin = module.pin_authenticated_candidate(request, run, artifacts)
                if os.path.lexists(PIN): raise ValueError('release pin exists; inspect before retry')
                controlled(os.path.dirname(PIN), directory=True)
                pinfd, pintmp = tempfile.mkstemp(prefix='.release-pin-', dir=os.path.dirname(PIN))
                with os.fdopen(pinfd, 'w') as f:
                    os.fchmod(f.fileno(), 0o600)
                    json.dump(pin, f, sort_keys=True); f.flush(); os.fsync(f.fileno())
                os.link(pintmp, PIN, follow_symlinks=False)
                directory = os.open(os.path.dirname(PIN), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
                try:
                    os.fsync(directory); os.unlink(pintmp); os.fsync(directory)
                finally: os.close(directory)
                print('已固定经认证的候选身份；不代表批准发布')
                return
            pin = request
            module.verify_github_identity(pin, run, artifacts)
            size = artifacts[0]['size_in_bytes']
            if type(size) is not int or not 0 < size <= 2 * 1024**3:
                raise ValueError('invalid artifact size')
            def free(path):
                st = os.statvfs(path)
                return st.f_bavail * st.f_frsize
            def healthy():
                return free(OUT) >= SOFT_FREE and free('/') >= SOFT_FREE
            if free(OUT) < SOFT_FREE + size or free('/') < SOFT_FREE + size:
                raise ValueError('insufficient release disk space')
            final = f'{OUT}/artifact-{artifact_id}.zip'
            receipt = f'{OUT}/verified-{artifact_id}.json'
            if os.path.lexists(final) or os.path.lexists(receipt):
                raise ValueError('release output exists; inspect before retry')
            fd, tmp = tempfile.mkstemp(prefix='.artifact-', dir=OUT)
            with os.fdopen(fd, 'w+b') as f:
                os.fchmod(f.fileno(), 0o600)
                written = run_bounded([f'/proc/self/fd/{ghfd}', 'api', f'repos/{repo}/actions/artifacts/{artifact_id}/zip'], env, f, size, 300, healthy, (ghfd,))
                if written != size: raise ValueError('artifact size mismatch')
                f.flush(); os.fsync(f.fileno()); f.seek(0)
                manifest = module.verify_release(pin, run, artifacts, f)
                f.seek(0); digest = hashlib.sha256()
                for block in iter(lambda: f.read(1024 * 1024), b''): digest.update(block)
                if 'sha256:' + digest.hexdigest() != pin['artifact_digest'] or not healthy():
                    raise ValueError('artifact or disk changed during verification')
                file_id = os.fstat(f.fileno())
            os.link(tmp, final, follow_symlinks=False)
            directory = os.open(OUT, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                os.fsync(directory); os.unlink(tmp); os.fsync(directory)
            finally: os.close(directory)
            rec = {'version': 1, 'pin': pin, 'manifest': manifest,
                   'artifactDev': str(file_id.st_dev), 'artifactIno': str(file_id.st_ino), 'artifactSize': str(file_id.st_size)}
            recfd, rectmp = tempfile.mkstemp(prefix='.receipt-', dir=OUT)
            with os.fdopen(recfd, 'w') as f:
                os.fchmod(f.fileno(), 0o600)
                json.dump(rec, f, sort_keys=True); f.flush(); os.fsync(f.fileno())
            os.link(rectmp, receipt, follow_symlinks=False)
            directory = os.open(OUT, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                os.fsync(directory); os.unlink(rectmp); os.fsync(directory)
            finally: os.close(directory)
            print('已验证固定候选 artifact；尚未安装或启用')
        finally: os.close(lockfd)
    finally: os.close(ghfd)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('固定候选校验失败，保留现场：' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
