#!/usr/bin/env python3
"""受信维护窗口中的持久 slice 身份检查；不控制服务，也不证明 Docker 作业终态。"""
import ctypes,hashlib,json,os,re,stat,subprocess,sys
from trimIngressCgroup import cgroup_open, safe_parent, unit_digest

def trusted_json(path):
    safe_parent(path);s=os.lstat(path)
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=0o600 or s.st_size>65536:raise ValueError('untrusted file')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    with os.fdopen(fd,'rb') as f:
        t=os.fstat(f.fileno())
        if (s.st_dev,s.st_ino)!=(t.st_dev,t.st_ino):raise ValueError('file changed')
        data=f.read(65537);after=os.fstat(f.fileno());onpath=os.lstat(path)
        if len(data)!=t.st_size or (t.st_dev,t.st_ino,t.st_size,t.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) or (onpath.st_dev,onpath.st_ino)!=(t.st_dev,t.st_ino):raise ValueError('file changed')
        return json.loads(data)

def state(name,suffix,allow_masked=False):
    if not re.fullmatch(r'[A-Za-z0-9_.@-]+\.'+suffix,name):raise ValueError('unit invalid')
    a=subprocess.run(['/usr/bin/systemctl','show',name,'-p','Id','-p','LoadState','-p','ActiveState','-p','MainPID','-p','Job','-p','ControlGroup','-p','FragmentPath','-p','DropInPaths','-p','NeedDaemonReload','-p','UnitFileState','-p','Delegate','-p','ProtectControlGroups','-p','NoNewPrivileges'],check=True,capture_output=True,text=True,timeout=10).stdout
    if len(a)>32768:raise ValueError('unit output too large')
    d={}
    for line in a.splitlines():
        k,sep,v=line.partition('=')
        if not sep or k in d:raise ValueError('unit output invalid')
        d[k]=v
    if d.get('Id')!=name or d.get('LoadState') not in (('loaded','masked') if allow_masked else ('loaded',)) or d.get('Job') or d.get('DropInPaths') or d.get('NeedDaemonReload')!='no':raise ValueError('unit not stable')
    return d

def process(pid):
    if not re.fullmatch(r'[1-9][0-9]*',pid) or int(pid)<2:raise ValueError('pid invalid')
    a=open('/proc/'+pid+'/stat').read();end=a.rfind(') ');parts=a[end+2:].split() if end>=0 else []
    if len(parts)<20 or not re.fullmatch(r'[1-9][0-9]*',parts[19]):raise ValueError('start invalid')
    return parts[19],open('/proc/'+pid+'/cgroup').read().splitlines(),os.path.realpath('/proc/'+pid+'/exe')

def require_uid(pid,expected):
    status=open('/proc/'+pid+'/status').read();uid=re.search(r'^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)',status,re.M)
    if not uid or any(x!=expected for x in uid.groups()):raise ValueError('process uid mismatch')

def require_worker_constraints(pid,unit):
    if unit.get('Delegate')!='no' or unit.get('ProtectControlGroups')!='yes' or unit.get('NoNewPrivileges')!='yes':raise ValueError('worker cgroup protection absent')
    status=open('/proc/'+pid+'/status').read()
    for key in ('CapEff','CapPrm'):
        value=re.search(r'^'+key+r':\s+([a-fA-F0-9]+)\s*$',status,re.M)
        if not value or int(value.group(1),16)!=0:raise ValueError('worker has capabilities')
    if not re.search(r'^NoNewPrivs:\s+1\s*$',status,re.M):raise ValueError('worker privilege boundary absent')

def require_worker_mounts(pid,unit):
    path='/proc/'+pid+'/mountinfo'
    raw=open(path).read()
    if len(raw)>16*1024*1024:raise ValueError('worker mountinfo too large')
    root_seen=0;libc=ctypes.CDLL(None,use_errno=True)
    def unescape(value):
        if re.search(r'\\(?!040|011|012|134)',value):raise ValueError('mount escape invalid')
        return re.sub(r'\\(040|011|012|134)',lambda m:chr(int(m.group(1),8)),value)
    for line in raw.splitlines():
        halves=line.split(' - ')
        if len(halves)!=2:raise ValueError('mountinfo invalid')
        left=halves[0].split();right=halves[1].split()
        if len(left)<6 or len(right)<3:raise ValueError('mountinfo invalid')
        if right[0]!='cgroup2':continue
        source=unescape(left[3]);target=unescape(left[4]);options=left[5].split(',')
        if ('ro' in options)==('rw' in options):raise ValueError('mount flags invalid')
        if source=='/' and target=='/sys/fs/cgroup' and 'ro' in options:root_seen+=1
        if 'rw' in options:
            expected=unit.get('ControlGroup','')+'/memory.pressure'
            if not expected.startswith('/') or source!=expected or target!='/sys/fs/cgroup'+expected:raise ValueError('writable cgroup mount not allowed')
            fd=os.open('/proc/'+pid+'/root'+target,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC)
            try:
                st=os.fstat(fd);buf=ctypes.create_string_buffer(256)
                if not stat.S_ISREG(st.st_mode) or libc.fstatfs(fd,ctypes.byref(buf))!=0 or ctypes.c_long.from_buffer(buf).value!=0x63677270:raise ValueError('pressure mount invalid')
                workerfd=cgroup_open(unit['ControlGroup'])
                try:
                    expectedfd=os.open('memory.pressure',os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=workerfd)
                    try:
                        expectedstat=os.fstat(expectedfd)
                        if not stat.S_ISREG(expectedstat.st_mode) or (st.st_dev,st.st_ino)!=(expectedstat.st_dev,expectedstat.st_ino):raise ValueError('pressure mount identity mismatch')
                    finally:os.close(expectedfd)
                finally:os.close(workerfd)
            finally:os.close(fd)
    if root_seen!=1 or open(path).read()!=raw:raise ValueError('worker cgroup mount identity changed')

