#!/usr/bin/env python3
"""入口屏障候选：持锁运行 PID1 job 检查，成功也不自动重开入口。

正式入口保持关闭。受信窗口须禁止其他客户端、新写者及管理员迁移进程；
本程序的可见进程检查不能证明隐藏命名空间或 SCM_RIGHTS 引用不存在。
"""
import ctypes,fcntl,hashlib,json,os,pwd,re,selectors,signal,socket,sqlite3,stat,struct,subprocess,sys,time,types,uuid

ROOT='/var/lib/toonflow-trim/ingress'
READY='/run/toonflow-trim-ingress'
MANIFEST='/etc/toonflow-trim/ingressGuard.json'
GUARD='toonflowTrimIngressGuard.service'
SLICE='toonflow-trim-ingress.slice'
ANCHOR='toonflowTrimIngressAnchor.service'
GUARD_SCRIPT='/opt/toonflow-trim/current/trimIngressJobs.py'

def run(*args):
 p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,env={'PATH':'/usr/bin:/bin','HOME':'/root'})
 sel=selectors.DefaultSelector();out={p.stdout:bytearray(),p.stderr:bytearray()};deadline=time.monotonic()+10
 try:
  for f in out:os.set_blocking(f.fileno(),False);sel.register(f,selectors.EVENT_READ)
  while sel.get_map():
   remaining=deadline-time.monotonic()
   if remaining<=0:raise ValueError('command timeout; state unknown')
   for key,_ in sel.select(min(.2,remaining)):
    b=os.read(key.fd,8192)
    if not b:sel.unregister(key.fileobj);continue
    out[key.fileobj].extend(b)
    if len(out[key.fileobj])>65536:raise ValueError('command output too large')
  remaining=deadline-time.monotonic()
  if remaining<=0 or p.wait(timeout=remaining):raise ValueError('command failed; state unknown')
  return bytes(out[p.stdout]).decode('utf8').strip()
 finally:
  sel.close()
  try:
   try:os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   try:p.wait(timeout=1)
   except subprocess.TimeoutExpired:raise ValueError('command process remains; state unknown')
  finally:
   for f in out:f.close()

def runInput(secret,*args):
 if not isinstance(secret,bytes) or not 16<=len(secret)<=128:raise ValueError('bootstrap secret unavailable')
 p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True,env={'PATH':'/usr/bin:/bin','HOME':'/root'});sel=selectors.DefaultSelector();out=bytearray();deadline=time.monotonic()+30
 try:
  p.stdin.write(secret);p.stdin.close();os.set_blocking(p.stdout.fileno(),False);sel.register(p.stdout,selectors.EVENT_READ)
  while sel.get_map():
   left=deadline-time.monotonic()
   if left<=0:raise ValueError('bootstrap command timed out; outcome unknown')
   for key,_ in sel.select(min(.2,left)):
    data=os.read(key.fd,4096)
    if not data:sel.unregister(key.fileobj);continue
    out.extend(data)
    if len(out)>65536:raise ValueError('bootstrap output too large; outcome unknown')
  left=deadline-time.monotonic()
  if left<=0 or p.wait(timeout=left):raise ValueError('bootstrap command failed; outcome unknown')
  return bytes(out).decode('utf8').strip()
 finally:
  sel.close()
  try:
   try:os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   try:p.wait(timeout=1)
   except subprocess.TimeoutExpired:raise ValueError('bootstrap client remains; outcome unknown')
  finally:p.stdout.close()

def rootfile(path,secret=True):
 if not os.path.isabs(path) or os.path.normpath(path)!=path or os.path.realpath(path)!=path:raise ValueError('untrusted path')
 parent=os.path.dirname(path)
 while True:
  d=os.lstat(parent)
  if not stat.S_ISDIR(d.st_mode) or d.st_uid!=0 or d.st_mode&0o022:raise ValueError('untrusted directory')
  if parent=='/':break
  parent=os.path.dirname(parent)
 a=os.lstat(path)
 if not stat.S_ISREG(a.st_mode) or a.st_uid!=0 or a.st_nlink!=1 or a.st_size>1048576 or a.st_mode&(0o077 if secret else 0o022):raise ValueError('untrusted file')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  b=os.fstat(fd);data=os.read(fd,1048577);c=os.fstat(fd);d=os.lstat(path)
  ident=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_uid,x.st_gid,x.st_mode,x.st_nlink)
  if ident(a)!=ident(b) or ident(b)!=ident(c) or ident(c)!=ident(d) or len(data)!=b.st_size:raise ValueError('file changed')
  return data
 finally:os.close(fd)

def show(unit):
 keys='LoadState,ActiveState,SubState,UnitFileState,MainPID,Job,ControlGroup,FragmentPath,DropInPaths,NeedDaemonReload,ExecStart,Type,RemainAfterExit,TimeoutStartUSec,TimeoutStopUSec,KillMode,Slice,InvocationID,Result,ExecMainStatus'
 result=run('/usr/bin/systemctl','show',unit,'--property='+keys)
 pairs=[line.split('=',1) for line in result.splitlines()]
 if any(len(x)!=2 for x in pairs) or len(dict(pairs))!=len(pairs):raise ValueError('unit state unknown')
 return dict(pairs)

def unitIdentity(name,expected):
 v=show(name);fragment=v.get('FragmentPath','')
 if v.get('LoadState')!='loaded' or v.get('DropInPaths') or v.get('NeedDaemonReload')!='no' or hashlib.sha256(rootfile(fragment,False)).hexdigest()!=expected:raise ValueError('unit identity unknown')
 return v

def procStart(pid):
 raw=open('/proc/%d/stat'%pid).read();i=raw.rfind(') ');fields=raw[i+2:].split() if i>=0 else []
 if len(fields)<20 or not re.fullmatch(r'[1-9][0-9]*',fields[19]):raise ValueError('process start unknown')
 return fields[19]

def onlyAnchor(manifest):
 anchor=unitIdentity(ANCHOR,manifest['anchorUnitSha256']);sl=unitIdentity(SLICE,manifest['sliceUnitSha256'])
 pid=int(anchor.get('MainPID','0'));cg=anchor.get('ControlGroup','')
 if anchor.get('ActiveState')!='active' or anchor.get('Job') or pid<2 or not cg.endswith('/'+ANCHOR) or sl.get('ActiveState')!='active' or sl.get('Job') or cg.rsplit('/',1)[0]!=sl.get('ControlGroup'):raise ValueError('anchor state unknown')
 start=procStart(pid)
 if '0::'+cg not in open('/proc/%d/cgroup'%pid).read().splitlines() or os.path.realpath('/proc/%d/exe'%pid)!='/usr/bin/sleep' or hashlib.sha256(rootfile('/usr/bin/sleep',False)).hexdigest()!=manifest['anchorExeSha256']:raise ValueError('anchor identity unknown')
 root='/sys/fs/cgroup'+sl['ControlGroup'];s=os.lstat(root)
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or str(s.st_dev)!=manifest['sliceDev'] or str(s.st_ino)!=manifest['sliceIno']:raise ValueError('slice identity unknown')
 seen=[]
 def fail(error):raise error
 for path,dirs,files in os.walk(root,onerror=fail,followlinks=False):
  d=os.lstat(path)
  if not stat.S_ISDIR(d.st_mode) or d.st_uid!=0 or d.st_dev!=s.st_dev or 'cgroup.procs' not in files:raise ValueError('slice traversal unknown')
  for child in dirs:
   if os.path.islink(os.path.join(path,child)):raise ValueError('slice symlink')
  seen.extend(int(x) for x in open(path+'/cgroup.procs').read().split())
 if seen!=[pid] or procStart(pid)!=start or os.lstat(root).st_ino!=s.st_ino:raise ValueError('slice has unknown processes')

def syncdir(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)

def strictJson(data):
 def unique(pairs):
  value={}
  for key,item in pairs:
   if key in value:raise ValueError('duplicate JSON key')
   value[key]=item
  return value
 return json.loads(data,object_pairs_hook=unique)

def requireReceipts(pendingData,resultData,expectedPending,expectedResult):
 pending=strictJson(pendingData);result=strictJson(resultData)
 if not isinstance(pending,dict) or not isinstance(result,dict) or type(pending.get('version')) is not int or type(result.get('version')) is not int or pending!=expectedPending or result!=expectedResult:raise ValueError('guard receipts do not match')

def writeExclusive(path,data,mode,gid=None):
 fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,mode)
 try:
  if gid is not None:os.fchown(fd,0,gid)
  os.fchmod(fd,mode)
  with os.fdopen(fd,'wb',closefd=False) as f:f.write(data);f.flush();os.fsync(f.fileno())
 finally:os.close(fd)

