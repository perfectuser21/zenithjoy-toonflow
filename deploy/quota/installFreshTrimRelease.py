#!/usr/bin/env python3
"""Install a verified trim release into empty paths, disabled and without overwrites.

The authenticated release pin and verified artifact must already be present.
This does not enable services, create a deployment template, or authorize release.
An interrupted transaction is retained for explicit inspection.
"""
import fcntl
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import types

BASE = '/opt/toonflow-trim-release'
SELF = BASE + '/installFreshTrimRelease.py'
VERIFY = BASE + '/verifyTrimArtifact.py'
AUDIT = BASE + '/auditInstalledTrimRelease.py'
TOOLS = '/etc/toonflow-trim/release-tools.json'
PIN = '/etc/toonflow-trim/release-pin.json'
OUT = '/var/lib/toonflow-trim-release'
RELEASE_ROOT = '/opt/toonflow-trim/releases'
CURRENT = '/opt/toonflow-trim/current'
SOFT_FREE = 3 * 1024**3
MARGIN = 128 * 1024**2
# Keep vendor definitions below /run/systemd/system so runtime masks take effect.
UNIT_DIR = '/usr/local/lib/systemd/system'
UNIT_NAMES = {'deploy/quota/toonflowTrimWorker.attested.service':'toonflowTrimWorker.service',
              'deploy/quota/toonflowTrimWorker.socket':'toonflowTrimWorker.socket',
              'deploy/quota/toonflowTrimWitness.service':'toonflowTrimWitness.service',
              'deploy/quota/toonflowTrimDocker.service':'toonflowTrimDocker.service',
              'deploy/quota/toonflowTrimContainerd.service':'toonflowTrimContainerd.service',
              'deploy/quota/toonflowTrimStore.attested.service':'toonflowTrimStore.service',
              'deploy/quota/toonflowTrimStore.socket':'toonflowTrimStore.socket'}

def root_dir(path, private=False):
    if not os.path.isabs(path) or os.path.realpath(path) != path: raise ValueError('directory path invalid')
    current = path
    while True:
        st = os.lstat(current)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022: raise ValueError('directory not root controlled')
        if current == path and private and st.st_mode & 0o077: raise ValueError('directory not private')
        if current == '/': break
        current = os.path.dirname(current)

def ensure_vendor_unit_dir():
    # The fixed parent is part of the installation contract; create only the
    # two missing vendor directories and never replace an existing entry.
    root_dir('/usr/local/lib')
    for path in ('/usr/local/lib/systemd', UNIT_DIR):
        try:
            os.mkdir(path, 0o755)
            sync_dir(os.path.dirname(path))
        except FileExistsError:
            pass
        root_dir(path)
        visible=os.stat(path); pid1=os.stat('/proc/1/root'+path)
        if (visible.st_dev,visible.st_ino)!=(pid1.st_dev,pid1.st_ino):raise ValueError('PID1 unit directory differs')

def root_open(path, private=False):
    root_dir(os.path.dirname(path))
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_nlink != 1 or before.st_mode & (0o077 if private else 0o022): raise ValueError('file not root controlled')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    st = os.fstat(fd)
    if (st.st_dev,st.st_ino,st.st_mode,st.st_uid,st.st_nlink,st.st_size) != (before.st_dev,before.st_ino,before.st_mode,before.st_uid,before.st_nlink,before.st_size):
        os.close(fd); raise ValueError('file identity changed')
    return fd

def read_small(path, limit, private=False):
    fd = root_open(path, private)
    try:
        before=os.fstat(fd)
        if before.st_size > limit: raise ValueError('file too large')
        data=bytearray()
        while True:
            block=os.read(fd,min(1024*1024,limit-len(data)+1))
            if not block: break
            data.extend(block)
            if len(data)>limit: raise ValueError('file too large')
        after=os.fstat(fd);onpath=os.lstat(path)
        if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) or (onpath.st_dev,onpath.st_ino)!=(before.st_dev,before.st_ino) or len(data)!=before.st_size: raise ValueError('file changed during read')
        return bytes(data)
    finally: os.close(fd)