def require_no_cgroup_fds(pid):
    base='/proc/'+pid+'/fd';before=sorted(os.listdir(base))
    if not before or len(before)>4096 or any(not x.isdecimal() for x in before):raise ValueError('worker fd list invalid')
    libc=ctypes.CDLL(None,use_errno=True)
    for name in before:
        path=base+'/'+name;first=os.readlink(path)
        info=open('/proc/'+pid+'/fdinfo/'+name).read()
        flags=re.findall(r'^flags:\s*([0-7]+)\s*$',info,re.M)
        if len(flags)!=1:raise ValueError('worker fd flags invalid')
        int(flags[0],8)
        fd=os.open(path,os.O_PATH|os.O_CLOEXEC)
        try:
            held=os.fstat(fd);buf=ctypes.create_string_buffer(256)
            if libc.fstatfs(fd,ctypes.byref(buf))!=0:raise ValueError('worker fd filesystem unknown')
            if ctypes.c_long.from_buffer(buf).value==0x63677270:raise ValueError('worker holds cgroup fd')
            current=os.stat(path);after=os.readlink(path)
            if (held.st_dev,held.st_ino)!=(current.st_dev,current.st_ino) or first!=after:raise ValueError('worker fd identity changed')
            again=open('/proc/'+pid+'/fdinfo/'+name).read()
            if re.findall(r'^flags:\s*([0-7]+)\s*$',again,re.M)!=flags:raise ValueError('worker fd flags changed')
        finally:os.close(fd)
    if sorted(os.listdir(base))!=before:raise ValueError('worker fd list changed')

def manifest(path):
    m=trusted_json(path);keys={'workerUnit','anchorUnit','sliceUnit','workerUnitSha256','anchorUnitSha256','sliceUnitSha256','anchorExe','anchorExeSha256','workerUid'}
    if not isinstance(m,dict) or set(m)!=keys or any(not isinstance(m[k],str) or not re.fullmatch(r'[a-f0-9]{64}',m[k]) for k in ('workerUnitSha256','anchorUnitSha256','sliceUnitSha256','anchorExeSha256')) or not re.fullmatch(r'[1-9][0-9]*',m['workerUid']):raise ValueError('manifest invalid')
    if os.path.realpath(m['anchorExe'])!=m['anchorExe'] or unit_digest(m['anchorExe'])!=m['anchorExeSha256']:raise ValueError('anchor executable changed')
    return m

def checked_unit(name,suffix,digest):
    v=state(name,suffix)
    if unit_digest(v.get('FragmentPath',''))!=digest:raise ValueError('unit digest mismatch')
    return v

def snapshot(manifest_path,out):
    m=manifest(manifest_path);w=checked_unit(m['workerUnit'],'service',m['workerUnitSha256']);a=checked_unit(m['anchorUnit'],'service',m['anchorUnitSha256']);s=checked_unit(m['sliceUnit'],'slice',m['sliceUnitSha256'])
    if any(x.get('ActiveState')!='active' for x in (w,a,s)):raise ValueError('units not active')
    wp,ap=w.get('MainPID',''),a.get('MainPID','');ws,wc,we=process(wp);ass,ac,exe=process(ap);cg=s.get('ControlGroup','');wpath=w.get('ControlGroup','');apath=a.get('ControlGroup','')
    if not cg or not wpath.startswith(cg+'/') or not apath.startswith(cg+'/') or wpath==apath or f'0::{wpath}' not in wc or f'0::{apath}' not in ac or exe!=m['anchorExe']:raise ValueError('process cgroup mismatch')
    for pid,expected in ((wp,m['workerUid']),(ap,'0')):require_uid(pid,expected)
    require_worker_constraints(wp,w);require_worker_mounts(wp,w);require_no_cgroup_fds(wp)
    fd=cgroup_open(cg)
    try:
        v=os.fstat(fd);boot=open('/proc/sys/kernel/random/boot_id').read().strip();data={'manifest':m,'bootId':boot,'slicePath':cg,'sliceDev':str(v.st_dev),'sliceIno':str(v.st_ino),'workerPid':wp,'workerStart':ws,'workerPath':wpath,'workerUnitPath':w['FragmentPath'],'anchorPid':ap,'anchorStart':ass,'anchorPath':apath}
        require_uid(wp,m['workerUid']);require_uid(ap,'0');require_worker_constraints(wp,w);require_worker_mounts(wp,w);require_no_cgroup_fds(wp)
        again=cgroup_open(cg)
        try:
            now=os.fstat(again)
            if (now.st_dev,now.st_ino)!=(v.st_dev,v.st_ino):raise ValueError('slice identity changed')
        finally:os.close(again)
        if manifest(manifest_path)!=m or state(m['workerUnit'],'service',True)!=w or state(m['anchorUnit'],'service')!=a or state(m['sliceUnit'],'slice')!=s or process(wp)!=(ws,wc,we) or process(ap)!=(ass,ac,exe):raise ValueError('identity changed')
        safe_parent(out);f=os.open(out,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
        with os.fdopen(f,'w') as h:json.dump(data,h);h.flush();os.fsync(h.fileno())
        d=os.open(os.path.dirname(out),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);os.fsync(d);os.close(d)
    finally:os.close(fd)

def walk_pids(fd,device,budget):
    result=[];budget[0]-=1
    if budget[0]<0:raise ValueError('cgroup tree too large')
    f=os.open('cgroup.procs',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
    try:
        raw=os.read(f,1024*1024+1)
        if len(raw)>1024*1024:raise ValueError('cgroup process list too large')
        for p in raw.decode().split():
            if not re.fullmatch(r'[1-9][0-9]*',p):raise ValueError('invalid process')
            result.append(p)
    finally:os.close(f)
    for name in os.listdir(fd):
        st=os.stat(name,dir_fd=fd,follow_symlinks=False)
        if stat.S_ISLNK(st.st_mode):raise ValueError('unexpected cgroup link')
        if stat.S_ISDIR(st.st_mode):
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            try:
                if os.fstat(child).st_dev!=device:raise ValueError('cgroup filesystem changed')
                result.extend(walk_pids(child,device,budget))
            finally:os.close(child)
    return result

def verify(manifest_path,snapshot_path):
    m=manifest(manifest_path);x=trusted_json(snapshot_path)
    keys={'manifest','bootId','slicePath','sliceDev','sliceIno','workerPid','workerStart','workerPath','workerUnitPath','anchorPid','anchorStart','anchorPath'}
    if not isinstance(x,dict) or set(x)!=keys or x['manifest']!=m or x['bootId']!=open('/proc/sys/kernel/random/boot_id').read().strip():raise ValueError('snapshot mismatch')
    w=state(m['workerUnit'],'service',True);a=checked_unit(m['anchorUnit'],'service',m['anchorUnitSha256']);s=checked_unit(m['sliceUnit'],'slice',m['sliceUnitSha256'])
    if w.get('ActiveState') not in ('inactive','failed') or w.get('MainPID')!='0' or w.get('UnitFileState') not in ('masked','masked-runtime') or unit_digest(x['workerUnitPath'])!=m['workerUnitSha256'] or a.get('ActiveState')!='active' or a.get('MainPID')!=x['anchorPid'] or s.get('ActiveState')!='active' or s.get('ControlGroup')!=x['slicePath'] or a.get('ControlGroup')!=x['anchorPath']:raise ValueError('unit state changed')
    try:
        if process(x['workerPid'])[0]==x['workerStart']:raise ValueError('old worker still alive')
    except FileNotFoundError:pass
    require_uid(x['anchorPid'],'0')
    ast,ac,exe=process(x['anchorPid'])
    if ast!=x['anchorStart'] or f"0::{x['anchorPath']}" not in ac or exe!=m['anchorExe']:raise ValueError('anchor identity changed')
    fd=cgroup_open(x['slicePath'])
    try:
        st=os.fstat(fd)
        if str(st.st_dev)!=x['sliceDev'] or str(st.st_ino)!=x['sliceIno']:raise ValueError('slice identity changed')
        if walk_pids(fd,st.st_dev,[10000])!=[x['anchorPid']]:raise ValueError('unknown slice process')
        again=cgroup_open(x['slicePath'])
        try:
            t=os.fstat(again)
            if (st.st_dev,st.st_ino)!=(t.st_dev,t.st_ino):raise ValueError('slice path changed')
        finally:os.close(again)
        if state(m['workerUnit'],'service',True)!=w or state(m['anchorUnit'],'service')!=a or state(m['sliceUnit'],'slice')!=s or process(x['anchorPid'])[0]!=x['anchorStart']:raise ValueError('identity drift')
    finally:os.close(fd)

if __name__=='__main__':
    try:
        if os.geteuid()!=0 or len(sys.argv)!=4 or sys.argv[1] not in ('capture','verify'):raise ValueError('usage')
        (snapshot if sys.argv[1]=='capture' else verify)(sys.argv[2],sys.argv[3]);print('slice 可见进程身份核验通过；不代表 Docker 作业已清零')
    except Exception as error:
        print('slice 未能核验：'+type(error).__name__,file=sys.stderr);sys.exit(1)
