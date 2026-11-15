#!/usr/bin/env python3
"""只验证 PID1 记录的 worker cgroup 身份；不启动/停止服务或放行恢复。"""
import json
import ctypes
import hashlib
import os
import re
import stat
import subprocess
import sys

ROOT = '/sys/fs/cgroup'

def cgroup_parts(value):
    if not isinstance(value, str) or not value.startswith('/') or value == '/': raise ValueError('invalid cgroup')
    parts = value[1:].split('/')
    if any(not x or x in ('.', '..') or '\0' in x for x in parts): raise ValueError('invalid cgroup')
    return parts

def unpopulated(value):
    rows = [x.split() for x in value.splitlines()]
    values = [x[1] for x in rows if len(x) == 2 and x[0] == 'populated']
    if values != ['0']: raise ValueError('cgroup populated or unreadable')
    return True

def unit_state(name):
    if not re.fullmatch(r'[A-Za-z0-9_.@-]+\.service', name): raise ValueError('invalid unit')
    r = subprocess.run(['/usr/bin/systemctl','show',name,'-p','Id','-p','LoadState','-p','ActiveState','-p','MainPID','-p','Job','-p','ControlGroup','-p','FragmentPath','-p','DropInPaths','-p','NeedDaemonReload'], check=True, capture_output=True, text=True, timeout=10)
    if len(r.stdout)>32768: raise ValueError('unit output too large')
    result={}
    for line in r.stdout.splitlines():
        k,sep,v=line.partition('=')
        if not sep or k in result: raise ValueError('unit output invalid')
        result[k]=v
    if result.get('Id')!=name or result.get('LoadState') not in ('loaded','masked') or result.get('Job') or result.get('DropInPaths') or result.get('NeedDaemonReload')!='no': raise ValueError('unit identity or job invalid')
    return result

def cgroup_open(value):
    parts=cgroup_parts(value)
    if os.path.realpath(ROOT)!=ROOT: raise ValueError('cgroup root not canonical')
    fd=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        libc=ctypes.CDLL(None,use_errno=True);buf=ctypes.create_string_buffer(256)
        if libc.fstatfs(fd,ctypes.byref(buf))!=0 or ctypes.c_long.from_buffer(buf).value!=0x63677270:raise ValueError('cgroup filesystem invalid')
        root=os.fstat(fd)
        for part in parts:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
            s=os.fstat(child)
            if s.st_dev!=root.st_dev: os.close(child);raise ValueError('cgroup crossed filesystem')
            os.close(fd);fd=child
        return fd
    except BaseException:
        os.close(fd);raise

def safe_parent(path):
    if not os.path.isabs(path) or os.path.realpath(os.path.dirname(path))!=os.path.dirname(path):raise ValueError('invalid snapshot path')
    p=os.path.dirname(path)
    while True:
        s=os.lstat(p)
        if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:raise ValueError('untrusted snapshot directory')
        if p=='/':break
        p=os.path.dirname(p)

def unit_digest(path):
    safe_parent(path);before=os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_mode&0o022 or before.st_nlink!=1 or before.st_size>1024*1024:raise ValueError('unit file invalid')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    with os.fdopen(fd,'rb') as f:
        held=os.fstat(f.fileno())
        if (held.st_dev,held.st_ino)!=(before.st_dev,before.st_ino):raise ValueError('unit file changed')
        data=f.read(1024*1024+1);after=os.fstat(f.fileno())
        if len(data)!=held.st_size or (held.st_dev,held.st_ino,held.st_size,held.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):raise ValueError('unit file changed')
        return hashlib.sha256(data).hexdigest()

