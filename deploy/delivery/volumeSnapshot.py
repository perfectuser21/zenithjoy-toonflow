#!/usr/bin/env python3
"""完整原始卷的稀疏复制；容量由预分配的备份胶囊硬限制。"""
import os
from pathlib import Path
import stat
import json
import subprocess
import time

quantum = 1024 * 1024
reserve = 1024 ** 3


def scanVolume(source, timeout=90):
    source = Path(source)
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size <= 0:
        raise RuntimeError('volume must be a nonempty regular file')
    deadline = time.monotonic() + timeout
    nonzero = 0
    zero = bytes(quantum)
    with source.open('rb', buffering=0) as handle:
        while chunk := handle.read(quantum):
            if time.monotonic() > deadline:
                raise RuntimeError('volume scan timed out')
            if chunk != zero[:len(chunk)]:
                nonzero += 1
    # 这是准入估算，不将文件系统元数据常数冒充硬上界；胶囊满额即失败。
    return {'logicalBytes': info.st_size, 'nonzeroQuanta': nonzero,
            'estimatedPayloadBytes': nonzero * quantum}


def capsuleSize(config):
    size = config.get('backupCapsuleBytes')
    if type(size) is not int or not 256 * 1024 ** 2 <= size <= 64 * 1024 ** 3 or size % quantum:
        raise RuntimeError('explicit bounded backup capsule capacity required')
    return size


def requireCapsuleFilesystem(directory):
    result = subprocess.run(['findmnt','-J','-T',str(directory),'-o','FSTYPE,OPTIONS'],
                            capture_output=True,text=True,check=True,timeout=15)
    mount = json.loads(result.stdout)['filesystems'][0]
    if mount['fstype'] != 'ext4' or os.statvfs(directory).f_frsize != 4096:
        raise RuntimeError('bounded capsule requires ext4 with 4KiB allocation blocks')


def requireSpace(directory, required):
    stats = os.statvfs(directory)
    if stats.f_bavail * stats.f_frsize < required:
        raise RuntimeError('insufficient bounded backup storage')


def sparseCopy(source, target, timeout=90, *, maxPayloadBytes=None):
    source, target = Path(source), Path(target)
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size <= 0:
        raise RuntimeError('invalid sparse copy source')
    deadline = time.monotonic() + timeout
    zero = bytes(quantum)
    with source.open('rb', buffering=0) as incoming:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            offset = 0
            nonzero = 0
            while chunk := incoming.read(quantum):
                if time.monotonic() > deadline:
                    raise RuntimeError('volume copy timed out')
                if chunk != zero[:len(chunk)]:
                    nonzero += 1
                    if maxPayloadBytes is not None and nonzero * quantum > maxPayloadBytes:
                        raise RuntimeError('insufficient bounded backup storage')
                    written = 0
                    while written < len(chunk):
                        count = os.pwrite(fd, chunk[written:], offset + written)
                        if count <= 0:
                            raise RuntimeError('incomplete volume copy')
                        written += count
                offset += len(chunk)
            if offset != info.st_size:
                raise RuntimeError('volume size changed during copy')
            os.ftruncate(fd, offset)
            os.fsync(fd)
        finally:
            os.close(fd)
    return {'logicalBytes': offset, 'nonzeroQuanta': nonzero,
            'estimatedPayloadBytes': nonzero * quantum}