def generationRead(gid,boot):
 path=ROOT+'/generation.json';before=os.lstat(path)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  current=os.fstat(fd);data=os.read(fd,4097);after=os.fstat(fd);pathAfter=os.lstat(path)
  ident=lambda s:(s.st_dev,s.st_ino,s.st_uid,s.st_gid,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns)
  if ident(before)!=ident(current) or ident(current)!=ident(after) or ident(after)!=ident(pathAfter) or not stat.S_ISREG(current.st_mode) or current.st_uid!=0 or current.st_gid!=gid or current.st_nlink!=1 or stat.S_IMODE(current.st_mode)!=0o640 or not 0<current.st_size<=4096 or len(data)!=current.st_size:raise ValueError('generation identity unknown')
 finally:os.close(fd)
 v=strictJson(data);keys={'version','state','bootId','generationId','attemptId','guardInvocationId','manifestSha256'}
 u=lambda x:isinstance(x,str) and bool(re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',x))
 if not isinstance(v,dict) or set(v)!=keys or type(v['version']) is not int or v['version']!=1 or not u(v['bootId']) or v['bootId']!=boot or not u(v['generationId']) or json.dumps(v,separators=(',',':')).encode()!=data:raise ValueError('generation schema unknown')
 if v['state']=='blocked':
  if any(v[k] is not None for k in ('attemptId','guardInvocationId','manifestSha256')):raise ValueError('blocked generation malformed')
 elif v['state']=='allowed':
  if not u(v['attemptId']) or not isinstance(v['guardInvocationId'],str) or not re.fullmatch(r'[0-9a-f]{32}',v['guardInvocationId']) or not isinstance(v['manifestSha256'],str) or not re.fullmatch(r'[0-9a-f]{64}',v['manifestSha256']):raise ValueError('allowed generation malformed')
 else:raise ValueError('generation state unknown')
 return v,data

def saveHistory(name,data):
 directory=ROOT+'/history';s=os.lstat(directory)
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or stat.S_IMODE(s.st_mode)!=0o700:raise ValueError('history directory unknown')
 writeExclusive(directory+'/'+name,data,0o600);syncdir(directory)

def publishGeneration(value,gid):
 data=json.dumps(value,separators=(',',':')).encode();tmp=ROOT+'/generation.'+str(uuid.uuid4())+'.tmp'
 writeExclusive(tmp,data,0o640,gid);os.replace(tmp,ROOT+'/generation.json');syncdir(ROOT)
 actual,readback=generationRead(gid,value['bootId'])
 if actual!=value or readback!=data:raise ValueError('generation readback mismatch')

def beginGeneration(gid,boot):
 for name in ('pending','guard.pending','guard.result'):
  if os.path.lexists(ROOT+'/'+name):raise ValueError('previous maintenance state requires reconciliation')
 old,data=generationRead(gid,boot)
 if old['state']!='allowed':raise ValueError('generation already blocked')
 verifyReady(gid,readyData(old))
 os.unlink(READY+'/ready.json')
 generation=str(uuid.uuid4());saveHistory('generation-'+generation+'.json',data)
 blocked={'version':1,'state':'blocked','bootId':boot,'generationId':generation,'attemptId':None,'guardInvocationId':None,'manifestSha256':None}
 publishGeneration(blocked,gid)
 data=json.dumps({'version':1,'bootId':boot,'generationId':generation},separators=(',',':')).encode()
 writeExclusive(ROOT+'/pending',data,0o600);syncdir(ROOT)
 if rootfile(ROOT+'/pending')!=data:raise ValueError('pending readback mismatch')

def initializeGeneration(gid,boot,pinSha256):
 # 仅建立拒绝状态；最终放行仍必须执行完整 guard。
 verifyReadyDir()
 for path in (ROOT+'/generation.json',ROOT+'/pending',ROOT+'/guard.pending',ROOT+'/guard.result',READY+'/ready.json'):
  if os.path.lexists(path):raise ValueError('existing generation requires reconciliation')
 if any(name.startswith('generation.') and name.endswith('.tmp') for name in os.listdir(ROOT)):raise ValueError('unresolved generation temporary file')
 if not isinstance(pinSha256,str) or not re.fullmatch(r'[a-f0-9]{64}',pinSha256):raise ValueError('release pin digest unknown')
 generation=str(uuid.uuid4())
 blocked={'version':1,'state':'blocked','bootId':boot,'generationId':generation,'attemptId':None,'guardInvocationId':None,'manifestSha256':None}
 # 首次建档不能覆盖可能并发出现的旧文件。
 data=json.dumps(blocked,separators=(',',':')).encode()
 writeExclusive(ROOT+'/generation.json',data,0o640,gid);syncdir(ROOT)
 if generationRead(gid,boot)[0]!=blocked:raise ValueError('initial generation readback mismatch')
 marker=json.dumps({'version':1,'bootId':boot,'generationId':generation,'pinSha256':pinSha256},separators=(',',':')).encode()
 writeExclusive(ROOT+'/pending',marker,0o600);syncdir(ROOT)
 if rootfile(ROOT+'/pending')!=marker:raise ValueError('initial pending readback mismatch')

def scanFreshVisible(worker):
 # 时点检查；受信维护窗口禁止新增写者、隐藏引用或跨 namespace 传递描述符。
 roots=('/var/lib/toonflow-trim/worker','/var/lib/toonflow-trim-docker','/var/lib/toonflow-trim-containerd','/etc/toonflow-trim/runtime-proofs')
 sockets=('/run/toonflow-trim-worker/worker.sock','/run/toonflow-trim-docker/docker.sock','/run/toonflow-trim-containerd/containerd.sock')
 proof=roots[-1]
 if os.path.lexists(proof):
  p=os.lstat(proof)
  if not stat.S_ISDIR(p.st_mode) or p.st_uid!=0 or p.st_mode&0o077 or os.listdir(proof):raise ValueError('old proof state exists or is unknown')
 def bounded(path,limit):
  with open(path,'rb') as f:data=f.read(limit+1)
  if len(data)>limit:raise ValueError('process state exceeds limit')
  return data.decode('utf8','strict')
 def relevant(path):
  path=re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),path).removesuffix(' (deleted)')
  return any(path==root or path.startswith(root+'/') for root in (*roots,*sockets))
 pids=sorted((name for name in os.listdir('/proc') if name.isdigit()),key=int)
 namespaces={};socketInodes=set()
 for pid in pids:
  prefix='/proc/'+pid
  status=bounded(prefix+'/status',262144);m=re.search(r'^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$',status,re.M)
  if not m or str(worker) in m.groups():raise ValueError('worker process exists or uid unknown')
  net=os.readlink(prefix+'/ns/net')
  if not re.fullmatch(r'net:\[[1-9][0-9]*\]',net):raise ValueError('network namespace unknown')
  if net not in namespaces:
   unix=bounded(prefix+'/net/unix',4*1024*1024)
   if not unix.startswith('Num '):raise ValueError('unix socket list unknown')
   for line in unix.splitlines()[1:]:
    row=line.split()
    if len(row)<7:raise ValueError('unix socket row malformed')
    if len(row)>7 and relevant(row[7]):
     if not re.fullmatch(r'[1-9][0-9]*',row[6]):raise ValueError('old socket inode unknown')
     socketInodes.add(row[6])
   namespaces[net]=pid
  mountinfo=bounded(prefix+'/mountinfo',8*1024*1024)
  for line in mountinfo.splitlines():
   fields=line.split()
   if len(fields)<10 or '-' not in fields:raise ValueError('mountinfo unknown')
   sep=fields.index('-')
   if sep<6 or len(fields)<=sep+2:raise ValueError('mountinfo malformed')
   if any(relevant(x) for x in (fields[3],fields[4],fields[sep+2])):raise ValueError('old runtime mount or alias remains')
  descriptors=[]
  with os.scandir(prefix+'/fd') as entries:
   for entry in entries:
    descriptors.append(entry.name)
    target=os.readlink(prefix+'/fd/'+entry.name)
    if relevant(target) or re.fullmatch(r'socket:\[([1-9][0-9]*)\]',target) and target[8:-1] in socketInodes:raise ValueError('old runtime fd remains')
  for name in ('cwd','exe'):
   try:target=os.readlink(prefix+'/'+name)
   except FileNotFoundError:
    if descriptors or bounded(prefix+'/cmdline',262144):raise ValueError('process path unknown')
    continue
   if relevant(target):raise ValueError('old runtime process path remains')
 if socketInodes:raise ValueError('old runtime socket remains')
 if pids!=sorted((name for name in os.listdir('/proc') if name.isdigit()),key=int):raise ValueError('process set changed during scan')
 for ns,pid in namespaces.items():
  if os.readlink('/proc/'+pid+'/ns/net')!=ns:raise ValueError('network namespace changed')

def requireQuotaInfo(loop):
 # Q_GETINFO 通过内核查询，不依赖 quotaon -p 的非零状态码。
 libc=ctypes.CDLL(None,use_errno=True);libc.quotactl.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_void_p];libc.quotactl.restype=ctypes.c_int
 for quotaType in (0,2):
  buf=ctypes.create_string_buffer(128)
  if libc.quotactl((0x800005<<8)|quotaType,os.fsencode(loop),0,buf)!=0:raise ValueError('fresh quota information unavailable')