def snapshot(name,path):
    safe_parent(path);v=unit_state(name)
    if v.get('ActiveState')!='active' or not re.fullmatch(r'[1-9][0-9]*',v.get('MainPID','')):raise ValueError('worker not active')
    pid=int(v['MainPID']);cg=v.get('ControlGroup','');cgroup_parts(cg)
    fragment=v.get('FragmentPath','');digest=unit_digest(fragment)
    raw=open(f'/proc/{pid}/stat').read();end=raw.rfind(') ');fields=raw[end+2:].split() if end>=0 else []
    if len(fields)<20 or not fields[19].isdigit():raise ValueError('pid identity invalid')
    start=fields[19]
    if f'0::{cg}' not in open(f'/proc/{pid}/cgroup').read().splitlines():raise ValueError('pid cgroup mismatch')
    fd=cgroup_open(cg)
    try:
        st=os.fstat(fd);value={'unit':name,'cgroup':cg,'dev':str(st.st_dev),'ino':str(st.st_ino),'pid':str(pid),'start':start,'bootId':open('/proc/sys/kernel/random/boot_id').read().strip(),'unitPath':fragment,'unitSha256':digest}
        again=open(f'/proc/{pid}/stat').read();again_end=again.rfind(') ');again_fields=again[again_end+2:].split() if again_end>=0 else []
        if len(again_fields)<20 or again_fields[19]!=start or f'0::{cg}' not in open(f'/proc/{pid}/cgroup').read().splitlines() or unit_state(name)!=v:raise ValueError('unit changed during capture')
        out=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
        with os.fdopen(out,'w') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
        parent=os.open(os.path.dirname(path),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);os.fsync(parent);os.close(parent)
    finally:os.close(fd)

def verify(name,path):
    safe_parent(path);s=os.lstat(path)
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=0o600 or s.st_size>4096:raise ValueError('snapshot invalid')
    f=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    with os.fdopen(f) as h:
        st=os.fstat(h.fileno())
        if (st.st_dev,st.st_ino)!=(s.st_dev,s.st_ino):raise ValueError('snapshot changed')
        snap=json.load(h)
    if not isinstance(snap,dict) or set(snap)!={'unit','cgroup','dev','ino','pid','start','bootId','unitPath','unitSha256'} or snap['unit']!=name or any(not isinstance(snap[k],str) or not re.fullmatch(r'[1-9][0-9]*',snap[k]) for k in ('dev','ino','pid','start')):raise ValueError('snapshot fields invalid')
    if not re.fullmatch(r'[a-f0-9-]{36}',snap['bootId']) or open('/proc/sys/kernel/random/boot_id').read().strip()!=snap['bootId']:raise ValueError('boot identity changed')
    if not re.fullmatch(r'[a-f0-9]{64}',snap['unitSha256']) or unit_digest(snap['unitPath'])!=snap['unitSha256']:raise ValueError('unit file changed')
    v=unit_state(name)
    if v.get('LoadState')=='loaded' and v.get('FragmentPath')!=snap['unitPath']:raise ValueError('unit fragment changed')
    if v.get('ActiveState') not in ('inactive','failed') or v.get('MainPID')!='0' or v.get('ControlGroup') not in ('',snap['cgroup']):raise ValueError('worker still running')
    try:
        raw=open('/proc/'+snap['pid']+'/stat').read();end=raw.rfind(') ');parts=raw[end+2:].split() if end>=0 else []
        if len(parts)<20 or parts[19]==snap['start']:raise ValueError('original worker still alive')
    except FileNotFoundError:pass
    fd=cgroup_open(snap['cgroup'])
    try:
        cg=os.fstat(fd)
        if str(cg.st_dev)!=snap['dev'] or str(cg.st_ino)!=snap['ino']:raise ValueError('cgroup identity changed')
        events=os.open('cgroup.events',os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
        try:unpopulated(os.read(events,4097).decode())
        finally:os.close(events)
        again=cgroup_open(snap['cgroup'])
        try:
            current=os.fstat(again)
            if (current.st_dev,current.st_ino)!=(cg.st_dev,cg.st_ino):raise ValueError('cgroup path changed')
        finally:os.close(again)
        if unit_state(name)!=v:raise ValueError('unit changed during verification')
    finally:os.close(fd)

if __name__=='__main__':
    try:
        if os.geteuid()!=0 or len(sys.argv)!=4 or sys.argv[1] not in ('capture','verify'):raise ValueError('usage invalid')
        (snapshot if sys.argv[1]=='capture' else verify)(sys.argv[2],sys.argv[3])
        print('PID1 cgroup 核验通过；不代表其他入口或容器已清零')
    except Exception as error:
        print('PID1 cgroup 未能核验：'+type(error).__name__,file=sys.stderr);sys.exit(1)
