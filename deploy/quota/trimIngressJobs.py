#!/usr/bin/env python3
"""裁剪入口 job/shim 屏障候选。正式入口硬关闭，禁止据此放行。

当前检查来自独立 ARM VM 演练；仍需受信首次部署清单、入口锁、
完整控制器集成和独立复审。用户数据与共享 runtime 均不得凭本候选修改。
"""
import hashlib,json,os,re,selectors,signal,stat,subprocess,sys,time

def cmd(*args):
 p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,env={'PATH':'/usr/bin:/bin','HOME':'/root','DOCKER_CONFIG':'/run/toonflow-trim-maintenance/docker-config'})
 selector=selectors.DefaultSelector();buffers={p.stdout:bytearray(),p.stderr:bytearray()};limits={p.stdout:1000000,p.stderr:100000};deadline=time.monotonic()+15
 try:
  for stream in buffers:os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ)
  while selector.get_map():
   remaining=deadline-time.monotonic()
   if remaining<=0:raise ValueError('command timed out')
   for key,_ in selector.select(min(remaining,0.25)):
    block=os.read(key.fd,65536)
    if not block:selector.unregister(key.fileobj);continue
    buffers[key.fileobj].extend(block)
    if len(buffers[key.fileobj])>limits[key.fileobj]:raise ValueError('command output too large')
  remaining=deadline-time.monotonic()
  if remaining<=0 or p.wait(timeout=remaining)!=0:raise ValueError('command result unknown')
  return bytes(buffers[p.stdout]).decode('utf8').strip()
 finally:
  selector.close()
  try:
   def groupAlive():
    try:os.killpg(p.pid,0);return True
    except ProcessLookupError:return False
    except PermissionError as error:raise ValueError('command process group status unknown') from error
   if groupAlive():
    try:os.killpg(p.pid,signal.SIGTERM)
    except ProcessLookupError:pass
    end=time.monotonic()+0.5
    while groupAlive() and time.monotonic()<end:p.poll();time.sleep(0.02)
   if groupAlive():
    try:os.killpg(p.pid,signal.SIGKILL)
    except ProcessLookupError:pass
   end=time.monotonic()+1
   while groupAlive() and time.monotonic()<end:p.poll();time.sleep(0.02)
   if p.poll() is None or groupAlive():raise ValueError('command process group remains; outcome unknown')
  finally:
   for stream in buffers:stream.close()

def checkedPath(path):
 if not isinstance(path,str) or not path.startswith('/') or os.path.normpath(path)!=path or os.path.realpath(path)!=path:raise ValueError('path identity unknown')
 return path

def readroot(path):
 checkedPath(path)
 parent=os.path.dirname(path)
 while True:
  st=os.lstat(parent)
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022:raise ValueError('untrusted parent')
  if parent=='/':break
  parent=os.path.dirname(parent)
 s=os.lstat(path)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_mode&0o077 or s.st_nlink!=1 or s.st_size>65536:raise ValueError('untrusted file')
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  q=os.fstat(fd)
  if (q.st_dev,q.st_ino,q.st_size)!=(s.st_dev,s.st_ino,s.st_size):raise ValueError('file changed')
  with os.fdopen(fd,'rb',closefd=False) as f:raw=f.read(65537)
  after=os.fstat(fd);current=os.lstat(path)
  if len(raw)!=q.st_size or (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)!=(q.st_dev,q.st_ino,q.st_size,q.st_mtime_ns) or (current.st_dev,current.st_ino)!=(q.st_dev,q.st_ino):raise ValueError('file changed while reading')
  return raw
 finally:os.close(fd)

def show(unit):
 raw=cmd('/usr/bin/systemctl','show',unit,'-p','LoadState','-p','ActiveState','-p','MainPID','-p','Job','-p','ControlGroup','-p','FragmentPath','-p','DropInPaths','-p','NeedDaemonReload','-p','ExecStart')
 return dict(line.split('=',1) for line in raw.splitlines())