def unit_not_present(name):
    output=subprocess.run(['/usr/bin/systemctl','show',name,'--property=LoadState,ActiveState,UnitFileState,MainPID,Job,FragmentPath'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=True,timeout=10).stdout
    if len(output)>32768: raise ValueError('unit state too large')
    fields={}
    for line in output.decode().splitlines():
        k,sep,v=line.partition('=')
        if not sep or k in fields: raise ValueError('unit state ambiguous')
        fields[k]=v
    if fields.get('LoadState')!='not-found' or fields.get('ActiveState')!='inactive' or fields.get('Job') or fields.get('FragmentPath') or (name.endswith('.service') and fields.get('MainPID')!='0'):
        raise ValueError('unit already exists or has a pending job')

def free_bytes(path):
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize

def healthy(paths):
    return all(free_bytes(path) >= SOFT_FREE for path in paths)

def write_bytes(f, data, paths):
    view = memoryview(data)
    while view:
        if not healthy(paths): raise ValueError('install disk below safety threshold')
        count = f.write(view[:1024*1024])
        if count is None or count <= 0: raise OSError('short install write')
        view = view[count:]

def unit_paths_clear(names):
    raw = subprocess.run(['/usr/bin/systemd-analyze','unit-paths'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=True,timeout=10,env={'PATH':'/usr/bin:/bin','HOME':'/root'}).stdout
    if len(raw)>32768:raise ValueError('unit search paths too large')
    paths=raw.decode('utf8').splitlines()
    if not paths or any(not os.path.isabs(p) for p in paths):raise ValueError('unit search paths invalid')
    if paths.count(UNIT_DIR)!=1 or paths.count('/run/systemd/system')!=1 or paths.index('/run/systemd/system')>=paths.index(UNIT_DIR):
        raise ValueError('runtime mask priority unknown')
    seen=set();scanned=0
    for root in paths:
        if not os.path.exists(root):continue
        info=os.stat(root)
        key=(info.st_dev,info.st_ino)
        if key in seen:continue
        seen.add(key)
        for name in names:
            if os.path.lexists(os.path.join(root,name)) or os.path.lexists(os.path.join(root,name+'.d')):raise ValueError('unit or drop-in already exists')
        for suffix in ('service.d','socket.d'):
            if os.path.lexists(os.path.join(root,suffix)):raise ValueError('global unit drop-in exists')
        def fail_walk(error): raise error
        for directory,subdirs,entries in os.walk(root,followlinks=False,onerror=fail_walk):
            scanned += len(subdirs)+len(entries)
            if scanned > 100000:raise ValueError('unit search tree too large')
            for entry in subdirs+entries:
                path=os.path.join(directory,entry)
                if os.path.islink(path) and os.path.basename(os.path.realpath(path)) in names:
                    raise ValueError('unit alias or dependency already exists')

def require_no_pending(directory):
    with os.scandir(directory) as entries:
        for entry in entries:
            if entry.name == 'install.pending' or (entry.name.startswith('install-') and entry.name.endswith('.pending')):
                raise ValueError('unfinished install requires inspection')

def write_exclusive(path, data, mode, paths):
    fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW|os.O_CLOEXEC,mode)
    with os.fdopen(fd,'wb') as f:
        os.fchmod(f.fileno(),mode);write_bytes(f,data,paths);f.flush();os.fsync(f.fileno())

def sync_dir(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
    try: os.fsync(fd)
    finally: os.close(fd)

def main():
    if os.geteuid()!=0 or sys.argv[1:]!=['--confirm-fresh-disabled-install'] or os.path.realpath(__file__)!=SELF: raise ValueError('root and fixed fresh-install command required')
    tools=json.loads(read_small(TOOLS,16384,True));expected={'gh_sha256','verifier_sha256','fetcher_sha256','auditor_sha256','installer_sha256','bun_sha256'}
    if not isinstance(tools,dict) or set(tools)!=expected: raise ValueError('tool pin invalid')
    loaded={}
    for path,key in ((SELF,'installer_sha256'),(VERIFY,'verifier_sha256'),(AUDIT,'auditor_sha256')):
        data=read_small(path,1024*1024)
        if hashlib.sha256(data).hexdigest()!=tools[key]: raise ValueError('installer tool mismatch')
        loaded[path]=data
    verify=types.ModuleType('pinned_trim_verifier');exec(compile(loaded[VERIFY],VERIFY,'exec'),verify.__dict__)
    audit=types.ModuleType('pinned_trim_auditor');exec(compile(loaded[AUDIT],AUDIT,'exec'),audit.__dict__)
    pin=json.loads(read_small(PIN,16384,True));artifact=pin.get('artifact_id') if isinstance(pin,dict) else None;commit=pin.get('commit') if isinstance(pin,dict) else None
    if type(artifact) is not int or artifact<1 or not isinstance(commit,str) or len(commit)!=40 or any(c not in '0123456789abcdef' for c in commit): raise ValueError('release pin invalid')
    root_dir(OUT,True);root_dir(RELEASE_ROOT);ensure_vendor_unit_dir()
    lockfd=os.open(OUT+'/release.lock',os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        lock=os.fstat(lockfd);entry=os.lstat(OUT+'/release.lock')
        if not stat.S_ISREG(lock.st_mode) or lock.st_uid!=0 or lock.st_nlink!=1 or stat.S_IMODE(lock.st_mode)!=0o600 or (lock.st_dev,lock.st_ino)!=(entry.st_dev,entry.st_ino):raise ValueError('release lock invalid')
        fcntl.flock(lockfd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        receipt=json.loads(read_small(f'{OUT}/verified-{artifact}.json',8*1024**2,True))
        if not isinstance(receipt,dict) or receipt.get('version')!=1 or receipt.get('pin')!=pin:raise ValueError('verified receipt mismatch')
        archive=f'{OUT}/artifact-{artifact}.zip';afd=root_open(archive,True)
        with os.fdopen(afd,'rb') as f:
            before=os.fstat(f.fileno())
            if str(before.st_dev)!=receipt.get('artifactDev') or str(before.st_ino)!=receipt.get('artifactIno') or str(before.st_size)!=receipt.get('artifactSize') or not 0<before.st_size<=2*1024**3:raise ValueError('artifact identity mismatch')
            manifest,members=verify.collect_install_members(pin,f)
            after=os.fstat(f.fileno())
            if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) or receipt.get('manifest')!=manifest:raise ValueError('artifact changed or receipt mismatch')
        bunfd=root_open(OUT+'/bun',True)
        try:
            st=os.fstat(bunfd)
            if st.st_size>512*1024**2:raise ValueError('runtime too large')
            digest=hashlib.sha256()
            for block in iter(lambda:os.read(bunfd,1024*1024),b''):digest.update(block)
            if digest.hexdigest()!=tools['bun_sha256']:raise ValueError('runtime digest mismatch')
            os.lseek(bunfd,0,os.SEEK_SET)
            release=RELEASE_ROOT+'/'+commit;pending=f'{OUT}/install.pending';done=f'{OUT}/install-{artifact}.installed'
            require_no_pending(OUT)
            targets=[release,CURRENT,pending,done]+[UNIT_DIR+'/'+n for n in UNIT_NAMES.values()]
            if any(os.path.lexists(p) for p in targets):raise ValueError('existing install state; inspect without overwriting')
            for name in UNIT_NAMES.values():unit_not_present(name)
            unit_paths_clear(set(UNIT_NAMES.values()))
            paths=('/',OUT,RELEASE_ROOT,UNIT_DIR)
            expected_write=st.st_size+sum(len(value) for value in members.values())+MARGIN
            if any(free_bytes(path)<SOFT_FREE+expected_write for path in paths):raise ValueError('insufficient install disk space')
            write_exclusive(pending,json.dumps({'version':1,'pin':pin}).encode(),0o600,paths);sync_dir(OUT)
            os.mkdir(release,0o755);sync_dir(RELEASE_ROOT)
            for name in ('trimWorker.js','trimStore.js','provisionTrimStore.js','captureTrimRuntimeProof.js','recoverTrimActive.js','prepareTrimCgroup.js'):
                write_exclusive(release+'/'+name,members['server/'+name],0o644,paths)
            dest=os.open(release+'/bun',os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW|os.O_CLOEXEC,0o755)
            try:
                while True:
                    if not healthy(paths):raise ValueError('install disk below safety threshold')
                    block=os.read(bunfd,1024*1024)
                    if not block:break
                    view=memoryview(block)
                    while view:
                        n=os.write(dest,view)
                        if n<=0:raise OSError('short runtime write')
                        view=view[n:]
                os.fchmod(dest,0o755);os.fsync(dest)
            finally:os.close(dest)
            sync_dir(release)
            os.symlink('releases/'+commit,CURRENT);sync_dir(os.path.dirname(CURRENT))
            for source,name in UNIT_NAMES.items():
                tmpfd,tmp=tempfile.mkstemp(prefix='.trim-unit-',dir=UNIT_DIR)
                with os.fdopen(tmpfd,'wb') as f:
                    os.fchmod(f.fileno(),0o644);write_bytes(f,members[source],paths);f.flush();os.fsync(f.fileno())
                os.link(tmp,UNIT_DIR+'/'+name,follow_symlinks=False);sync_dir(UNIT_DIR);os.unlink(tmp);sync_dir(UNIT_DIR)
            if not healthy(paths):raise ValueError('install disk below safety threshold')
            subprocess.run(['/usr/bin/systemctl','daemon-reload'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=30)
            audit.audit_locked(tools,pin,verify,artifact)
            os.link(pending,done,follow_symlinks=False);sync_dir(OUT);os.unlink(pending);sync_dir(OUT)
            print('全新候选已安装并核对，服务保持停用；尚未授权发布')
        finally:os.close(bunfd)
    finally:os.close(lockfd)

if __name__=='__main__':
    try:main()
    except Exception as error:
        print('全新安装未确认完成，保留现场：'+type(error).__name__,file=sys.stderr)
        sys.exit(1)
