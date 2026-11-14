import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';

/** 文件锁由操作系统维持，跨进程竞争；FD 在进程退出时释放且不传给子进程。 */
export async function acquireWorkerFence(statePath: string) {
  if (process.platform !== 'linux' || !process.getuid) throw new Error('裁剪工作进程仅支持 Linux');
  const expectedUid = process.getuid();
  const dir = resolve(statePath), info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== expectedUid || (info.mode & 0o077) !== 0 || await realpath(dir) !== dir) throw new Error('裁剪状态目录不安全');
  const file = await open(join(dir, '.worker.lock'), constants.O_CREAT | constants.O_RDONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await file.stat(), onPath = await lstat(join(dir, '.worker.lock'));
    if (!stat.isFile() || stat.uid !== expectedUid || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || onPath.isSymbolicLink() || stat.dev !== onPath.dev || stat.ino !== onPath.ino) throw new Error('裁剪工作进程锁不安全');
    const libc = dlopen('libc.so.6', { flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int }, fcntl: { args: [FFIType.int, FFIType.int, FFIType.int], returns: FFIType.int } });
    try { if (libc.symbols.fcntl(file.fd, 2, 1) !== 0 || libc.symbols.flock(file.fd, 6) !== 0) throw new Error('已有其他裁剪工作进程'); }
    finally { libc.close(); }
    return file;
  } catch (error) { await file.close(); throw error; }
}
