import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import { requireAllowedIngressGeneration } from './trimIngressGeneration';

// Only explicitly attested workers use this root-controlled, per-request fence.
const directory = '/var/lib/toonflow-trim/ingress';
const path = `${directory}/access.lock`;
const pending = [`${directory}/pending`, `${directory}/guard.pending`];
const generation = `${directory}/generation.json`;
const readyDirectory = '/run/toonflow-trim-ingress';

async function checkGeneration(gid: number) {
  const file = await open(generation, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    const same = (s: typeof before) => s.isFile() && s.uid === 0 && s.gid === gid && s.nlink === 1 &&
      (s.mode & 0o7777) === 0o640 && s.dev === before.dev && s.ino === before.ino &&
      s.size === before.size && s.mtimeMs === before.mtimeMs;
    if (!same(before) || before.size < 1 || before.size > 4096 || !same(await lstat(generation))) throw new Error('入口代际文件不安全');
    const raw = await file.readFile('utf8');
    if (Buffer.byteLength(raw) !== before.size || !same(await file.stat()) || !same(await lstat(generation))) throw new Error('入口代际文件已变化');
    const value = requireAllowedIngressGeneration(raw, (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim());
    const dir = await lstat(readyDirectory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== 0 || (dir.mode & 0o7777) !== 0o755 || await realpath(readyDirectory) !== readyDirectory) throw new Error('入口准入目录不安全');
    const run = await lstat('/run');
    if (!run.isDirectory() || run.isSymbolicLink() || run.uid !== 0 || (run.mode & 0o022) || await realpath('/run') !== '/run') throw new Error('入口准入父目录不安全');
    if (dir.dev !== run.dev) throw new Error('入口准入目录挂载不一致');
    const allMounts = (await readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n').map(line => line.split(' '));
    if (allMounts.some(parts => parts[4] === readyDirectory)) throw new Error('入口准入目录不得单独挂载');
    const mounts = allMounts.filter(parts => parts[4] === '/run');
    if (mounts.length !== 1 || mounts[0].indexOf('-') < 6 || mounts[0][mounts[0].indexOf('-') + 1] !== 'tmpfs') throw new Error('入口准入运行目录身份未知');
    const readyPath = `${readyDirectory}/ready.json`;
    const ready = await open(readyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const a = await ready.stat(), p = await lstat(readyPath);
      const valid = (s: typeof a) => s.isFile() && s.uid === 0 && s.gid === gid && s.nlink === 1 && (s.mode & 0o7777) === 0o640 && s.dev === a.dev && s.ino === a.ino && s.size === a.size && s.mtimeMs === a.mtimeMs;
      if (!valid(a) || !valid(p) || a.size < 1 || a.size > 4096) throw new Error('入口准入令牌不安全');
      const token = await ready.readFile('utf8');
      const expected = { generation: value, runDev: String(run.dev), runIno: String(run.ino), readyDev: String(dir.dev), readyIno: String(dir.ino) };
      if (Buffer.byteLength(token) !== a.size || !valid(await ready.stat()) || !valid(await lstat(readyPath)) || token !== JSON.stringify(expected)) throw new Error('入口准入令牌不匹配');
      const afterRun = await lstat('/run'), afterDir = await lstat(readyDirectory);
      if (afterRun.dev !== run.dev || afterRun.ino !== run.ino || afterDir.dev !== dir.dev || afterDir.ino !== dir.ino) throw new Error('入口准入目录已变化');
    } finally { await ready.close(); }
  } finally { await file.close(); }
}

async function checkNoPending() {
  for (const marker of pending) {
    try { await lstat(marker); throw new Error('入口维护中'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** Each request owns a distinct open file description until its response has drained. */
export async function acquireIngressRequestFence() {
  if (process.platform !== 'linux' || typeof process.getgroups !== 'function') throw new Error('入口屏障不可用');
  for (let p = directory;; p = dirname(p)) {
    const st = await lstat(p);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) || await realpath(p) !== p) throw new Error('入口屏障目录不安全');
    if (p === '/') break;
  }
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.gid === 0 || !process.getgroups().includes(before.gid) || before.nlink !== 1 || (before.mode & 0o777) !== 0o640) throw new Error('入口屏障锁不安全');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fd.stat(), current = await lstat(path);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || st.dev !== current.dev || st.ino !== current.ino || st.uid !== 0 || st.gid !== before.gid || st.nlink !== 1 || (st.mode & 0o777) !== 0o640) throw new Error('入口屏障锁身份变化');
    const libc = dlopen('libc.so.6', { flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int }, fcntl: { args: [FFIType.int, FFIType.int, FFIType.int], returns: FFIType.int } });
    try { if (libc.symbols.fcntl(fd.fd, 2, 1) !== 0 || libc.symbols.flock(fd.fd, 5) !== 0) throw new Error('入口暂不可用'); }
    finally { libc.close(); }
    const after = await lstat(path);
    if (after.dev !== st.dev || after.ino !== st.ino || after.uid !== 0 || after.gid !== st.gid || after.nlink !== 1 || (after.mode & 0o777) !== 0o640) throw new Error('入口屏障锁已变化');
    await checkNoPending();
    await checkGeneration(st.gid);
    await checkNoPending();
    return fd;
  } catch (error) { await fd.close(); throw error; }
}
