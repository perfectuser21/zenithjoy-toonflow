#!/usr/bin/env python3
"""试验性 ext4 project quota helper；仅供隔离测试卷，尚未通过安全审计。"""
import errno
import fcntl
import json
import os
import re
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import time

# 配置由 root 拥有的服务单元提供，不接受客户端选择路径、额度或命令。
if len(sys.argv) != 6 or os.geteuid() != 0:
    raise SystemExit("需要 root 及固定的卷根目录、socket、服务 UID、服务 GID")
root, socket_path, service_uid, service_gid, auth_db_path = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
if service_uid <= 0 or service_gid <= 0:
    raise SystemExit("服务必须使用非 root UID 和 GID")
root = os.path.realpath(root)
if not os.path.isabs(socket_path) or not re.fullmatch(r"/[A-Za-z0-9_./-]+", root):
    raise SystemExit("路径必须为绝对路径")
root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
root_stat = os.fstat(root_fd)
if not stat.S_ISDIR(root_stat.st_mode) or root_stat.st_uid != 0 or root_stat.st_mode & 0o022:
    raise SystemExit("卷根目录须由 root 独占写入")
lock_fd = os.open("quotaHelper.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=root_fd)
lock_stat = os.fstat(lock_fd)
if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_uid != 0 or lock_stat.st_nlink != 1 or lock_stat.st_mode & 0o077:
    raise SystemExit("配额服务锁文件不安全")
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit("配额服务已在运行")
# 锁文件留在 root 独占写入的目录，服务只能对同一 inode 加锁，不能替换它。
try:
    admission_fd = os.open("backgroundAdmission.flock", os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=root_fd)
except FileExistsError:
    admission_fd = os.open("backgroundAdmission.flock", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root_fd)
else:
    os.fchown(admission_fd, 0, service_gid)
    os.fchmod(admission_fd, 0o660)
admission_stat = os.fstat(admission_fd)
if not stat.S_ISREG(admission_stat.st_mode) or admission_stat.st_uid != 0 or admission_stat.st_gid != service_gid or stat.S_IMODE(admission_stat.st_mode) != 0o660 or admission_stat.st_nlink != 1 or admission_stat.st_dev != root_stat.st_dev:
    raise SystemExit("换背景进程锁文件不安全")
os.close(admission_fd)
mount = subprocess.run(["/usr/bin/findmnt", "-n", "-o", "TARGET", "--target", root], check=True, capture_output=True, text=True, timeout=5).stdout.strip()
if not os.path.isabs(mount):
    raise SystemExit("无法验证配额挂载点")
mount_info = subprocess.run(["/usr/bin/findmnt", "-n", "-o", "FSTYPE,OPTIONS", "--target", root], check=True, capture_output=True, text=True, timeout=5).stdout.strip().split(None, 1)
if len(mount_info) != 2 or mount_info[0] != "ext4" or "prjquota" not in mount_info[1].split(","):
    raise SystemExit("测试卷须启用 ext4 项目配额")
workspaces = f"/proc/self/fd/{root_fd}/quotaWorkspaces"
try:
    os.mkdir("quotaWorkspaces", 0o711, dir_fd=root_fd)
except FileExistsError:
    pass
info = os.lstat("quotaWorkspaces", dir_fd=root_fd)
if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_dev != root_stat.st_dev:
    raise SystemExit("工作区根目录不安全")
workspaces_fd = os.open("quotaWorkspaces", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
if os.fstat(workspaces_fd).st_ino != info.st_ino or os.fstat(workspaces_fd).st_dev != info.st_dev:
    raise SystemExit("工作区根目录已变更")
# mkdir 的权限会被进程 umask 收紧；仅在核验 root 持有且不可被服务用户替换后修正。
os.fchmod(workspaces_fd, 0o711)
if stat.S_IMODE(os.fstat(workspaces_fd).st_mode) != 0o711:
    raise SystemExit("工作区根目录权限无效")
database = f"/proc/self/fd/{root_fd}/quotaRegistry.sqlite"
if os.path.lexists(database):
    info = os.lstat(database)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise SystemExit("配额数据库权限不安全")
os.umask(0o077)
db = sqlite3.connect(database, isolation_level=None)
db.execute("PRAGMA synchronous=FULL")
db.execute("CREATE TABLE IF NOT EXISTS projects (projectId INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL UNIQUE, ready INTEGER NOT NULL DEFAULT 0, enrolledAt INTEGER NOT NULL)")
db.execute("CREATE TABLE IF NOT EXISTS configuration (key TEXT PRIMARY KEY, value INTEGER NOT NULL)")
db.execute("INSERT OR IGNORE INTO configuration(key,value) VALUES (?,?)", ("initializedAt", int(time.time() * 1000)))
initialized_at = db.execute("SELECT value FROM configuration WHERE key=?", ("initializedAt",)).fetchone()[0]
if not os.path.isabs(auth_db_path):
    raise SystemExit("账号数据库路径必须固定")


def quota(*commands):
    args = ["/usr/sbin/xfs_quota", "-f", "-x"]
    for command in commands:
        args.extend(["-c", command])
    result = subprocess.run([*args, mount], check=True, capture_output=True, text=True, env={"PATH": "/usr/sbin:/usr/bin", "LC_ALL": "C"}, timeout=20, pass_fds=(root_fd, workspaces_fd))
    if result.stderr.strip():
        raise RuntimeError("配额工具报错")
    return result.stdout


def verify_volume():
    if os.stat(mount).st_dev != root_stat.st_dev:
        raise ValueError("配额卷已变化")
    state = quota("state -p")
    if not re.search(r"(?m)^\s*Accounting: ON\s*$", state) or not re.search(r"(?m)^\s*Enforcement: ON\s*$", state):
        raise ValueError("项目配额未启用")


def quota_row(project_id, inode=False):
    output = quota(f"quota -p -n -v {'-i ' if inode else ''}{project_id}")
    rows = [line.split() for line in output.splitlines() if line.split() and line.split()[-1] == mount]
    if len(rows) != 1 or len(rows[0]) < 5:
        raise ValueError("项目配额状态异常")
    return [int(value) for value in rows[0][1:4]]


def provision(user_id, operation):
    if not isinstance(user_id, str) or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", user_id):
        raise ValueError("账号标识无效")
    path = f"/proc/self/fd/{workspaces_fd}/{user_id}"
    db.execute("BEGIN IMMEDIATE")
    try:
        record = db.execute("SELECT projectId, ready FROM projects WHERE userId=?", (user_id,)).fetchone()
        if record is None:
            if operation != "enroll":
                raise ValueError("未知用户不能自动迁移")
            if os.path.lexists(path):
                raise ValueError("旧用户目录未归属，不能自动启用")
            # 账号读取降权到服务 UID，路径竞争也不会借 root 权限读取其他文件。
            reader = """import json,os,sqlite3,stat,sys
p,u=sys.argv[1:]
f=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
try:
 s=os.fstat(f)
 if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1: raise ValueError()
 d=sqlite3.connect('file:/proc/self/fd/%d?mode=ro' % f,uri=True,timeout=1)
 try: v=d.execute('SELECT createdAt,disabled FROM multiTenantUser WHERE id=?',(u,)).fetchone()
 finally: d.close()
 print(json.dumps(v))
finally: os.close(f)
"""
            def drop_privileges():
                os.setgroups([])
                os.setgid(service_gid)
                os.setuid(service_uid)
            result = subprocess.run([sys.executable, "-c", reader, auth_db_path, user_id], check=True,
                                    capture_output=True, text=True, timeout=5, preexec_fn=drop_privileges)
            account = json.loads(result.stdout)
            now = int(time.time() * 1000)
            if account is None or account[1] or account[0] < initialized_at or account[0] > now:
                raise ValueError("账号不存在或不属于新用户")
            count = db.execute("SELECT count(*) FROM projects").fetchone()[0]
            recent = db.execute("SELECT count(*) FROM projects WHERE enrolledAt>?", (now - 60000,)).fetchone()[0]
            if count >= 10000 or recent >= 5:
                raise ValueError("注册配额已达到限制")
            candidate = db.execute("SELECT coalesce(max(projectId),0)+1 FROM projects").fetchone()[0]
            for _ in range(10000):
                if candidate > 2147483647:
                    raise ValueError("配额编号已耗尽")
                if not any(quota_row(candidate)) and not any(quota_row(candidate, True)):
                    break
                candidate += 1
            else:
                raise ValueError("没有空闲的项目配额编号")
            db.execute("INSERT INTO projects(projectId,userId,enrolledAt) VALUES (?,?,?)", (candidate, user_id, now))
            record = (candidate, 0)
        project_id, ready = record
        if project_id < 1 or project_id > 2147483647:
            raise ValueError("配额编号已耗尽")
        db.execute("COMMIT")
    except BaseException:
        db.execute("ROLLBACK")
        raise
    if not ready:
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            pass
        item = os.lstat(path)
        if not stat.S_ISDIR(item.st_mode) or item.st_uid != 0 or item.st_dev != root_stat.st_dev or os.listdir(path):
            raise ValueError("旧用户目录未归属，不能自动启用")
        quota(f"project -s -p {path} {project_id}", f"limit -p bhard=5g ihard=100000 {project_id}")
        # 提交状态后再交出目录；故障恢复时 root 仍可核验并完成所有权转移。
        db.execute("UPDATE projects SET ready=1 WHERE userId=? AND projectId=?", (user_id, project_id))
    item = os.lstat(path)
    if not stat.S_ISDIR(item.st_mode) or item.st_uid not in (0, service_uid) or item.st_dev != root_stat.st_dev:
        raise ValueError("配额目录状态异常")
    # 强制每次都检查项目属性及块/ inode 限额，防止错误配置被当成 ready。
    attrs = subprocess.run(["/usr/bin/lsattr", "-pd", path], check=True, capture_output=True, text=True, timeout=10, pass_fds=(root_fd, workspaces_fd)).stdout.split()
    if len(attrs) < 2 or attrs[0] != str(project_id) or "P" not in attrs[1] or quota_row(project_id)[2] != 5 * 1024 * 1024 or quota_row(project_id, True)[2] != 100000:
        raise ValueError("项目配额状态异常")
    if item.st_uid == 0:
        existing = set(os.listdir(path))
        if existing - {"workspace", "private"}:
            raise ValueError("未完成用户目录包含旧数据")
        for name in ("workspace", "private"):
            child = os.path.join(path, name)
            try:
                os.mkdir(child, 0o700)
            except FileExistsError:
                child_stat = os.lstat(child)
                if not stat.S_ISDIR(child_stat.st_mode) or child_stat.st_uid not in (0, service_uid) or os.listdir(child):
                    raise ValueError("未完成用户目录包含旧数据")
            os.chown(child, service_uid, service_gid)
        os.chown(path, service_uid, service_gid)
    else:
        for name in ("workspace", "private"):
            child_stat = os.lstat(os.path.join(path, name))
            if not stat.S_ISDIR(child_stat.st_mode) or child_stat.st_uid != service_uid or child_stat.st_dev != root_stat.st_dev:
                raise ValueError("用户子目录状态异常")
    return {"ready": True, "projectId": project_id}


server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
if os.path.dirname(socket_path) != root or os.path.basename(socket_path) in ("", ".", ".."):
    raise SystemExit("socket 必须位于受保护的数据根目录")
name = os.path.basename(socket_path)
try:
    stale = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
except FileNotFoundError:
    stale = None
if stale is not None:
    if not stat.S_ISSOCK(stale.st_mode) or stale.st_uid != 0 or stale.st_gid != service_gid or stat.S_IMODE(stale.st_mode) != 0o660:
        raise SystemExit("已有 socket 类型或权限异常")
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.5)
    try:
        result = probe.connect_ex(f"/proc/self/fd/{root_fd}/{name}")
    finally:
        probe.close()
    if result != errno.ECONNREFUSED:
        raise SystemExit("已有 socket 不可安全回收")
    current = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
    if (current.st_dev, current.st_ino) != (stale.st_dev, stale.st_ino):
        raise SystemExit("socket 已发生变化")
    os.unlink(name, dir_fd=root_fd)
previous_mask = os.umask(0o117)
try:
    server.bind(f"/proc/self/fd/{root_fd}/{name}")
finally:
    os.umask(previous_mask)
os.chown(name, 0, service_gid, dir_fd=root_fd, follow_symlinks=False)
socket_stat = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
if not stat.S_ISSOCK(socket_stat.st_mode) or socket_stat.st_uid != 0 or socket_stat.st_gid != service_gid or stat.S_IMODE(socket_stat.st_mode) != 0o660:
    raise SystemExit("socket 身份或权限无效")
server.listen(16)
while True:
    conn, _ = server.accept()
    with conn:
        try:
            _, uid, _ = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != service_uid:
                raise ValueError("调用者无权限")
            conn.settimeout(5)
            data = b""
            while not data.endswith(b"\n") and len(data) < 1024:
                part = conn.recv(1024 - len(data))
                if not part:
                    break
                data += part
            request = json.loads(data)
            if request == {"operation": "health"}:
                verify_volume()
                response = {"ready": True}
            elif isinstance(request, dict) and set(request) == {"userId", "operation"} and request["operation"] in ("enroll", "check"):
                verify_volume()
                response = provision(request["userId"], request["operation"])
            else:
                raise ValueError("请求无效")
        except Exception:
            response = {"ready": False}
        try:
            conn.sendall(json.dumps(response, separators=(",", ":")).encode() + b"\n")
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass
