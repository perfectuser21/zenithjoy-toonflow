/** Admission identity is tied to this boot and process incarnation. */
export type StartupIdentity = { bootId: string; workerPid: number; workerStart: string; listenerInode?: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function validateStartupAdmission(value: unknown, expected: StartupIdentity): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('启动证明无效');
  const item = value as Record<string, unknown>;
  const attested = expected.listenerInode !== undefined;
  if (Object.keys(item).sort().join(',') !== (attested ? 'bootId,listenerInode,nonce,workerPid,workerStart' : 'bootId,nonce,workerPid,workerStart')
      || item.bootId !== expected.bootId || item.workerPid !== expected.workerPid || item.workerStart !== expected.workerStart || item.listenerInode !== expected.listenerInode
      || typeof item.nonce !== 'string' || !uuid.test(item.nonce)) throw new Error('启动证明身份不匹配');
  return item.nonce;
}
function validateAttestedStartupAdmission(value: unknown, expected: StartupIdentity & { listenerInode: string }): string {
  if (!/^[1-9][0-9]*$/.test(expected.listenerInode)) throw new Error('监听 socket 身份不可核验');
  return validateStartupAdmission(value, expected);
}
export async function waitForStartupAdmission(read: () => Promise<unknown>, expected: StartupIdentity): Promise<string> {
  return validateStartupAdmission(await read(), expected);
}

import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Reject a listener already attested during this boot; this is not an ingress fence. */
export function assertFreshListener(previous: Array<{ bootId: string; listenerInode: string }>, bootId: string, listenerInode: string): void {
  if (!uuid.test(bootId) || !/^[1-9][0-9]*$/.test(listenerInode) || previous.length > 10000) throw new Error('监听代际身份无效');
  for (const item of previous) {
    if (!item || !uuid.test(item.bootId) || !/^[1-9][0-9]*$/.test(item.listenerInode)) throw new Error('旧监听代际不可核验');
    if (item.bootId === bootId && item.listenerInode === listenerInode) throw new Error('监听代际已使用，必须关闭并重建入口');
  }
}

export function parseInheritedListener(value: string): string {
  const matched = /^socket:\[([1-9][0-9]*)\]$/.exec(value);
  if (!matched) throw new Error('继承的监听 socket 不可核验');
  return matched[1]!;
}

/** Only called in explicitly attested deployments; no fallback on timeout or malformed evidence. */
export async function readRootStartupAdmission(): Promise<string> {
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const stat = await readFile('/proc/self/stat', 'utf8');
  const end = stat.lastIndexOf(') '), fields = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/);
  const workerStart = fields[19];
  if (!uuid.test(bootId) || !workerStart || !/^[1-9][0-9]*$/.test(workerStart)) throw new Error('无法确认启动进程身份');
  const listenerInode = parseInheritedListener(await readlink('/proc/self/fd/3'));
  const expected = { bootId, workerPid: process.pid, workerStart, listenerInode };
  const directory = '/run/toonflow-trim-admission';
  for (let path = directory;; path = dirname(path)) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) || await realpath(path) !== path) throw new Error('启动证明目录不安全');
    if (path === '/') break;
  }
  const path = `${directory}/${bootId}-${process.pid}-${workerStart}.json`;
  const deadline = performance.now() + 30000;
  for (;;) {
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || performance.now() >= deadline) throw new Error('启动证明不可用');
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    try {
      const before = await file.stat(), current = await lstat(path);
      if (before.isFile() && before.uid === 0 && before.nlink === 2 && !(before.mode & 0o022) && before.dev === current.dev && before.ino === current.ino && !current.isSymbolicLink()) {
        if (performance.now() >= deadline) throw new Error('启动证明发布未完成');
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) || before.size < 1 || before.size > 4096 || before.dev !== current.dev || before.ino !== current.ino || current.isSymbolicLink()) throw new Error('启动证明文件不安全');
      const data = await file.readFile('utf8'), after = await file.stat(), onPath = await lstat(path);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.dev !== onPath.dev || before.ino !== onPath.ino || Buffer.byteLength(data) !== before.size) throw new Error('启动证明读取期间变化');
      const nonce = validateAttestedStartupAdmission(JSON.parse(data), expected);
      if (parseInheritedListener(await readlink('/proc/self/fd/3')) !== listenerInode) throw new Error('监听 socket 已变化');
      return nonce;
    } finally { await file.close(); }
  }
}

/** The attested unit must opt in with both its fixed argv and environment. */
export function startupAdmissionRequired(args: string[], mode: string | undefined): boolean {
  if (args.length === 0 && mode === undefined) return false;
  if (args.length === 1 && args[0] === '--require-startup-admission' && mode === 'root-v1') return true;
  throw new Error('启动证明模式或服务参数无效');
}
