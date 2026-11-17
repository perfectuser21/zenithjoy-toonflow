#!/usr/bin/env python3
"""只在备份的独立可写副本中核验 ext4 project quota 恢复。"""
import errno
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys


def run(args, timeout=120, **options):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, timeout=timeout, **options).stdout


def main():
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    config = json.loads(Path('/etc/aivideo/release.json').read_text())
    request = json.load(sys.stdin)
    snapshot = Path(request['snapshot'])
    root = Path(config['backupDirectory']).resolve(strict=True)
    if snapshot.is_symlink() or snapshot.resolve().parent.parent != root or snapshot.name != 'data.ext4':
        raise RuntimeError('snapshot outside controlled backups')
    if not re.fullmatch(r'[0-9]+', snapshot.parent.name):
        raise RuntimeError('invalid backup identity')
    for path in (snapshot, snapshot.parent, root):
        info = path.lstat()
        if info.st_uid != 0 or info.st_mode & 0o077:
            raise RuntimeError('backup permissions invalid')
    if not stat.S_ISREG(snapshot.stat().st_mode) or snapshot.stat().st_size <= 0:
        raise RuntimeError('snapshot must be a nonempty regular file')
    copy = snapshot.parent / 'quotaRestore.ext4'
    mount = snapshot.parent / 'quotaRestore'
    if copy.exists() or mount.exists():
        raise RuntimeError('restore attempt already exists')
    # 副本额外容量以备份实际分配块数作下界，保留1GiB；原始逻辑卷的空间在备份前已校验。
    stats = os.statvfs(root)
    if stats.f_bavail * stats.f_frsize < snapshot.stat().st_blocks * 512 + 1024 ** 3:
        raise RuntimeError('insufficient restore space')
    run(['cp', '--sparse=always', '--reflink=never', str(snapshot), str(copy)])
    os.chmod(copy, 0o600)
    run(['cmp', '--silent', str(snapshot), str(copy)])
    mount.mkdir(mode=0o700)
    mounted = False
    try:
        run(['mount', '-o', 'loop,nosuid,nodev,noexec,prjquota', str(copy), str(mount)])
        mounted = True
        def quota(command):
            result = subprocess.run(['xfs_quota', '-f', '-x', '-c', command, str(mount)],
                                    check=True, capture_output=True, text=True, timeout=20,
                                    env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
            if result.stderr.strip():
                raise RuntimeError('quota command reported error')
            return result.stdout
        state = quota('state -p')
        if not re.search(r'(?m)^\s*Accounting: ON\s*$',state) or not re.search(r'(?m)^\s*Enforcement: ON\s*$',state):
            raise RuntimeError('quota enforcement not restored')
        mountDevice = mount.stat().st_dev
        def clonePath(relative):
            current = mount
            for part in Path(relative).parts:
                if part in ('..', '/', '.'):
                    raise RuntimeError('invalid clone relative path')
                current = current / part
                info = current.lstat()
                if stat.S_ISLNK(info.st_mode) or info.st_dev != mountDevice:
                    raise RuntimeError('clone path escapes restored volume')
            return current
        registry = clonePath('projectQuota/quotaRegistry.sqlite')
        if registry.is_symlink() or not registry.is_file():
            raise RuntimeError('quota registry missing')
        wal = Path(str(registry) + '-wal')
        if wal.exists() and wal.stat().st_size > 0:
            raise RuntimeError('registry still has live WAL')
        database = sqlite3.connect(registry.as_uri() + '?mode=ro&immutable=1', uri=True)
        try:
            if database.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise RuntimeError('quota registry invalid')
            records = database.execute('SELECT projectId,userId,ready FROM projects').fetchall()
        finally:
            database.close()
        if not records:
            raise RuntimeError('no enrolled projects to verify')
        def row(projectId, inode=False):
            output = quota('quota -p -n -v ' + ('-i ' if inode else '') + str(projectId))
            rows = [line.split() for line in output.splitlines() if line.split() and line.split()[-1] == str(mount)]
            if len(rows) != 1 or len(rows[0]) < 5:
                raise RuntimeError('quota report missing')
            return [int(value) for value in rows[0][1:4]]
        for projectId, userId, ready in records:
            if ready != 1 or not isinstance(projectId,int) or not 0 < projectId < 2147483647:
                raise RuntimeError('unfinished quota enrollment')
            if not re.fullmatch(r'[a-f0-9-]{36}',userId):
                raise RuntimeError('invalid project identity')
            directory = clonePath(Path('projectQuota/quotaWorkspaces') / userId)
            if directory.is_symlink() or not directory.is_dir():
                raise RuntimeError('project directory missing')
            attributes = run(['lsattr','-pd',str(directory)]).split()
            if len(attributes) < 2 or attributes[0] != str(projectId) or 'P' not in attributes[1]:
                raise RuntimeError('project attributes not restored')
            if row(projectId)[2] != config['expectedQuotaKiB'] or row(projectId,True)[2] != config['expectedQuotaInodes']:
                raise RuntimeError('quota limits not restored')
        # 在独立副本上分配未使用的临时 project；不修改任何原用户目录或配额。
        projectId = max(record[0] for record in records) + 1
        for _ in range(100):
            if projectId >= 2147483647:
                raise RuntimeError('no isolated quota probe identity')
            if not any(row(projectId)) and not any(row(projectId,True)):
                break
            projectId += 1
        else:
            raise RuntimeError('no isolated quota probe identity')
        probe = mount / 'releaseQuotaProbe'
        probe.mkdir(mode=0o700)
        quota('project -s -p ' + str(probe) + ' ' + str(projectId))
        quota('limit -p bhard=1m ihard=64 ' + str(projectId))
        uid, gid = config['serviceUid'], config['serviceGid']
        if not isinstance(uid,int) or not isinstance(gid,int) or min(uid,gid) <= 0:
            raise RuntimeError('probe must be unprivileged')
        os.chown(probe,uid,gid)
        # mount父目录必须允许服务用户遍历；使用继承的目录FD，避免放宽备份目录权限。
        fd = os.open(probe,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        code = '''import errno,os,sys
fd=int(sys.argv[1]); f=os.open("quotaProbe.bin",os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=fd)
written=0; denied=False
try:
 try:
  while written < 2*1024*1024: written += os.write(f,b"x"*65536)
  os.fsync(f)
 except OSError as e:
  if e.errno != errno.EDQUOT: raise
  denied=True
finally: os.close(f)
if not denied or not 0 < written < 2*1024*1024: sys.exit(1)
'''
        def drop():
            os.setgroups([])
            os.setgid(gid)
            os.setuid(uid)
        try:
            run([sys.executable,'-c',code,str(fd)],pass_fds=(fd,),preexec_fn=drop)
        finally:
            os.close(fd)
        run(['umount',str(mount)])
        mounted = False
        print(json.dumps({'snapshot':str(snapshot),'quotaRestoreVerified':True,
                          'projectsVerified':len(records),'unprivilegedEdquotVerified':True}))
    finally:
        if mounted:
            run(['umount',str(mount)])
        # 保留恢复副本与探针供核验；从不在原卷上写探针或删除备份。


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        reason = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print('隔离配额恢复验收未通过: ' + reason,file=sys.stderr)
        sys.exit(1)