def start(pid):
 raw=open('/proc/%d/stat'%pid).read();return raw[raw.rfind(') ')+2:].split()[19]

def proofPath(ready,boot):
 if not isinstance(ready,dict) or set(ready)!={'bootId','workerPid','workerStart','listenerInode','nonce'} or ready['bootId']!=boot or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',boot):raise ValueError('boot or ready record differs')
 for key in ('workerPid','workerStart','listenerInode'):
  value=ready[key]
  if not isinstance(value,str) or not re.fullmatch(r'[1-9][0-9]*',value) or len(value)>20 or int(value)>18446744073709551615:raise ValueError('ready identity unknown')
 if int(ready['workerPid'])>=4294967295 or not isinstance(ready['nonce'],str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',ready['nonce']):raise ValueError('ready identity unknown')
 return '/etc/toonflow-trim/runtime-proofs/%s-%s-%s.json'%(boot,ready['workerPid'],ready['workerStart'])

def daemon(unit,pidval,startval,root,dev,ino,socket_path,socket_dev,socket_ino,unit_hash,exe,required):
 checkedPath(root);checkedPath(socket_path);checkedPath(exe)
 f=show(unit);pid=int(f.get('MainPID','0'))
 if f.get('LoadState')!='loaded' or f.get('ActiveState')!='active' or f.get('Job') or f.get('DropInPaths') or f.get('NeedDaemonReload')!='no' or pid!=int(pidval) or start(pid)!=startval:raise ValueError('daemon unit or process differs')
 if '0::'+f['ControlGroup'] not in open('/proc/%d/cgroup'%pid).read().splitlines():raise ValueError('daemon cgroup differs')
 status=open('/proc/%d/status'%pid).read();uid=re.search(r'^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)',status,re.M)
 if not uid or any(x!='0' for x in uid.groups()):raise ValueError('daemon UID differs')
 fragment=f.get('FragmentPath','')
 checkedPath(fragment)
 frag=os.lstat(fragment)
 if not stat.S_ISREG(frag.st_mode) or frag.st_uid!=0 or frag.st_mode&0o022 or frag.st_nlink!=1:raise ValueError('daemon fragment untrusted')
 fd=os.open(fragment,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  held=os.fstat(fd);content=os.read(fd,1048577);after=os.fstat(fd);current=os.lstat(fragment)
  if held.st_size>1048576 or len(content)!=held.st_size or (held.st_dev,held.st_ino,held.st_size,held.st_mtime_ns)!=(frag.st_dev,frag.st_ino,frag.st_size,frag.st_mtime_ns) or (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)!=(held.st_dev,held.st_ino,held.st_size,held.st_mtime_ns) or (current.st_dev,current.st_ino)!=(held.st_dev,held.st_ino) or hashlib.sha256(content).hexdigest()!=unit_hash:raise ValueError('daemon unit hash differs')
 finally:os.close(fd)
 for path in (root,os.path.dirname(socket_path),os.path.dirname(fragment)):
  while True:
   item=os.lstat(path)
   if not stat.S_ISDIR(item.st_mode) or item.st_uid!=0 or item.st_mode&0o022:raise ValueError('daemon ancestor untrusted')
   if path=='/':break
   path=os.path.dirname(path)
 if os.path.realpath('/proc/%d/exe'%pid)!=os.path.realpath(exe):raise ValueError('daemon executable differs')
 args=open('/proc/%d/cmdline'%pid,'rb').read().decode().split('\0');args=[x for x in args if x]
 argv=re.search(r'argv\[\]=([^;]+) ;',f.get('ExecStart',''))
 if not argv or argv.group(1).strip()!=' '.join(args):raise ValueError('loaded daemon arguments differ')
 for expected in required:
  if args.count(expected)!=1:raise ValueError('daemon arguments differ')
 st=os.lstat(root);sock=os.lstat(socket_path)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or (str(st.st_dev),str(st.st_ino))!=(dev,ino) or not stat.S_ISSOCK(sock.st_mode) or (str(sock.st_dev),str(sock.st_ino))!=(socket_dev,socket_ino):raise ValueError('daemon root/socket differs')
 rows=[x.split() for x in open('/proc/%d/net/unix'%pid) if len(x.split())>=8 and x.split()[7]==socket_path and x.split()[3]=='00010000' and x.split()[4]=='0001']
 if len(rows)!=1 or not rows[0][6].isdigit() or int(rows[0][6])<1:raise ValueError('listener unknown')
 target='socket:['+rows[0][6]+']';fds=[os.readlink('/proc/%d/fd/%s'%(pid,x)) for x in os.listdir('/proc/%d/fd'%pid)]
 if target not in fds:raise ValueError('daemon does not hold listener')

# 不得在入口屏障、可信部署绑定和独立验收完成前移除。
raise SystemExit('裁剪 job/shim 屏障尚未启用')
if os.geteuid()!=0 or sys.argv[1:]!=['--confirm-ingress-maintenance']:raise SystemExit('需要 root 和维护确认')
try:
 if os.path.lexists('/var/lib/toonflow-trim/worker/active'):raise ValueError('active job needs explicit recovery')
 ready=json.loads(readroot('/var/lib/toonflow-trim/ingress/ready'));boot=open('/proc/sys/kernel/random/boot_id').read().strip()
 path=proofPath(ready,boot);v=json.loads(readroot(path));r=v['additionalRuntime'];p=r['proof']
 if any(str(p[k])!=str(ready[k]) for k in ('bootId','workerPid','workerStart','listenerInode','nonce')):raise ValueError('witness differs')
 daemon(r['daemonUnit'],p['daemonPid'],p['daemonStart'],r['daemonRoot'],p['daemonRootDev'],p['daemonRootIno'],r['dockerSocket'],p['dockerSocketDev'],p['dockerSocketIno'],p['daemonUnitSha256'],'/usr/bin/dockerd',['--host=unix://'+r['dockerSocket'],'--data-root='+r['daemonRoot'],'--exec-root='+r['daemonState'],'--containerd='+r['containerdSocket']])
 daemon(r['containerdUnit'],p['containerdPid'],p['containerdStart'],r['containerdRoot'],p['containerdRootDev'],p['containerdRootIno'],r['containerdSocket'],p['containerdSocketDev'],p['containerdSocketIno'],p['containerdUnitSha256'],'/usr/bin/containerd',['--root',r['containerdRoot'],'--state',r['containerdState'],'--address',r['containerdSocket']])
 d=['/usr/bin/docker','--host=unix://'+r['dockerSocket']];info=cmd(*d,'info','--format','{{.DockerRootDir}} {{.CgroupDriver}} {{.LiveRestoreEnabled}}')
 if info!=r['daemonRoot']+' cgroupfs false':raise ValueError('docker info differs')
 ids=cmd(*d,'ps','-aq','--no-trunc').splitlines();allowed=r['knownContainerIds']
 if len(ids)!=len(set(ids)) or sorted(ids)!=sorted(allowed):raise ValueError('unexpected docker container')
 denied=set(allowed);witnesses=[]
 for entry in os.scandir('/etc/toonflow-trim/runtime-proofs'):
  if not re.fullmatch(r'[a-f0-9-]+-[1-9][0-9]*-[1-9][0-9]*\.json',entry.name):raise ValueError('proof directory unknown')
  item=json.loads(readroot(entry.path))
  if set(item)!={'workerUid','additionalRuntime'}:raise ValueError('proof schema unknown')
  oldr=item['additionalRuntime'];wp=oldr['proof']
  if set(oldr)!=set(r) or set(wp)!=set(p) or entry.name!='%s-%s-%s.json'%(wp.get('bootId'),wp.get('workerPid'),wp.get('workerStart')):raise ValueError('proof schema differs')
  witnesses.append(item)
 for entry in os.scandir('/var/lib/toonflow-trim/worker'):
  if not entry.name.startswith('recovered-'):continue
  ds=entry.stat(follow_symlinks=False)
  if not stat.S_ISDIR(ds.st_mode) or str(ds.st_uid)!=str(v['workerUid']) or ds.st_mode&0o077:raise ValueError('recovered journal directory unknown')
  path=entry.path+'/lastJob.json';before=os.lstat(path)
  if not stat.S_ISREG(before.st_mode) or str(before.st_uid)!=str(v['workerUid']) or before.st_mode&0o077 or before.st_nlink!=1 or before.st_size>65536:raise ValueError('recovered journal file unknown')
  fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
  try:
   held=os.fstat(fd);raw=os.read(fd,65537);after=os.fstat(fd);current=os.lstat(path)
   if len(raw)!=held.st_size or (held.st_dev,held.st_ino,held.st_size,held.st_mtime_ns)!=(before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns) or (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)!=(held.st_dev,held.st_ino,held.st_size,held.st_mtime_ns) or (current.st_dev,current.st_ino)!=(held.st_dev,held.st_ino):raise ValueError('recovered journal changed')
   journal=json.loads(raw)
  finally:os.close(fd)
  jid=journal.get('containerId')
  if not isinstance(jid,str) or not re.fullmatch(r'[a-f0-9]{64}',jid) or entry.name!='recovered-'+str(journal.get('operationId')):raise ValueError('recovered job identity unknown')
  matches=[x for x in witnesses if x.get('workerUid')==v['workerUid'] and x.get('additionalRuntime',{}).get('proof',{}).get('nonce')==journal.get('runtimeNonce')]
  if len(matches)!=1:raise ValueError('recovered journal witness unknown')
  if any(matches[0]['additionalRuntime'].get(k)!=r.get(k) for k in r if k!='proof'):raise ValueError('recovered proof deployment differs')
  wp=matches[0]['additionalRuntime']['proof']
  if wp.get('bootId')!=boot or str(journal.get('managerPid'))!=wp.get('workerPid') or not isinstance(journal.get('startedAt'),int) or journal['startedAt']<=int(wp['capturedAt']):raise ValueError('recovered journal witness differs')
  denied.add(jid)
 binding=json.loads(readroot('/etc/toonflow-trim/recoveryBinding.json'))
 app=binding.get('appContainerId');image=binding.get('appImageId')
 if binding.get('appDocker')!='maintenance' or not isinstance(app,str) or not re.fullmatch(r'[a-f0-9]{64}',app) or not isinstance(image,str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',image) or allowed!=[app]:raise ValueError('app binding differs')
 row=cmd(*d,'inspect','--format','{{.Id}} {{.Image}} {{.State.Running}} {{.HostConfig.RestartPolicy.Name}}',app).split()
 if row!=[app,image,'false','no']:raise ValueError('app container differs')
 c=['/usr/bin/ctr','--address',r['containerdSocket']];names=cmd(*c,'namespaces','list','-q').splitlines()
 if len(names)!=len(set(names)) or any(not re.fullmatch(r'[A-Za-z0-9_.-]+',n) for n in names):raise ValueError('namespace unknown')
 for n in names:
  if cmd(*c,'--namespace',n,'tasks','list','-q'):raise ValueError('containerd task exists')
 root='/sys/fs/cgroup/toonflow-trim-jobs';st=os.lstat(root)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or not re.search(r'^populated 0$',open(root+'/cgroup.events').read(),re.M):raise ValueError('job cgroup not empty')
 sharedProof=json.loads(readroot('/etc/toonflow-trim/sharedRuntimeBaseline.json'))
 if set(sharedProof)!={'unitSha256','exeSha256','shimSha256','pid','start','socketDev','socketIno','rootDev','rootIno'}:raise ValueError('shared baseline unknown')
 for file,key in [('/usr/bin/containerd','exeSha256'),('/usr/bin/containerd-shim-runc-v2','shimSha256')]:
  if hashlib.sha256(open(file,'rb').read()).hexdigest()!=sharedProof[key]:raise ValueError('shared runtime executable differs')
 def verifyShared():daemon('containerd.service',sharedProof['pid'],sharedProof['start'],'/var/lib/containerd',sharedProof['rootDev'],sharedProof['rootIno'],'/run/containerd/containerd.sock',sharedProof['socketDev'],sharedProof['socketIno'],sharedProof['unitSha256'],'/usr/bin/containerd',[])
 verifyShared()
 window=json.loads(readroot('/etc/toonflow-trim/maintenanceWindow.json'))
 data=os.lstat(checkedPath(binding['dataPath']));back=os.lstat(checkedPath(window['backingPath']))
 if (str(data.st_dev),str(data.st_ino))!=(binding['dataDev'],binding['dataIno']) or (str(back.st_dev),str(back.st_ino))!=(window['backingDev'],window['backingIno']):raise ValueError('target volume identity changed')
 majorMinor='%d:%d'%(os.major(data.st_dev),os.minor(data.st_dev));backingDevice=back.st_dev
 def sharedSnapshot():
  namespaces=cmd('/usr/bin/ctr','--address','/run/containerd/containerd.sock','namespaces','list','-q').splitlines()
  if len(namespaces)!=len(set(namespaces)) or any(not re.fullmatch(r'[A-Za-z0-9_.-]+',n) for n in namespaces):raise ValueError('shared namespace unknown')
  tasks={}
  for namespace in namespaces:
   ids=cmd('/usr/bin/ctr','--address','/run/containerd/containerd.sock','--namespace',namespace,'tasks','list','-q').splitlines()
   if len(ids)!=len(set(ids)) or any(not re.fullmatch(r'[a-f0-9]{64}',i) or i in denied for i in ids):raise ValueError('shared task identity unknown or overlaps dedicated identity')
   for taskid in ids:
    rows=cmd('/usr/bin/ctr','--address','/run/containerd/containerd.sock','--namespace',namespace,'tasks','ps',taskid).splitlines()
    if not rows or rows[0].split()!=['PID','INFO']:raise ValueError('shared task process list unknown')
    pids=[]
    for row in rows[1:]:
     fields=row.split()
     if len(fields)!=2 or not re.fullmatch(r'[1-9][0-9]*',fields[0]):raise ValueError('shared process identity unknown')
     pid=int(fields[0]);before=start(pid);mounts=open('/proc/%d/mountinfo'%pid).read().splitlines()
     if not mounts:raise ValueError('shared mountinfo unknown')
     for line in mounts:
      fields=line.split();separator=fields.index('-') if '-' in fields else -1
      if len(fields)<10 or separator<6 or not re.fullmatch(r'[0-9]+:[0-9]+',fields[2]):raise ValueError('shared mountinfo malformed')
      if fields[2]==majorMinor:raise ValueError('shared task mounts target volume')
     for fd in os.listdir('/proc/%d/fd'%pid):
      f=os.stat('/proc/%d/fd/%s'%(pid,fd))
      if f.st_dev==data.st_dev or (f.st_dev,f.st_ino)==(back.st_dev,back.st_ino) or stat.S_ISBLK(f.st_mode) and f.st_rdev in (data.st_dev,backingDevice):raise ValueError('shared task holds target volume or backing')
     maps=open('/proc/%d/maps'%pid).read().splitlines()
     if not maps:raise ValueError('shared process maps empty or unknown')
     for line in maps:
      match=re.match(r'^\S+\s+\S+\s+\S+\s+([0-9a-fA-F]+):([0-9a-fA-F]+)\s+([0-9]+)(?:\s|$)',line)
      if not match:raise ValueError('shared process maps unknown')
      device=os.makedev(int(match.group(1),16),int(match.group(2),16));inode=int(match.group(3))
      if device==data.st_dev or (device,inode)==(back.st_dev,back.st_ino):raise ValueError('shared task maps target volume or backing')
     if start(pid)!=before:raise ValueError('shared process changed')
     pids.append((pid,before))
    if not pids or len(pids)!=len(set(pids)):raise ValueError('shared process list incomplete')
    tasks[(namespace,taskid)]=tuple(sorted(pids))
  return tuple(sorted(namespaces)),tasks
 sharedNamespaces,sharedSnapshotBefore=sharedSnapshot();sharedTasks=set(sharedSnapshotBefore)
 verifyShared();seenShared=set()
 for name in os.listdir('/proc'):
  if not name.isdecimal():continue
  status=open('/proc/'+name+'/status').read()
  if re.search(r'^Kthread:\s*1$',status,re.M):continue
  exe=os.readlink('/proc/'+name+'/exe')
  if os.path.basename(exe).startswith('containerd-shim'):
   if os.path.realpath(exe)!=os.path.realpath('/usr/bin/containerd-shim-runc-v2'):raise ValueError('unknown shim binary')
   raw=open('/proc/'+name+'/cmdline','rb').read();args=[x for x in raw.decode().split('\0') if x]
   if len(args)!=7 or args[1]!='-namespace' or args[3]!='-id' or args[5]!='-address' or not re.fullmatch(r'[A-Za-z0-9_.-]+',args[2]) or not re.fullmatch(r'[a-f0-9]{64}',args[4]):raise ValueError('shim arguments unknown')
   if args[6]==r['containerdSocket']:raise ValueError('dedicated shim exists')
   if args[6]!='/run/containerd/containerd.sock':raise ValueError('shim runtime unknown')
   if args[4] in denied:raise ValueError('shared task overlaps dedicated identity')
   verifyShared()
   sf=show('containerd.service');spid=int(sf.get('MainPID','0'))
   if spid!=int(sharedProof['pid']) or not sf.get('ControlGroup'):raise ValueError('shared runtime unknown')
   shimStart=start(int(name));beforeCwd=os.stat('/proc/'+name+'/cwd');beforeExe=os.stat('/proc/'+name+'/exe')
   cg=open('/proc/'+name+'/cgroup').read().splitlines()
   if '0::'+sf['ControlGroup'] not in cg:raise ValueError('shim outside shared runtime cgroup')
   expected='/run/containerd/io.containerd.runtime.v2.task/'+args[2]+'/'+args[4]
   if os.path.realpath('/proc/'+name+'/cwd')!=expected:raise ValueError('shim cwd differs')
   shared=cmd('/usr/bin/ctr','--address','/run/containerd/containerd.sock','--namespace',args[2],'tasks','list','-q').splitlines()
   daemon('containerd.service',sharedProof['pid'],sharedProof['start'],'/var/lib/containerd',sharedProof['rootDev'],sharedProof['rootIno'],'/run/containerd/containerd.sock',sharedProof['socketDev'],sharedProof['socketIno'],sharedProof['unitSha256'],'/usr/bin/containerd',[])
   afterCwd=os.stat('/proc/'+name+'/cwd');afterExe=os.stat('/proc/'+name+'/exe')
   if shared.count(args[4])!=1 or open('/proc/'+name+'/cmdline','rb').read()!=raw or start(int(name))!=shimStart or (beforeCwd.st_dev,beforeCwd.st_ino)!=(afterCwd.st_dev,afterCwd.st_ino) or (beforeExe.st_dev,beforeExe.st_ino)!=(afterExe.st_dev,afterExe.st_ino):raise ValueError('shared task identity changed')
   pair=(args[2],args[4])
   if pair in seenShared:raise ValueError('duplicate shim')
   seenShared.add(pair)
 if sharedTasks!=seenShared:raise ValueError('shared task and shim sets differ')
 verifyShared()
 if sharedSnapshot()!=(sharedNamespaces,sharedSnapshotBefore):raise ValueError('shared task snapshot changed')
 verifyShared()
 print('候选检查通过；不得据此单独重开入口')
except Exception as e:
 print('裁剪 job 屏障拒绝: '+type(e).__name__+': '+str(e),file=sys.stderr);sys.exit(1)
