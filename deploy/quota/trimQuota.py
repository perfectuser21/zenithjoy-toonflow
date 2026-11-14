"""在同一项目配额卷中创建独立裁剪目录；不改动已有工作区。"""
import fcntl
import os
import re
import stat
import struct

GET = 0x801C581F
SET = 0x401C5820
INHERIT = 0x200


def attributes(fd):
    data = bytearray(28)
    fcntl.ioctl(fd, GET, data, True)
    return data, struct.unpack_from('=I', data, 0)[0], struct.unpack_from('=I', data, 12)[0]


def ensure_trim_directory(root_fd, root_device, user_id, project_id, store_uid, app_gid):
    if not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', user_id):
        raise ValueError('账号标识无效')
    if not all(isinstance(value, int) and 0 < value <= 2147483647 for value in (project_id, store_uid, app_gid)):
        raise ValueError('裁剪项目配置无效')
    try:
        os.mkdir('privateTrim', 0o711, dir_fd=root_fd)
        base_created = True
    except FileExistsError:
        base_created = False
    base = os.open('privateTrim', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    try:
        info = os.fstat(base)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_dev != root_device or info.st_mode & 0o022:
            raise ValueError('私有裁剪根目录不安全')
        if base_created or stat.S_IMODE(info.st_mode) == 0o700 and not os.listdir(base):
            os.fchmod(base, 0o711)
        elif stat.S_IMODE(info.st_mode) != 0o711:
            raise ValueError('已有私有裁剪根目录权限不匹配')
        try:
            os.mkdir(user_id, 0o711, dir_fd=base)
            created = True
        except FileExistsError:
            created = False
        account = os.open(user_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base)
        try:
            item = os.fstat(account)
            if not stat.S_ISDIR(item.st_mode) or item.st_uid != 0 or item.st_dev != root_device or item.st_mode & 0o022:
                raise ValueError('私有裁剪账号目录不安全')
            data, flags, current = attributes(account)
            if created or (current in (0, project_id) and not os.listdir(account) and stat.S_IMODE(item.st_mode) != 0o711):
                # 新目录尚无任何客户数据，设为现有用户 project 并继承，不递归改动其他目录。
                if current not in (0, project_id):
                    raise ValueError('新目录项目配额冲突')
                struct.pack_into('=I', data, 0, flags | INHERIT)
                struct.pack_into('=I', data, 12, project_id)
                fcntl.ioctl(account, SET, data)
                os.fchmod(account, 0o711)
            _, flags, current = attributes(account)
            if current != project_id or not flags & INHERIT or stat.S_IMODE(os.fstat(account).st_mode) != 0o711:
                raise ValueError('私有裁剪项目配额不匹配')
            try:
                os.mkdir('results', 0o750, dir_fd=account)
                child_created = True
            except FileExistsError:
                child_created = False
            results = os.open('results', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=account)
            try:
                child = os.fstat(results)
                if child.st_dev != root_device:
                    raise ValueError('裁剪目录不在配额卷内')
                if child_created or (child.st_uid == 0 and not os.listdir(results)):
                    os.fchown(results, store_uid, app_gid)
                    os.fchmod(results, 0o750)
                elif child.st_uid == store_uid and child.st_gid == app_gid and not os.listdir(results) and stat.S_IMODE(child.st_mode) != 0o750:
                    # 中断在 chown 后、chmod 前时只修复空目录，已有客户数据绝不改动。
                    os.fchmod(results, 0o750)
                child = os.fstat(results)
                _, child_flags, child_project = attributes(results)
                if child.st_uid != store_uid or child.st_gid != app_gid or stat.S_IMODE(child.st_mode) != 0o750 or child_project != project_id or not child_flags & INHERIT:
                    raise ValueError('裁剪目录权限或配额不匹配')
                os.fsync(results)
            finally:
                os.close(results)
            os.fsync(account)
        finally:
            os.close(account)
        os.fsync(base)
        os.fsync(root_fd)
    finally:
        os.close(base)