def createFreshResources(boot,pinSha256):
 # 专属路径全部不可覆盖；失败仅保留 pending 和现场，不自动清理或重试。
 root='/var/lib/toonflow-trim-fresh';image=root+'/data.img';mount='/srv/toonflow-trim-fresh';worker='/var/lib/toonflow-trim/worker'
 for path in (root,mount,worker):
  if os.path.lexists(path):raise ValueError('fresh resource path already exists')
 for source in ('/proc/self/mountinfo','/proc/1/mountinfo'):
  with open(source) as f:lines=f.read(8*1024*1024+1)
  if len(lines)>8*1024*1024:raise ValueError('mount table too large')
  for line in lines.splitlines():
   fields=line.split()
   if len(fields)<10 or '-' not in fields:raise ValueError('mount table unknown')
   if fields[4] in (root,mount,worker):raise ValueError('fresh resource path has a mount')
 rootDev=os.stat('/').st_dev
 if any(os.stat(path).st_dev!=rootDev for path in ('/var/lib','/srv')):raise ValueError('fresh resource filesystems differ')
 fs=os.statvfs('/');available=fs.f_bavail*fs.f_frsize
 if available<3*1024**3+int(2.5*1024**3)+512*1024**2:raise ValueError('insufficient fresh resource space')
 os.mkdir(root,0o700);syncdir('/var/lib')
 fd=os.open(image,os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
 try:
  os.posix_fallocate(fd,0,3*1024**3);os.fsync(fd);back=os.fstat(fd)
  if not stat.S_ISREG(back.st_mode) or back.st_uid!=0 or back.st_nlink!=1 or back.st_size!=3*1024**3 or back.st_blocks*512<back.st_size:raise ValueError('backing allocation unknown')
 finally:os.close(fd)
 syncdir(root)
 loop=run('/usr/sbin/losetup','--find','--show',image)
 if not re.fullmatch(r'/dev/loop[0-9]+',loop):raise ValueError('loop identity unknown')
 device=os.stat(loop)
 if not stat.S_ISBLK(device.st_mode):raise ValueError('loop device unknown')
 loopfd=os.open(loop,os.O_RDONLY|os.O_CLOEXEC)
 try:
  info=bytearray(232);fcntl.ioctl(loopfd,0x4c05,info,True);dev,ino=struct.unpack_from('=QQ',info)
  if (dev,ino)!=(back.st_dev,back.st_ino):raise ValueError('loop backing identity mismatch')
 finally:os.close(loopfd)
 discard='/sys/block/'+os.path.basename(loop)+'/queue/discard_max_bytes'
 with open(discard,'w') as f:f.write('0\n')
 if open(discard).read().strip()!='0':raise ValueError('loop discard remains enabled')
 run('/usr/sbin/mkfs.ext4','-q','-O','quota,project','-E','nodiscard',loop)
 os.mkdir(mount,0o755);syncdir('/srv')
 run('/usr/bin/mount','-t','ext4','-o','usrquota,prjquota',loop,mount)
 mounted=os.stat(mount);now=os.stat(image)
 if mounted.st_dev!=device.st_rdev or (now.st_dev,now.st_ino,now.st_size)!=(back.st_dev,back.st_ino,back.st_size) or now.st_blocks*512<now.st_size:raise ValueError('fresh mount identity changed')
 requireQuotaInfo(loop)
 q=os.statvfs(mount);r=os.statvfs('/')
 if min(q.f_bavail*q.f_frsize,r.f_bavail*r.f_frsize)<int(2.5*1024**3):raise ValueError('fresh volume below safety threshold')
 account=pwd.getpwnam('toonflow-trim-worker')
 if account.pw_uid<1 or account.pw_gid<1:raise ValueError('worker identity unknown')
 os.mkdir(worker,0o700);os.chown(worker,account.pw_uid,account.pw_gid);syncdir(os.path.dirname(worker));ws=os.lstat(worker)
 if ws.st_uid!=account.pw_uid or ws.st_gid!=account.pw_gid or stat.S_IMODE(ws.st_mode)!=0o700 or os.listdir(worker):raise ValueError('fresh worker root unknown')
 record={'version':1,'bootId':boot,'pinSha256':pinSha256,'backingDev':str(back.st_dev),'backingIno':str(back.st_ino),'loop':loop,'loopRdev':str(device.st_rdev),'mountDev':str(mounted.st_dev),'mountIno':str(mounted.st_ino),'workerDev':str(ws.st_dev),'workerIno':str(ws.st_ino),'workerUid':str(ws.st_uid),'workerGid':str(ws.st_gid)}
 writeExclusive(root+'/fresh.json',json.dumps(record,separators=(',',':')).encode(),0o600);syncdir(root)
 return record

def verifyFreshResources(boot,pinSha256):
 root='/var/lib/toonflow-trim-fresh';image=root+'/data.img';mount='/srv/toonflow-trim-fresh';worker='/var/lib/toonflow-trim/worker'
 record=strictJson(rootfile(root+'/fresh.json'));keys={'version','bootId','pinSha256','backingDev','backingIno','loop','loopRdev','mountDev','mountIno','workerDev','workerIno','workerUid','workerGid'}
 if not isinstance(record,dict) or set(record)!=keys or type(record['version']) is not int or record['version']!=1 or record['bootId']!=boot or record['pinSha256']!=pinSha256 or not isinstance(record['loop'],str) or not re.fullmatch(r'/dev/loop[0-9]+',record['loop']) or any(not isinstance(record[k],str) or not re.fullmatch(r'[1-9][0-9]*',record[k]) for k in keys-{'version','bootId','pinSha256','loop'}):raise ValueError('fresh resource record unknown')
 back=os.lstat(image);device=os.stat(record['loop']);mounted=os.stat(mount);ws=os.lstat(worker)
 if not stat.S_ISREG(back.st_mode) or back.st_uid!=0 or back.st_nlink!=1 or stat.S_IMODE(back.st_mode)!=0o600 or back.st_size!=3*1024**3 or back.st_blocks*512<back.st_size or (str(back.st_dev),str(back.st_ino))!=(record['backingDev'],record['backingIno']) or not stat.S_ISBLK(device.st_mode) or str(device.st_rdev)!=record['loopRdev'] or (str(mounted.st_dev),str(mounted.st_ino))!=(record['mountDev'],record['mountIno']) or mounted.st_dev!=device.st_rdev:raise ValueError('fresh volume identity unknown')
 if not stat.S_ISDIR(ws.st_mode) or (str(ws.st_dev),str(ws.st_ino),str(ws.st_uid),str(ws.st_gid))!=(record['workerDev'],record['workerIno'],record['workerUid'],record['workerGid']) or stat.S_IMODE(ws.st_mode)!=0o700 or os.listdir(worker):raise ValueError('fresh worker state unknown')
 fd=os.open(record['loop'],os.O_RDONLY|os.O_CLOEXEC)
 try:
  info=bytearray(232);fcntl.ioctl(fd,0x4c05,info,True)
  if struct.unpack_from('=QQ',info)!=(back.st_dev,back.st_ino):raise ValueError('fresh loop backing changed')
 finally:os.close(fd)
 if open('/sys/block/'+os.path.basename(record['loop'])+'/queue/discard_max_bytes').read().strip()!='0' or run('/usr/bin/findmnt','-n','-o','TARGET','--target',mount)!=mount:raise ValueError('fresh mount or discard unknown')
 options=run('/usr/bin/findmnt','-n','-o','OPTIONS','--target',mount).split(',')
 if not {'usrquota','prjquota'}.issubset(options):raise ValueError('fresh quotas unknown')
 requireQuotaInfo(record['loop'])
 return record

def noFreshExternalReferences(record,quotaBound=False,appUid=None):
 # 在受信维护窗口内检查可见引用；不声称发现隐藏 namespace 或 SCM_RIGHTS 队列。
 volume=int(record['loopRdev']);backDev=int(record['backingDev']);backIno=int(record['backingIno'])
 volumePair=(os.major(volume),os.minor(volume));backPair=(os.major(backDev),os.minor(backDev))
 pids=sorted((x for x in os.listdir('/proc') if x.isdigit()),key=int)
 for pid in pids:
  if int(pid)==os.getpid():continue
  base='/proc/'+pid
  if appUid is not None:
   with open(base+'/status') as f:status=f.read(262145)
   m=re.search(r'^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$',status,re.M)
   if len(status)>262144 or not m or str(appUid) in m.groups():raise ValueError('fresh app process remains or uid unknown')
  with open(base+'/mountinfo') as f:mounts=f.read(8*1024*1024+1)
  if len(mounts)>8*1024*1024:raise ValueError('mount scan limit exceeded')
  for line in mounts.splitlines():
   fields=line.split()
   if len(fields)<10 or '-' not in fields:raise ValueError('mount scan unknown')
   m=re.fullmatch(r'([0-9]+):([0-9]+)',fields[2])
   if not m:raise ValueError('mount device unknown')
   allowed={('/','/srv/toonflow-trim-fresh')}
   if quotaBound:allowed.update({('/projectQuota','/srv/toonflow-trim-fresh/projectQuota'),('/projectQuota','/srv/toonflow-trim-quota')})
   if tuple(map(int,m.groups()))==volumePair and (fields[3],fields[4]) not in allowed:raise ValueError('fresh volume alias remains')
  with open(base+'/maps') as f:maps=f.read(8*1024*1024+1)
  if len(maps)>8*1024*1024:raise ValueError('maps scan limit exceeded')
  for line in maps.splitlines():
   fields=line.split(None,5)
   if len(fields)<5 or not re.fullmatch(r'[0-9a-fA-F]+:[0-9a-fA-F]+',fields[3]) or not fields[4].isdigit():raise ValueError('maps row unknown')
   major,minor=(int(x,16) for x in fields[3].split(':'))
   if (major,minor)==volumePair or ((major,minor)==backPair and int(fields[4])==backIno):raise ValueError('fresh volume mapping remains')
  with os.scandir(base+'/fd') as entries:
   for entry in entries:
    info=os.stat(base+'/fd/'+entry.name)
    if info.st_dev==volume or (info.st_dev,info.st_ino)==(backDev,backIno) or stat.S_ISBLK(info.st_mode) and info.st_rdev==volume:raise ValueError('fresh volume fd remains')
 if pids!=sorted((x for x in os.listdir('/proc') if x.isdigit()),key=int):raise ValueError('process set changed during fresh scan')

def validateFreshAppMounts(row,plan,purpose='app'):
 # 仅核验停止状态的候选容器；调用者仍须独立证明 daemon 与卷身份。
 keys={'appContainerId','appImageId','appUid','appGid'}
 if not isinstance(plan,dict) or set(plan)!=keys or not isinstance(plan['appContainerId'],str) or not re.fullmatch(r'[a-f0-9]{64}',plan['appContainerId']) or not isinstance(plan['appImageId'],str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',plan['appImageId']) or any(not isinstance(plan[k],str) or not re.fullmatch(r'[1-9][0-9]*',plan[k]) for k in ('appUid','appGid')):raise ValueError('fresh app plan unknown')
 commands={'app':(['/usr/local/bin/docker-entrypoint.sh'],['bun','build/server/index.js']),'migration':(['bun'],['/app/build/server/migrateBackgroundJobs.js','/app/data','--confirm-background-jobs-migration'])}
 if purpose not in commands or not isinstance(row,dict) or set(row)!={'Id','Image','Running','Restart','User','Mounts','NetworkMode','ReadonlyRootfs','CapDrop','SecurityOpt','Privileged','PidMode','Entrypoint','Cmd','Env'} or row['Id']!=plan['appContainerId'] or row['Image']!=plan['appImageId'] or row['Running'] is not False or row['Restart']!='no' or row['User']!=plan['appUid']+':'+plan['appGid'] or row['NetworkMode']!='none' or row['ReadonlyRootfs'] is not True or row['CapDrop']!=['ALL'] or row['SecurityOpt']!=['no-new-privileges'] or row['Privileged'] is not False or row['PidMode'] not in ('','private') or (row['Entrypoint'],row['Cmd'])!=commands[purpose] or not isinstance(row['Mounts'],list) or not isinstance(row['Env'],list):raise ValueError('fresh app identity unknown')
 env={}
 for item in row['Env']:
  if not isinstance(item,str) or '=' not in item:raise ValueError('fresh app environment unknown')
  key,value=item.split('=',1)
  if key in env or key not in {'PATH','NODE_ENV','BUN_RUNTIME_TRANSPILER_CACHE_PATH','BUN_INSTALL_BIN','TMPDIR','TOONFLOW_DATA_DIR','TOONFLOW_SERVER_PORT'}:raise ValueError('fresh app environment unknown')
  env[key]=value
 requiredEnv={'TMPDIR':'/app/data/tmp'}
 if purpose=='app':requiredEnv.update({'TOONFLOW_DATA_DIR':'/app/data','TOONFLOW_SERVER_PORT':'17864'})
 if any(env.get(key)!=value for key,value in requiredEnv.items()):raise ValueError('fresh app environment differs')
 expected={('/srv/toonflow-trim-fresh','/app/data'),('/srv/toonflow-trim-quota','/app/data/projectQuota')};found=set()
 for entry in row['Mounts']:
  if not isinstance(entry,dict) or entry.get('Type')!='bind' or entry.get('RW') is not True or not isinstance(entry.get('Source'),str) or not isinstance(entry.get('Destination'),str):raise ValueError('fresh app mount unknown')
  pair=(entry['Source'],entry['Destination'])
  if pair not in expected or pair in found:raise ValueError('fresh app mount differs')
  found.add(pair)
 if found!=expected:raise ValueError('fresh app mounts missing')

def verifyFreshQuotaAlias(record,appUid,appGid):
 data='/srv/toonflow-trim-fresh';source=data+'/projectQuota';alias='/srv/toonflow-trim-quota'
 d=os.lstat(data);s=os.lstat(source);a=os.lstat(alias)
 if (str(d.st_dev),str(d.st_ino))!=(record['mountDev'],record['mountIno']) or (d.st_uid,d.st_gid)!=(appUid,appGid) or not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022 or not stat.S_ISDIR(a.st_mode) or (s.st_dev,s.st_ino)!=(a.st_dev,a.st_ino) or s.st_dev!=d.st_dev:raise ValueError('fresh quota paths unknown')
 with open('/proc/self/mountinfo') as f:raw=f.read(8*1024*1024+1)
 if len(raw)>8*1024*1024:raise ValueError('quota mount table too large')
 required={('/projectQuota',source),('/projectQuota',alias)};found=[]
 for line in raw.splitlines():
  fields=line.split()
  if len(fields)<10 or '-' not in fields:raise ValueError('quota mount table unknown')
  if fields[4] in (source,alias):found.append((fields[3],fields[4]))
 if len(found)!=2 or set(found)!=required:raise ValueError('fresh quota bind mounts unknown')

def inspectFreshApp(plan,daemonUnitSha256,purpose='app'):
 # 只读 inspect；hash 必须来自已认证发布清单，不能由现场自报。
 if not isinstance(daemonUnitSha256,str) or not re.fullmatch(r'[a-f0-9]{64}',daemonUnitSha256):raise ValueError('daemon release hash unknown')
 unit='toonflowTrimDocker.service';path='/run/toonflow-trim-docker/docker.sock';root='/var/lib/toonflow-trim-docker'
 def daemonIdentity():
  v=unitIdentity(unit,daemonUnitSha256);pid=int(v.get('MainPID','0'));cg=v.get('ControlGroup','')
  if v.get('ActiveState')!='active' or v.get('Job') or pid<2 or not cg or '0::'+cg not in open('/proc/%d/cgroup'%pid).read().splitlines() or os.path.realpath('/proc/%d/exe'%pid)!=os.path.realpath('/usr/bin/dockerd'):raise ValueError('dedicated daemon process unknown')
  start=procStart(pid);args=open('/proc/%d/cmdline'%pid,'rb').read().decode().split('\0');args=[x for x in args if x]
  match=re.findall(r'argv\[\]=([^;]+) ;',v.get('ExecStart',''))
  if len(match)!=1 or match[0].strip()!=' '.join(args) or args.count('--host=unix://'+path)!=1 or args.count('--data-root='+root)!=1:raise ValueError('dedicated daemon arguments unknown')
  st=os.lstat(path);directory=os.lstat(os.path.dirname(path));data=os.lstat(root)
  if not stat.S_ISSOCK(st.st_mode) or st.st_uid!=0 or stat.S_IMODE(st.st_mode)!=0o660 or not stat.S_ISDIR(directory.st_mode) or directory.st_uid!=0 or directory.st_mode&0o022 or not stat.S_ISDIR(data.st_mode) or data.st_uid!=0 or data.st_mode&0o022:raise ValueError('dedicated daemon paths unknown')
  with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
   peer.settimeout(3);peer.connect(path);peerPid,peerUid,_=struct.unpack('3i',peer.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
  if (peerPid,peerUid)!=(pid,0) or procStart(pid)!=start:raise ValueError('dedicated daemon peer changed')
  return (pid,start,st.st_dev,st.st_ino,data.st_dev,data.st_ino)
 before=daemonIdentity()
 info=run('/usr/bin/docker','--host=unix://'+path,'info','--format','{{.DockerRootDir}} {{.CgroupDriver}} {{.LiveRestoreEnabled}}')
 if info!=root+' cgroupfs false':raise ValueError('dedicated docker info unknown')
 # The environment is checked in memory and is never logged or included in errors.
 fmt='{{json .Id}}\n{{json .Image}}\n{{json .State.Running}}\n{{json .HostConfig.RestartPolicy.Name}}\n{{json .Config.User}}\n{{json .Mounts}}\n{{json .HostConfig.NetworkMode}}\n{{json .HostConfig.ReadonlyRootfs}}\n{{json .HostConfig.CapDrop}}\n{{json .HostConfig.SecurityOpt}}\n{{json .HostConfig.Privileged}}\n{{json .HostConfig.PidMode}}\n{{json .Config.Entrypoint}}\n{{json .Config.Cmd}}\n{{json .Config.Env}}'
 if not isinstance(plan,dict) or not isinstance(plan.get('appContainerId'),str) or not re.fullmatch(r'[a-f0-9]{64}',plan['appContainerId']):raise ValueError('fresh app id unknown')
 lines=run('/usr/bin/docker','--host=unix://'+path,'inspect','--format',fmt,plan['appContainerId']).splitlines()
 if len(lines)!=15:raise ValueError('fresh app inspect output unknown')
 keys=('Id','Image','Running','Restart','User','Mounts','NetworkMode','ReadonlyRootfs','CapDrop','SecurityOpt','Privileged','PidMode','Entrypoint','Cmd','Env')
 row={key:strictJson(line) for key,line in zip(keys,lines)}
 validateFreshAppMounts(row,plan,purpose)
 if daemonIdentity()!=before:raise ValueError('dedicated daemon changed during inspect')
 return row

def noFreshRuntimeTasks(plan,migration,unitHash):
 # 独立 containerd 的任务及关联 shim 必须退出；共享 runtime 不操作。
 unit='toonflowTrimContainerd.service';address='/run/toonflow-trim-containerd/containerd.sock';root='/var/lib/toonflow-trim-containerd';state='/run/toonflow-trim-containerd'
 def identity():
  v=unitIdentity(unit,unitHash);pid=int(v.get('MainPID','0'));cg=v.get('ControlGroup','')
  if v.get('ActiveState')!='active' or v.get('Job') or pid<2 or not cg or '0::'+cg not in open('/proc/%d/cgroup'%pid).read().splitlines() or os.path.realpath('/proc/%d/exe'%pid)!=os.path.realpath('/usr/bin/containerd'):raise ValueError('dedicated containerd identity unknown')
  start=procStart(pid);args=open('/proc/%d/cmdline'%pid,'rb').read().decode().split('\0');args=[x for x in args if x];matches=re.findall(r'argv\[\]=([^;]+) ;',v.get('ExecStart',''))
  if len(matches)!=1 or matches[0].strip()!=' '.join(args):raise ValueError('dedicated containerd argv unknown')
  for key,value in (('--root',root),('--state',state),('--address',address)):
   if args.count(key)!=1 or args.index(key)+1>=len(args) or args[args.index(key)+1]!=value:raise ValueError('dedicated containerd arguments differ')
  s=os.lstat(address);r=os.lstat(root)
  if not stat.S_ISSOCK(s.st_mode) or s.st_uid!=0 or not stat.S_ISDIR(r.st_mode) or r.st_uid!=0 or r.st_mode&0o022:raise ValueError('dedicated containerd paths unknown')
  with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
   peer.settimeout(3);peer.connect(address);peerPid,peerUid,_=struct.unpack('3i',peer.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
  if (peerPid,peerUid)!=(pid,0) or procStart(pid)!=start:raise ValueError('dedicated containerd peer changed')
  return (pid,start,s.st_dev,s.st_ino,r.st_dev,r.st_ino)
 before=identity();ctr=('/usr/bin/ctr','--address',address)
 namespaces=run(*ctr,'namespaces','list','-q').splitlines()
 if len(namespaces)!=len(set(namespaces)) or len(namespaces)>128 or any(not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}',x) for x in namespaces):raise ValueError('containerd namespaces unknown')
 for namespace in namespaces:
  if run(*ctr,'--namespace',namespace,'tasks','list','-q'):raise ValueError('dedicated runtime task remains')
 ids=run('/usr/bin/docker','--host=unix:///run/toonflow-trim-docker/docker.sock','ps','-aq','--no-trunc').splitlines()
 if len(ids)!=len(set(ids)) or sorted(ids)!=sorted([plan['appContainerId'],migration]):raise ValueError('dedicated containers changed')
 pids=sorted((x for x in os.listdir('/proc') if x.isdigit()),key=int)
 for pid in pids:
  with open('/proc/'+pid+'/cmdline','rb') as f:raw=f.read(262145)
  if len(raw)>262144:raise ValueError('shim command too large')
  args=raw.decode('utf8','strict').split('\0')
  if args and os.path.basename(args[0])=='containerd-shim-runc-v2':
   try:cwd=os.readlink('/proc/'+pid+'/cwd')
   except OSError:raise ValueError('shim working directory unknown')
   if any(x in args for x in (plan['appContainerId'],migration,address,root,state)) or cwd==state or cwd.startswith(state+'/') or cwd==root or cwd.startswith(root+'/'):raise ValueError('dedicated shim remains')
 if pids!=sorted((x for x in os.listdir('/proc') if x.isdigit()),key=int) or identity()!=before:raise ValueError('runtime changed during scan')

def requireFreshDatabaseAbsent():
 # 调用者必须持锁并已停写；不从部分初始化状态自动重试。
 directory='/srv/toonflow-trim-fresh/multiTenant'
 if os.path.lexists(directory):raise ValueError('database directory already exists; inspect without retry')

def readFreshDatabase(record,appUid):
 # 调用者负责先停用 app、迁移进程及所有写者，再持锁调用。
 if type(appUid) is not int or appUid<1:raise ValueError('fresh app uid unknown')
 data='/srv/toonflow-trim-fresh';directory=data+'/multiTenant'
 d=os.lstat(data);sub=os.lstat(directory)
 if (str(d.st_dev),str(d.st_ino))!=(record['mountDev'],record['mountIno']) or not stat.S_ISDIR(sub.st_mode) or sub.st_uid!=appUid or sub.st_dev!=d.st_dev or stat.S_IMODE(sub.st_mode)&0o077:raise ValueError('fresh data directory unknown')
 dirFd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
 heldDir=os.fstat(dirFd)
 if (heldDir.st_dev,heldDir.st_ino,heldDir.st_uid,heldDir.st_mode)!=(sub.st_dev,sub.st_ino,sub.st_uid,sub.st_mode):os.close(dirFd);raise ValueError('fresh data directory changed')
 def noAuxiliary():
  for suffix in ('-wal','-shm','-journal'):
   try:os.stat('multiTenant.sqlite'+suffix,dir_fd=dirFd,follow_symlinks=False)
   except FileNotFoundError:continue
   raise ValueError('sqlite auxiliary file remains')
 def opened(name,limit):
  before=os.stat(name,dir_fd=dirFd,follow_symlinks=False);fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=dirFd);held=os.fstat(fd)
  if not stat.S_ISREG(held.st_mode) or held.st_uid!=appUid or held.st_dev!=d.st_dev or held.st_nlink!=1 or stat.S_IMODE(held.st_mode)&0o077 or held.st_size>limit or (before.st_dev,before.st_ino)!=(held.st_dev,held.st_ino):os.close(fd);raise ValueError('fresh database file identity unknown')
  return fd,held
 try:
  noAuxiliary();sourceFd,sourceStat=opened('dataSource.json',65536)
  try:
   raw=os.read(sourceFd,65537);sourceAfter=os.fstat(sourceFd);sourceVisible=os.stat('dataSource.json',dir_fd=dirFd,follow_symlinks=False)
   if len(raw)!=sourceStat.st_size or strictJson(raw)!={'provider':'sqlite','sqlite':{'file':'multiTenant.sqlite'}} or (sourceAfter.st_dev,sourceAfter.st_ino,sourceAfter.st_size,sourceAfter.st_mtime_ns)!=(sourceStat.st_dev,sourceStat.st_ino,sourceStat.st_size,sourceStat.st_mtime_ns) or (sourceVisible.st_dev,sourceVisible.st_ino)!=(sourceStat.st_dev,sourceStat.st_ino):raise ValueError('fresh data source unknown')
  finally:os.close(sourceFd)
  dbFd,dbStat=opened('multiTenant.sqlite',4*1024**3)
  try:
   connection=sqlite3.connect('file:/proc/self/fd/'+str(dbFd)+'?mode=ro&immutable=1',uri=True)
   try:
    if connection.execute('PRAGMA quick_check').fetchone()!=('ok',):raise ValueError('fresh database integrity unknown')
    tables={r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not {'multiTenantAdmin','multiTenantBackgroundJob'}.issubset(tables) or connection.execute('SELECT count(*) FROM "multiTenantAdmin"').fetchone()!=(1,):raise ValueError('fresh database schema unknown')
    expected={'multiTenantAdmin':{'id':'INTEGER','userName':'TEXT','passwordHash':'TEXT','sessionHash':'TEXT','sessionExpiresAt':'INTEGER','failedAttempts':'INTEGER','lockedUntil':'INTEGER'},'multiTenantBackgroundJob':{'jobId':'TEXT','ownerId':'TEXT','workspaceHash':'TEXT','payload':'TEXT','revision':'INTEGER','leaseOwner':'TEXT','leaseUntil':'INTEGER','leaseGeneration':'INTEGER'}}
    for table,columns in expected.items():
     actual={row[1]:row[2].upper() for row in connection.execute('PRAGMA table_info("'+table+'")')}
     if actual!=columns:raise ValueError('fresh database columns unknown')
    rows=connection.execute('SELECT jobId,ownerId,workspaceHash,payload,revision,leaseOwner,leaseUntil,leaseGeneration FROM "multiTenantBackgroundJob" LIMIT 2').fetchall()
    if len(rows)!=1 or rows[0][:3]!=('00000000-0000-4000-8000-000000000001','system','0'*64) or not isinstance(rows[0][3],str) or strictJson(rows[0][3])!={'kind':'backgroundBudget','reservations':[]} or rows[0][4:]!=(1,None,0,0):raise ValueError('fresh background budget is not empty')
   finally:connection.close()
   after=os.fstat(dbFd);visible=os.stat('multiTenant.sqlite',dir_fd=dirFd,follow_symlinks=False)
   if (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)!=(dbStat.st_dev,dbStat.st_ino,dbStat.st_size,dbStat.st_mtime_ns) or (visible.st_dev,visible.st_ino)!=(dbStat.st_dev,dbStat.st_ino):raise ValueError('fresh sqlite changed')
  finally:os.close(dbFd)
  noAuxiliary();afterDir=os.fstat(dirFd);visibleDir=os.lstat(directory)
  if (afterDir.st_dev,afterDir.st_ino,afterDir.st_uid,afterDir.st_mode)!=(sub.st_dev,sub.st_ino,sub.st_uid,sub.st_mode) or (visibleDir.st_dev,visibleDir.st_ino,visibleDir.st_uid,visibleDir.st_mode)!=(sub.st_dev,sub.st_ino,sub.st_uid,sub.st_mode):raise ValueError('fresh data directory changed')
 finally:os.close(dirFd)
 return {'dataDev':str(d.st_dev),'dataIno':str(d.st_ino),'sqliteDev':str(dbStat.st_dev),'sqliteIno':str(dbStat.st_ino),'sourceSha256':hashlib.sha256(raw).hexdigest()}

def holdReleaseLock():
 out='/var/lib/toonflow-trim-release'
 for directory in ('/','/var','/var/lib',out):
  s=os.lstat(directory)
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022 or os.path.realpath(directory)!=directory or directory==out and s.st_mode&0o077:raise ValueError('release lock directory unknown')
 lockPath=out+'/release.lock';before=os.lstat(lockPath);fd=os.open(lockPath,os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
 try:
  held=os.fstat(fd);after=os.lstat(lockPath)
  if not stat.S_ISREG(held.st_mode) or held.st_uid!=0 or held.st_nlink!=1 or stat.S_IMODE(held.st_mode)!=0o600 or (before.st_dev,before.st_ino)!=(held.st_dev,held.st_ino) or (after.st_dev,after.st_ino)!=(held.st_dev,held.st_ino):raise ValueError('release lock identity unknown')
  fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);return fd
 except BaseException:os.close(fd);raise

def checkFreshBootstrap(boot,gid,manifest,releaseLock=None):
 owned=releaseLock is None
 if owned:releaseLock=holdReleaseLock()
 else:
  held=os.fstat(releaseLock);visible=os.lstat('/var/lib/toonflow-trim-release/release.lock')
  if not stat.S_ISREG(held.st_mode) or held.st_uid!=0 or held.st_nlink!=1 or stat.S_IMODE(held.st_mode)!=0o600 or (held.st_dev,held.st_ino)!=(visible.st_dev,visible.st_ino):raise ValueError('release lock changed')
  fcntl.flock(releaseLock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 try:
  pinBytes=rootfile('/etc/toonflow-trim/release-pin.json');pin=strictJson(pinBytes);artifact=pin.get('artifact_id') if isinstance(pin,dict) else None
  if type(artifact) is not int or artifact<1:raise ValueError('release pin unknown')
  receipt=strictJson(rootfile('/var/lib/toonflow-trim-release/verified-'+str(artifact)+'.json'))
  if not isinstance(receipt,dict) or receipt.get('version')!=1 or receipt.get('pin')!=pin or not isinstance(receipt.get('manifest'),dict):raise ValueError('release receipt unknown')
  toolsBytes=rootfile('/etc/toonflow-trim/release-tools.json');tools=strictJson(toolsBytes)
  requiredTools={'gh_sha256','verifier_sha256','fetcher_sha256','auditor_sha256','installer_sha256','bun_sha256'}
  if not isinstance(tools,dict) or set(tools)!=requiredTools or any(not isinstance(x,str) or not re.fullmatch(r'[a-f0-9]{64}',x) for x in tools.values()):raise ValueError('release tools pin unknown')
  base='/opt/toonflow-trim-release';verifierBytes=rootfile(base+'/verifyTrimArtifact.py',False);auditorBytes=rootfile(base+'/auditInstalledTrimRelease.py',False)
  if hashlib.sha256(verifierBytes).hexdigest()!=tools['verifier_sha256'] or hashlib.sha256(auditorBytes).hexdigest()!=tools['auditor_sha256']:raise ValueError('release verifier identity unknown')
  verifier=types.ModuleType('trim_bootstrap_verifier');exec(compile(verifierBytes,base+'/verifyTrimArtifact.py','exec'),verifier.__dict__)
  auditor=types.ModuleType('trim_bootstrap_auditor');exec(compile(auditorBytes,base+'/auditInstalledTrimRelease.py','exec'),auditor.__dict__)
  archive='/var/lib/toonflow-trim-release/artifact-'+str(artifact)+'.zip';archiveBefore=os.lstat(archive)
  if not stat.S_ISREG(archiveBefore.st_mode) or archiveBefore.st_uid!=0 or archiveBefore.st_nlink!=1 or archiveBefore.st_mode&0o077 or (str(archiveBefore.st_dev),str(archiveBefore.st_ino),str(archiveBefore.st_size))!=(receipt.get('artifactDev'),receipt.get('artifactIno'),receipt.get('artifactSize')) or not 0<archiveBefore.st_size<=2*1024**3:raise ValueError('release archive identity unknown')
  archiveFd=os.open(archive,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
  with os.fdopen(archiveFd,'rb') as f:
   held=os.fstat(f.fileno())
   if (held.st_dev,held.st_ino,held.st_size)!=(archiveBefore.st_dev,archiveBefore.st_ino,archiveBefore.st_size):raise ValueError('release archive changed')
   actualManifest=verifier.verify_artifact_contents(pin,f);after=os.fstat(f.fileno());visible=os.lstat(archive)
   if actualManifest!=receipt['manifest'] or (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)!=(held.st_dev,held.st_ino,held.st_size,held.st_mtime_ns) or (visible.st_dev,visible.st_ino)!=(held.st_dev,held.st_ino):raise ValueError('release archive changed during verification')
  commit=pin.get('commit')
  if not isinstance(commit,str) or not re.fullmatch(r'[a-f0-9]{40}',commit):raise ValueError('release commit unknown')
  release='/opt/toonflow-trim/releases/'+commit;current='/opt/toonflow-trim/current';linkInfo=os.lstat(current)
  if not stat.S_ISLNK(linkInfo.st_mode) or linkInfo.st_uid!=0 or os.path.realpath(current)!=release:raise ValueError('installed release link unknown')
  installed={name:auditor.read_root(path,16*1024**2)[0] for name,path in auditor.UNIT_PATHS.items()}
  for name in ('trimWorker.js','trimStore.js','provisionTrimStore.js','captureTrimRuntimeProof.js','recoverTrimActive.js','prepareTrimCgroup.js'):
   installed['server/'+name]=auditor.read_root(release+'/'+name,16*1024**2)[0]
  verifier.verify_installed_bytes(actualManifest,installed)
  if auditor.hash_root(release+'/bun',512*1024**2)!=tools['bun_sha256']:raise ValueError('installed runtime unknown')
  generation,_=generationRead(gid,boot);pending=strictJson(rootfile(ROOT+'/pending'))
  if generation['state']!='blocked' or pending!={'version':1,'bootId':boot,'generationId':generation['generationId'],'pinSha256':hashlib.sha256(pinBytes).hexdigest()} or os.path.lexists(ROOT+'/guard.pending') or os.path.lexists(ROOT+'/bootstrap.attempt') or os.path.lexists(READY+'/ready.json'):raise ValueError('bootstrap is not blocked or a prior attempt exists')
  required={'toonflowTrimWorker.service','toonflowTrimWorker.socket','toonflowTrimStore.service','toonflowTrimStore.socket'}
  if not required.issubset(manifest['blockedUnits']):raise ValueError('bootstrap entries missing')
  for unit in manifest['blockedUnits']:
   v=show(unit)
   if v.get('LoadState')!='masked' or v.get('ActiveState')!='inactive' or v.get('UnitFileState') not in ('masked','masked-runtime') or v.get('Job') or unit.endswith('.service') and v.get('MainPID')!='0':raise ValueError('bootstrap entry not blocked')
  planBytes=rootfile('/etc/toonflow-trim/freshBootstrap.json');plan=strictJson(planBytes)
  record=verifyFreshResources(boot,hashlib.sha256(pinBytes).hexdigest())
  if not isinstance(plan,dict) or type(plan.get('appUid')) is not str or type(plan.get('appGid')) is not str or not re.fullmatch(r'[1-9][0-9]*',plan['appUid']) or not re.fullmatch(r'[1-9][0-9]*',plan['appGid']):raise ValueError('bootstrap app plan unknown')
  verifyFreshQuotaAlias(record,int(plan['appUid']),int(plan['appGid']))
  requireFreshDatabaseAbsent();noFreshExternalReferences(record,True,int(plan['appUid']))
  units=receipt['manifest'].get('unit_sources_sha256')
  if not isinstance(units,dict):raise ValueError('release unit manifest unknown')
  inspectFreshApp(plan,units.get('deploy/quota/toonflowTrimDocker.service'))
  if rootfile('/etc/toonflow-trim/release-pin.json')!=pinBytes or rootfile('/etc/toonflow-trim/release-tools.json')!=toolsBytes or rootfile(base+'/verifyTrimArtifact.py',False)!=verifierBytes or rootfile(base+'/auditInstalledTrimRelease.py',False)!=auditorBytes or rootfile('/etc/toonflow-trim/freshBootstrap.json')!=planBytes or strictJson(rootfile(ROOT+'/pending'))!=pending:raise ValueError('bootstrap identity changed')
  return plan
 finally:
  if owned:os.close(releaseLock)

def setupFreshApp(plan,unitHash,secret):
 docker=('/usr/bin/docker','--host=unix:///run/toonflow-trim-docker/docker.sock');primary=None;cleanup=None;mayHaveStarted=False
 try:
  mayHaveStarted=True
  if run(*docker,'start',plan['appContainerId'])!=plan['appContainerId']:raise ValueError('app start outcome unknown')
  js='''const p=(await Bun.stdin.text()).trim(),b="http://127.0.0.1:17864",h={"content-type":"application/json",origin:b,"x-toonflow-workspace":"1"};let r,x;for(let i=0;i<50;i++){try{r=await fetch(b+"/api/multiTenant/status",{headers:h,signal:AbortSignal.timeout(1000)});break}catch(e){if(i===49)throw e;await Bun.sleep(200)}}x=await r.json();if(!r.ok||x.code!==200||x.data.configured!==false||x.data.canSetup!==true)throw Error("not fresh");r=await fetch(b+"/api/multiTenant/setup",{method:"POST",headers:h,body:JSON.stringify({userName:"admin",password:p,enabled:false})});x=await r.json();if(!r.ok||x.code!==200||x.data.enabled!==false)throw Error("setup outcome unknown");console.log("fresh setup complete");'''
  if runInput(secret,*docker,'exec','-i',plan['appContainerId'],'bun','-e',js)!='fresh setup complete':raise ValueError('setup outcome unknown')
 except BaseException as error:primary=error
 finally:
  if mayHaveStarted:
   try:run(*docker,'stop','--time=3',plan['appContainerId']);inspectFreshApp(plan,unitHash)
   except BaseException as error:cleanup=error
 if primary is not None and cleanup is not None:raise RuntimeError('setup and app stop failed; outcome unknown: '+type(primary).__name__+', '+type(cleanup).__name__) from primary
 if primary is not None:raise primary
 if cleanup is not None:raise RuntimeError('app stop outcome unknown: '+type(cleanup).__name__) from cleanup

def bootstrapFresh(boot,gid,manifest):
 # Caller holds ingress EX; all side effects are preceded by a durable attempt.
 raise ValueError('新库自举的 PID1 崩溃收敛尚未启用')
 releaseLock=holdReleaseLock();daemon='/run/toonflow-trim-docker/docker.sock';docker=('/usr/bin/docker','--host=unix://'+daemon)
 try:
  plan=checkFreshBootstrap(boot,gid,manifest,releaseLock);pinBytes=rootfile('/etc/toonflow-trim/release-pin.json');pin=strictJson(pinBytes);planBytes=rootfile('/etc/toonflow-trim/freshBootstrap.json');pendingBytes=rootfile(ROOT+'/pending')
  receipt=strictJson(rootfile('/var/lib/toonflow-trim-release/verified-'+str(pin['artifact_id'])+'.json'));unitHash=receipt['manifest']['unit_sources_sha256']['deploy/quota/toonflowTrimDocker.service']
  attempt=str(uuid.uuid4());entry={'version':1,'bootId':boot,'attemptId':attempt,'pinSha256':hashlib.sha256(pinBytes).hexdigest(),'planSha256':hashlib.sha256(planBytes).hexdigest(),'appContainerId':plan['appContainerId']}
  attemptBytes=json.dumps(entry,separators=(',',':')).encode();writeExclusive(ROOT+'/bootstrap.attempt',attemptBytes,0o600);syncdir(ROOT)
  secret=rootfile('/etc/toonflow-trim/fresh-bootstrap-secret').strip()
  if not 16<=len(secret)<=128 or any(x<33 or x>126 for x in secret):raise ValueError('bootstrap secret invalid')
  setupFreshApp(plan,unitHash,secret)
  setupBytes=json.dumps({'version':1,'attemptId':attempt,'appContainerId':plan['appContainerId']},separators=(',',':')).encode();writeExclusive(ROOT+'/bootstrap.setup',setupBytes,0o600);syncdir(ROOT)
  name='toonflow-trim-bootstrap-'+attempt
  migration=run(*docker,'create','--name',name,'--user',plan['appUid']+':'+plan['appGid'],'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--restart','no','--env','TMPDIR=/app/data/tmp','--mount','type=bind,src=/srv/toonflow-trim-fresh,dst=/app/data','--mount','type=bind,src=/srv/toonflow-trim-quota,dst=/app/data/projectQuota','--entrypoint','bun',plan['appImageId'],'/app/build/server/migrateBackgroundJobs.js','/app/data','--confirm-background-jobs-migration')
  if not re.fullmatch(r'[a-f0-9]{64}',migration):raise ValueError('migration container identity unknown')
  migrationBytes=json.dumps({'version':1,'attemptId':attempt,'containerId':migration,'image':plan['appImageId']},separators=(',',':')).encode();writeExclusive(ROOT+'/bootstrap.migration',migrationBytes,0o600);syncdir(ROOT)
  migrationPlan={**plan,'appContainerId':migration};inspectFreshApp(migrationPlan,unitHash,'migration')
  if run(*docker,'start','-a',migration)!='长视频批次存储迁移完成':raise ValueError('migration outcome unknown')
  inspectFreshApp(migrationPlan,unitHash,'migration')
  exitStatus=run(*docker,'inspect','--format','{{.State.ExitCode}} {{.State.Running}}',migration)
  if exitStatus!='0 false':raise ValueError('migration exit unknown')
  inspectFreshApp(plan,unitHash);noFreshRuntimeTasks(plan,migration,receipt['manifest']['unit_sources_sha256']['deploy/quota/toonflowTrimContainerd.service']);record=verifyFreshResources(boot,hashlib.sha256(pinBytes).hexdigest());verifyFreshQuotaAlias(record,int(plan['appUid']),int(plan['appGid']));noFreshExternalReferences(record,True,int(plan['appUid']))
  identity=readFreshDatabase(record,int(plan['appUid']))
  if rootfile('/etc/toonflow-trim/release-pin.json')!=pinBytes or rootfile('/etc/toonflow-trim/freshBootstrap.json')!=planBytes or rootfile(ROOT+'/pending')!=pendingBytes or rootfile(ROOT+'/bootstrap.attempt')!=attemptBytes or rootfile(ROOT+'/bootstrap.setup')!=setupBytes or rootfile(ROOT+'/bootstrap.migration')!=migrationBytes:raise ValueError('bootstrap identity changed')
  binding={'version':1,'dataPath':'/srv/toonflow-trim-fresh','dataDev':identity['dataDev'],'dataIno':identity['dataIno'],'appUid':plan['appUid'],'sqlitePath':'/srv/toonflow-trim-fresh/multiTenant/multiTenant.sqlite','sqliteDev':identity['sqliteDev'],'sqliteIno':identity['sqliteIno'],'appDocker':'maintenance','maintenanceRetainedContainers':[{'id':migration,'image':plan['appImageId']}],'sourceSha256':identity['sourceSha256'],'appContainerId':plan['appContainerId'],'appImageId':plan['appImageId'],'appManagement':'manual'}
  bindingBytes=json.dumps(binding,separators=(',',':')).encode();path='/etc/toonflow-trim/recoveryBinding.json';writeExclusive(path,bindingBytes,0o600);syncdir('/etc/toonflow-trim')
  if rootfile(path)!=bindingBytes:raise ValueError('bootstrap binding readback unknown')
 finally:os.close(releaseLock)

def verifyFreshRelease():
 # 复用已固定哈希的审核器及 verifier，直至建档完成都持有 release 锁。
 base='/opt/toonflow-trim-release';out='/var/lib/toonflow-trim-release'
 toolsBytes=rootfile('/etc/toonflow-trim/release-tools.json');tools=strictJson(toolsBytes)
 names={'gh_sha256','verifier_sha256','fetcher_sha256','auditor_sha256','installer_sha256','bun_sha256'}
 if not isinstance(tools,dict) or set(tools)!=names or any(not isinstance(x,str) or not re.fullmatch(r'[a-f0-9]{64}',x) for x in tools.values()):raise ValueError('release tools pin unknown')
 pinBytes=rootfile('/etc/toonflow-trim/release-pin.json');pin=strictJson(pinBytes);artifact=pin.get('artifact_id') if isinstance(pin,dict) else None
 if type(artifact) is not int or artifact<1:raise ValueError('release pin unknown')
 verifierBytes=rootfile(base+'/verifyTrimArtifact.py',False);auditorBytes=rootfile(base+'/auditInstalledTrimRelease.py',False)
 if hashlib.sha256(verifierBytes).hexdigest()!=tools['verifier_sha256'] or hashlib.sha256(auditorBytes).hexdigest()!=tools['auditor_sha256']:raise ValueError('release verifier identity unknown')
 fd=holdReleaseLock()
 try:
  verify=types.ModuleType('trim_genesis_verifier');exec(compile(verifierBytes,base+'/verifyTrimArtifact.py','exec'),verify.__dict__)
  audit=types.ModuleType('trim_genesis_auditor');exec(compile(auditorBytes,base+'/auditInstalledTrimRelease.py','exec'),audit.__dict__)
  audit.audit_locked(tools,pin,verify,artifact)
  # 仅全新部署；已有状态、socket 或 worker UID 进程不能事后追认。
  for path in ('/var/lib/toonflow-trim/worker','/run/toonflow-trim-worker/worker.sock'):
   if os.path.lexists(path):raise ValueError('worker state or socket already exists')
  worker=pwd.getpwnam('toonflow-trim-worker').pw_uid
  if worker<1:raise ValueError('worker uid unknown')
  scanFreshVisible(worker)
  if rootfile('/etc/toonflow-trim/release-pin.json')!=pinBytes or rootfile('/etc/toonflow-trim/release-tools.json')!=toolsBytes or rootfile(base+'/verifyTrimArtifact.py',False)!=verifierBytes or rootfile(base+'/auditInstalledTrimRelease.py',False)!=auditorBytes:raise ValueError('release identity changed')
  return fd,hashlib.sha256(pinBytes).hexdigest()
 except BaseException:
  os.close(fd);raise

def verifyReadyDir():
 for path in ('/run',READY):
  s=os.lstat(path)
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022 or os.path.realpath(path)!=path or path==READY and stat.S_IMODE(s.st_mode)!=0o755:raise ValueError('ready directory unknown')
 run=os.stat('/run');pid1=os.stat('/proc/1/root/run');ready=os.stat(READY);pid1Ready=os.stat('/proc/1/root'+READY)
 if ready.st_dev!=run.st_dev or (ready.st_dev,ready.st_ino)!=(pid1Ready.st_dev,pid1Ready.st_ino):raise ValueError('ready directory mount unknown')
 matches=[]
 with open('/proc/self/mountinfo') as f:
  for line in f:
   fields=line.split()
   if len(fields)>4 and fields[4]==READY:raise ValueError('ready directory is a mount point')
   if len(fields)>6 and fields[4]=='/run':
    if '-' not in fields:raise ValueError('run mount unknown')
    i=fields.index('-')
    if i<6 or len(fields)<=i+1:raise ValueError('run mount malformed')
    matches.append(fields[i+1])
 if (run.st_dev,run.st_ino)!=(pid1.st_dev,pid1.st_ino) or matches!=['tmpfs']:raise ValueError('run mount is not PID1 tmpfs')

def verifyReady(gid,data):
 verifyReadyDir();path=READY+'/ready.json';s=os.lstat(path)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_gid!=gid or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=0o640 or rootfile(path,False)!=data:raise ValueError('ready token unknown')

def readyData(generation):
 verifyReadyDir();run=os.stat('/run');ready=os.stat(READY)
 value={'generation':generation,'runDev':str(run.st_dev),'runIno':str(run.st_ino),'readyDev':str(ready.st_dev),'readyIno':str(ready.st_ino)}
 return json.dumps(value,separators=(',',':')).encode()

def commitGeneration(gid,boot,blocked,sourcePendingBytes,pendingBytes,resultBytes,expectedPending,expectedResult):
 if generationRead(gid,boot)[0]!=blocked or blocked['state']!='blocked':raise ValueError('blocked generation changed')
 if rootfile(ROOT+'/pending')!=sourcePendingBytes or rootfile(ROOT+'/guard.pending')!=pendingBytes or rootfile(ROOT+'/guard.result')!=resultBytes:raise ValueError('receipt changed before commit')
 requireReceipts(pendingBytes,resultBytes,expectedPending,expectedResult)
 attempt=expectedPending['attemptId']
 for name,data in (('pending',sourcePendingBytes),('guard.pending',pendingBytes),('guard.result',resultBytes)):
  saveHistory(attempt+'-'+name,data)
 allowed={'version':1,'state':'allowed','bootId':boot,'generationId':blocked['generationId'],'attemptId':attempt,'guardInvocationId':expectedResult['invocationId'],'manifestSha256':expectedPending['manifestSha256']}
 publishGeneration(allowed,gid)
 verifyReadyDir()
 if os.path.lexists(READY+'/ready.json'):raise ValueError('previous ready token exists')
 for name in ('guard.result','guard.pending','pending'):
  os.unlink(ROOT+'/'+name);syncdir(ROOT)
 data=readyData(allowed)
 # 完整令牌先落临时文件，再不覆盖发布；多链接或部分文件均被读取端拒绝。
 tmp=READY+'/ready.'+str(uuid.uuid4())+'.tmp'
 writeExclusive(tmp,data,0o640,gid)
 os.link(tmp,READY+'/ready.json',follow_symlinks=False)
 os.unlink(tmp)
 verifyReady(gid,data)

# 持久 pending、入口隔离和 PID1 生命周期集成尚未完成独立验收。
raise SystemExit('裁剪入口 PID1 控制器尚未启用')

if os.geteuid()!=0 or sys.argv[1:] not in (['--initialize-ingress-maintenance'],['--check-fresh-bootstrap'],['--bootstrap-fresh'],['--begin-ingress-maintenance'],['--confirm-ingress-maintenance']):raise SystemExit('需要 root 和维护确认')
initialize=sys.argv[1:] == ['--initialize-ingress-maintenance']
bootstrapCheck=sys.argv[1:] == ['--check-fresh-bootstrap']
bootstrap=sys.argv[1:] == ['--bootstrap-fresh']
begin=sys.argv[1:] == ['--begin-ingress-maintenance']
lock=None;success=False
try:
 manifestBytes=rootfile(MANIFEST);manifest=strictJson(manifestBytes);keys={'version','guardUnitSha256','guardScriptSha256','sliceUnitSha256','anchorUnitSha256','anchorExeSha256','sliceDev','sliceIno','lockDev','lockIno','blockedUnits'}
 if not isinstance(manifest,dict) or set(manifest)!=keys or type(manifest['version']) is not int or manifest['version']!=1 or any(not isinstance(manifest[k],str) or not re.fullmatch(r'[a-f0-9]{64}',manifest[k]) for k in ('guardUnitSha256','guardScriptSha256','sliceUnitSha256','anchorUnitSha256','anchorExeSha256')) or any(not isinstance(manifest[k],str) or not re.fullmatch(r'[1-9][0-9]*',manifest[k]) for k in ('sliceDev','sliceIno','lockDev','lockIno')):raise ValueError('manifest unknown')
 if not isinstance(manifest['blockedUnits'],list) or not manifest['blockedUnits'] or len(manifest['blockedUnits'])>32 or len(set(manifest['blockedUnits']))!=len(manifest['blockedUnits']) or any(not isinstance(u,str) or not re.fullmatch(r'[A-Za-z0-9_.@-]+\.(?:service|socket)',u) or u in (GUARD,ANCHOR) for u in manifest['blockedUnits']):raise ValueError('blocked units unknown')
 bindingBytes=windowBytes=None
 if not initialize and not bootstrapCheck and not bootstrap:
  bindingBytes=rootfile('/etc/toonflow-trim/recoveryBinding.json');windowBytes=rootfile('/etc/toonflow-trim/maintenanceWindow.json');binding=strictJson(bindingBytes);window=strictJson(windowBytes)
  app=binding.get('appUnit');quota=window.get('quotaUnit')
  if binding.get('appDocker')!='maintenance' or not isinstance(quota,str) or not re.fullmatch(r'[A-Za-z0-9_.@-]+\.service',quota):raise ValueError('application or quota binding unknown')
  required={quota,'toonflowTrimStore.service','toonflowTrimStore.socket'}
  if binding.get('appManagement')=='manual':
   if app is not None or window.get('appUnit') is not None or window.get('appManagement')!='manual' or not isinstance(window.get('additionalRuntime'),dict) or window.get('manualAppId')!=binding.get('appContainerId') or window.get('manualAppImage')!=binding.get('appImageId') or not isinstance(binding.get('appContainerId'),str) or not re.fullmatch(r'[a-f0-9]{64}',binding['appContainerId']) or not isinstance(binding.get('appImageId'),str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',binding['appImageId']):raise ValueError('manual application binding unknown')
  else:
   if binding.get('appManagement') not in (None,'unit') or window.get('appManagement') not in (None,'unit') or not isinstance(app,str) or not re.fullmatch(r'[A-Za-z0-9_.@-]+\.service',app) or window.get('appUnit')!=app:raise ValueError('application unit binding unknown')
   required.add(app)
  if not required.issubset(manifest['blockedUnits']):raise ValueError('required client units missing')
 before=os.lstat(ROOT+'/access.lock');lock=os.open(ROOT+'/access.lock',os.O_RDWR|os.O_NOFOLLOW);held=os.fstat(lock);current=os.lstat(ROOT+'/access.lock')
 if not stat.S_ISREG(held.st_mode) or held.st_uid!=0 or held.st_nlink!=1 or stat.S_IMODE(held.st_mode)!=0o640 or (str(held.st_dev),str(held.st_ino))!=(manifest['lockDev'],manifest['lockIno']) or (before.st_dev,before.st_ino)!=(held.st_dev,held.st_ino) or (current.st_dev,current.st_ino)!=(held.st_dev,held.st_ino):raise ValueError('lock identity unknown')
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 bootId=open('/proc/sys/kernel/random/boot_id').read().strip()
 if initialize:
  releaseLock,pinSha256=verifyFreshRelease()
  try:
   initializeGeneration(held.st_gid,bootId,pinSha256)
   createFreshResources(bootId,pinSha256)
  finally:os.close(releaseLock)
  os.close(lock);lock=None
  print('首次入口代际已阻断；pending 保留')
  sys.exit(0)
 if bootstrapCheck:
  checkFreshBootstrap(bootId,held.st_gid,manifest)
  os.close(lock);lock=None
  print('新库初始化前检查完成；pending 保留，尚未初始化')
  sys.exit(0)
 if bootstrap:
  bootstrapFresh(bootId,held.st_gid,manifest)
  os.close(lock);lock=None
  print('新库绑定已登记；pending 保留，入口仍关闭')
  sys.exit(0)
 if begin:
  beginGeneration(held.st_gid,bootId)
  os.close(lock);lock=None
  print('入口代际已阻断；pending 保留')
  sys.exit(0)
 sourcePendingBytes=rootfile(ROOT+'/pending')
 blocked,_=generationRead(held.st_gid,bootId);sourceMarker=strictJson(sourcePendingBytes)
 markerBase={'version':1,'bootId':bootId,'generationId':blocked['generationId']}
 pinBefore=rootfile('/etc/toonflow-trim/release-pin.json') if isinstance(sourceMarker,dict) and 'pinSha256' in sourceMarker else None
 if blocked['state']!='blocked' or not isinstance(sourceMarker,dict) or type(sourceMarker.get('version')) is not int or (sourceMarker!=markerBase and (pinBefore is None or sourceMarker!={**markerBase,'pinSha256':hashlib.sha256(pinBefore).hexdigest()})):raise ValueError('pending generation mismatch')
 for unit in manifest['blockedUnits']:
  v=show(unit)
  if v.get('LoadState')!='masked' or v.get('ActiveState')!='inactive' or v.get('UnitFileState') not in ('masked','masked-runtime') or v.get('Job') or unit.endswith('.service') and v.get('MainPID')!='0':raise ValueError('known entry not stopped and masked')
 g=unitIdentity(GUARD,manifest['guardUnitSha256'])
 if g.get('ActiveState')!='inactive' or g.get('Job') or g.get('Type')!='oneshot' or g.get('RemainAfterExit')!='yes' or g.get('KillMode')!='control-group' or g.get('Slice')!=SLICE or g.get('TimeoutStartUSec')!='20s' or g.get('TimeoutStopUSec')!='2s' or hashlib.sha256(rootfile(GUARD_SCRIPT,False)).hexdigest()!=manifest['guardScriptSha256']:raise ValueError('guard unit identity unknown')
 commands=re.findall(r'argv\[\]=([^;]+) ;',g.get('ExecStart',''))
 if len(commands)!=1 or commands[0].strip()!='/usr/bin/python3 '+GUARD_SCRIPT+' --confirm-ingress-maintenance':raise ValueError('guard argv unknown')
 onlyAnchor(manifest)
 if os.path.lexists(ROOT+'/guard.result'):raise ValueError('previous guard result requires reconciliation')
 sourcePending=os.lstat(ROOT+'/pending');rootfile(ROOT+'/pending');sourceAgain=os.lstat(ROOT+'/pending')
 if (sourcePending.st_dev,sourcePending.st_ino)!=(sourceAgain.st_dev,sourceAgain.st_ino):raise ValueError('pending identity changed')
 attemptId=str(uuid.uuid4())
 pending=ROOT+'/guard.pending';expectedPending={'version':1,'bootId':bootId,'attemptId':attemptId,'guardUnit':GUARD,'pendingDev':str(sourcePending.st_dev),'pendingIno':str(sourcePending.st_ino),'manifestSha256':hashlib.sha256(manifestBytes).hexdigest()};pendingBytes=json.dumps(expectedPending).encode();fd=os.open(pending,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(pendingBytes);f.flush();os.fsync(f.fileno());guardPending=os.fstat(f.fileno())
 syncdir(ROOT)
 run('/usr/bin/systemctl','start','--no-block',GUARD)
 deadline=time.monotonic()+25
 while True:
  v=show(GUARD)
  if v.get('ActiveState')=='active' and v.get('SubState')=='exited' and not v.get('Job'):break
  if v.get('ActiveState')=='failed' or time.monotonic()>=deadline:raise ValueError('guard failed or timed out; pending retained')
  time.sleep(.1)
 if v.get('Result')!='success' or v.get('ExecMainStatus')!='0' or not re.fullmatch(r'[a-f0-9]{32}',v.get('InvocationID','')) or v['InvocationID']==g.get('InvocationID'):raise ValueError('guard invocation unknown')
 invocation=v['InvocationID'];run('/usr/bin/systemctl','stop',GUARD)
 v=unitIdentity(GUARD,manifest['guardUnitSha256'])
 if v.get('ActiveState')!='inactive' or v.get('MainPID')!='0' or v.get('Job'):raise ValueError('guard stop unknown')
 onlyAnchor(manifest);afterPendingBytes=rootfile(ROOT+'/pending');afterPending=os.lstat(ROOT+'/pending');guardPendingBytes=rootfile(pending);guardPendingAfter=os.lstat(pending)
 if afterPendingBytes!=sourcePendingBytes or guardPendingBytes!=pendingBytes or (afterPending.st_dev,afterPending.st_ino)!=(sourcePending.st_dev,sourcePending.st_ino) or (guardPendingAfter.st_dev,guardPendingAfter.st_ino)!=(guardPending.st_dev,guardPending.st_ino) or rootfile(MANIFEST)!=manifestBytes or rootfile('/etc/toonflow-trim/recoveryBinding.json')!=bindingBytes or rootfile('/etc/toonflow-trim/maintenanceWindow.json')!=windowBytes:raise ValueError('maintenance identity changed')
 if pinBefore is not None and rootfile('/etc/toonflow-trim/release-pin.json')!=pinBefore:raise ValueError('release pin changed')
 if pinBefore is not None:noFreshExternalReferences(verifyFreshResources(bootId,hashlib.sha256(pinBefore).hexdigest()))
 for unit in manifest['blockedUnits']:
  v=show(unit)
  if v.get('LoadState')!='masked' or v.get('ActiveState')!='inactive' or v.get('UnitFileState') not in ('masked','masked-runtime') or v.get('Job') or unit.endswith('.service') and v.get('MainPID')!='0':raise ValueError('known entry changed')
 result=ROOT+'/guard.result';expectedResult={'version':1,'bootId':bootId,'attemptId':attemptId,'invocationId':invocation};fd=os.open(result,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:json.dump(expectedResult,f);f.flush();os.fsync(f.fileno())
 syncdir(ROOT)
 requireReceipts(rootfile(pending),rootfile(result),expectedPending,expectedResult)
 if pinBefore is not None:raise ValueError('首次 app/store 挂载、配额与运行时绑定尚未启用')
 commitGeneration(held.st_gid,bootId,blocked,sourcePendingBytes,pendingBytes,rootfile(result),expectedPending,expectedResult)
 success=True
except Exception as error:
 print('入口检查失败，结果未知；须读回实际状态: '+type(error).__name__+': '+str(error),file=sys.stderr);sys.exit(1)
finally:
 if lock is not None:os.close(lock)
if success:print('PID1 检查与入口代际提交完成')
