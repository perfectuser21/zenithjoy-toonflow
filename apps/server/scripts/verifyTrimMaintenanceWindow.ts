// 实验性受信运维窗口核验器：只核验可观察条件，不能证明内核中的全部隐藏引用。
// 必须在持锁回调内执行其余部署身份、专用 daemon 与账本核验；不可单独解除恢复硬关闭。
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { dlopen, FFIType, read } from 'bun:ffi';
import { z } from 'zod';

const manifestPath = '/etc/toonflow-trim/maintenanceWindow.json';
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/);
const unit = z.string().regex(/^(?:[A-Za-z0-9_.@-]|\\x[0-9a-f]{2})+\.(service|socket|timer|mount|automount|path)$/);
const schema = z.strictObject({
  version: z.literal(1), dataPath: z.string().startsWith('/'), dataDev: uint, dataIno: uint,
  backingPath: z.string().startsWith('/'), backingDev: uint, backingIno: uint,
  workerUid: uint, workerFenceGid: uint, workerFenceDev: uint, workerFenceIno: uint,
  appFenceDev: uint, appFenceIno: uint, appFenceGid: uint, appUnit: unit, quotaUnit: unit, dataMountUnit: unit,
  // 此列表是受信部署登记的完整已知入口，而不是自动发现的全部入口。
  additionalUnits: z.array(unit).max(100),
});
const fixedUnits = ['toonflowTrimWorker.socket', 'toonflowTrimWorker.service', 'toonflowTrimDocker.service', 'toonflowTrimContainerd.service'];
async function trustedFile(path: string) {
  for (let p = dirname(path);;) {
    const st = await lstat(p);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) || await realpath(p) !== p) throw Error('维护清单祖先不安全');
    const next = dirname(p); if (p === next) break; p = next;
  }
  const pre = await lstat(path);
  if (!pre.isFile() || pre.isSymbolicLink() || pre.uid !== 0 || pre.nlink !== 1 || (pre.mode & 0o077) || pre.size > 16384) throw Error('维护清单不安全');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await fd.stat();
    if (held.dev !== pre.dev || held.ino !== pre.ino || held.size !== pre.size || held.uid !== 0 || held.nlink !== 1 || (held.mode & 0o077)) throw Error('维护清单已变化');
    return await fd.readFile('utf8');
  } finally { await fd.close(); }
}
async function checkUnit(name: string) {
  const child = Bun.spawn(['/usr/bin/systemctl', 'show', name, '--property=LoadState,ActiveState,UnitFileState,MainPID'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: '/root' } });
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code || out.length > 16384) throw Error('维护入口状态不可核验');
    const fields = Object.fromEntries(out.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    if (fields.LoadState !== 'masked' || fields.ActiveState !== 'inactive' || !['masked', 'masked-runtime'].includes(fields.UnitFileState) || (name.endsWith('.service') && fields.MainPID !== '0')) throw Error(`维护入口未停用: ${name}`);
  } finally { clearTimeout(timeout); }
}
function decodeField(s: string) { return s.replace(/\\([0-7]{3})/g, (_, v: string) => String.fromCharCode(parseInt(v, 8))); }
function deviceNumber(dev: bigint) { return `${((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n)}:${(dev & 0xffn) | ((dev >> 12n) & 0xffffff00n)}`; }
async function scan(device: string, dataPath: string, backingDev: bigint, backingIno: bigint, blockDevices: Set<string>) {
  const selfNs = await readlink('/proc/self/ns/mnt');
  if (!/^mnt:\[\d+\]$/.test(selfNs)) throw Error('维护命名空间身份不可核验');
  if (selfNs === await readlink('/proc/1/ns/mnt')) throw Error('维护进程不在独立挂载命名空间');
  const pids = (await readdir('/proc')).filter(p => /^\d+$/.test(p));
  const namespaces = new Map<string, string>();
  for (const pid of pids) {
    let ns: string;
    try { ns = await readlink(`/proc/${pid}/ns/mnt`); }
    catch (e) { if (['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) continue; throw e; }
    if (!/^mnt:\[\d+\]$/.test(ns)) throw Error('命名空间身份不可核验');
    namespaces.set(ns, pid);
  }
  if (!namespaces.has(selfNs)) throw Error('维护命名空间不可见');
  for (const [ns, pid] of namespaces) {
    const raw = await readFile(`/proc/${pid}/mountinfo`, 'utf8');
    const matches: string[] = [];
    for (const line of raw.split('\n').filter(Boolean)) {
      const fields = line.split(' '), sep = fields.indexOf('-');
      if (fields.length < 10 || sep < 6 || !/^\d+:\d+$/.test(fields[2]!)) throw Error('挂载拓扑不可核验');
      // nsfs bind 可能固定无进程命名空间；本实验不尝试证明其来源，直接拒绝。
      if (fields[sep + 1] === 'nsfs' && !/^(net|pid|user|ipc|uts|cgroup|time):\[\d+\]$/.test(decodeField(fields[3]!))) throw Error('存在固定或未知命名空间挂载');
      if (fields[2] === device) {
        if (ns === selfNs && fields.slice(6, sep).some(value => /^(shared|master|propagate_from):/.test(value))) throw Error('维护挂载传播状态不安全');
        matches.push(decodeField(fields[4]!));
      }
    }
    if (ns === selfNs ? matches.length !== 1 || matches[0] !== dataPath : matches.length !== 0) throw Error('目标卷在非预期位置挂载');
  }
  for (const pid of pids) {
    let names: string[];
    try { names = await readdir(`/proc/${pid}/fd`); }
    catch (e) { if (['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) continue; throw e; }
    for (const name of names) {
      const path = `/proc/${pid}/fd/${name}`;
      try {
        const link = await readlink(path);
        if (/^mnt:\[\d+\]$/.test(link) && !namespaces.has(link)) throw Error('存在未枚举的固定挂载命名空间');
        if (pid !== String(process.pid)) {
          const info = await stat(path, { bigint: true });
          const dev = info.isBlockDevice() ? info.rdev : info.dev; const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n), minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
          if ((info.isBlockDevice() && blockDevices.has(`${major}:${minor}`)) || (!info.isBlockDevice() && (`${major}:${minor}` === device || info.dev === backingDev && info.ino === backingIno))) throw Error('目标卷或后备设备存在其他文件句柄');
        }
      } catch (e) { if (['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) continue; throw e; }
    }
    if (pid === String(process.pid)) continue;
    try {
      const maps = await readFile(`/proc/${pid}/maps`, 'utf8');
      for (const line of maps.split('\n').filter(Boolean)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 5 || !/^[0-9a-f]+:[0-9a-f]+$/i.test(fields[3]!)) throw Error('进程映射不可核验');
        const [major, minor] = fields[3]!.split(':').map(x => parseInt(x, 16));
        if (`${major}:${minor}` === device || `${major}:${minor}` === deviceNumber(backingDev) && fields[4] === backingIno.toString()) throw Error('目标卷或后备文件存在其他进程映射');
      }
    } catch (e) { if (['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) continue; throw e; }
  }
}

export async function withTrustedTrimMaintenanceWindow<T>(dataPath: string, action: (verifyWindow: () => Promise<void>) => Promise<T>): Promise<T> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('维护核验需要 Linux root');
  const raw = await trustedFile(manifestPath), config = schema.parse(JSON.parse(raw));
  if (resolve(dataPath) !== dataPath || config.dataPath !== dataPath || await realpath(dataPath) !== dataPath || config.workerUid === '0' || config.appFenceGid === '0') throw Error('维护卷身份不符');
  const data = await lstat(dataPath, { bigint: true });
  if (!data.isDirectory() || data.isSymbolicLink() || data.dev.toString() !== config.dataDev || data.ino.toString() !== config.dataIno) throw Error('维护卷身份变化');
  const device = `${((data.dev >> 8n) & 0xfffn) | ((data.dev >> 32n) & 0xfffff000n)}:${(data.dev & 0xffn) | ((data.dev >> 12n) & 0xffffff00n)}`;
  // 本实验只支持可独立核验的整块 loop 设备；分区、mapper、堆叠设备均拒绝。
  const devicePath = await realpath(`/sys/dev/block/${device}`), deviceName = basename(devicePath);
  if (!/^loop[0-9]+$/.test(deviceName) || (await readFile(`${devicePath}/dev`, 'utf8')).trim() !== device || (await readdir(`${devicePath}/slaves`)).length !== 0 || (await readdir(`${devicePath}/holders`)).length !== 0) throw Error('不支持的块设备拓扑');
  try { await lstat(`${devicePath}/partition`); throw Error('不支持分区设备'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  async function topology() {
    if (resolve(config.backingPath) !== config.backingPath || await realpath(config.backingPath) !== config.backingPath) throw Error('后备文件路径异常');
    const file = await lstat(config.backingPath, { bigint: true });
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== 0n || (file.mode & 0o022n) !== 0n || file.dev.toString() !== config.backingDev || file.ino.toString() !== config.backingIno) throw Error('后备文件身份不符');
    const backing = (await readFile(`${devicePath}/loop/backing_file`, 'utf8')).trim();
    const activeBacking = await stat(backing, { bigint: true });
    if (activeBacking.dev !== file.dev || activeBacking.ino !== file.ino || (await readFile(`${devicePath}/loop/offset`, 'utf8')).trim() !== '0' || (await readFile(`${devicePath}/loop/sizelimit`, 'utf8')).trim() !== '0') throw Error('loop 后备关系异常');
    // 遍历所有实际 loop；无法读回后备文件身份时拒绝，包括通过硬链接指向同一文件。
    for (const loop of (await readdir('/sys/block')).filter(x => /^loop[0-9]+$/.test(x))) {
      let name: string;
      try { name = (await readFile(`/sys/block/${loop}/loop/backing_file`, 'utf8')).trim(); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      if (!name.startsWith('/')) throw Error('loop 后备路径不可核验');
      const other = await stat(name, { bigint: true });
      if (loop !== deviceName && other.dev === file.dev && other.ino === file.ino) throw Error('后备文件被其他 loop 复用');
    }
    // 同时禁止打开承载后备文件的块设备及其所有父设备/下层设备。
    const blocks = new Set<string>([device]); const pending = [deviceNumber(file.dev)];
    const protectedRanges = new Map<string, { start: bigint; end: bigint; child: string }>();
    while (pending.length) {
      const n = pending.pop()!; if (blocks.has(n)) continue;
      if (!/^\d+:\d+$/.test(n) || blocks.size > 64) throw Error('底层块设备拓扑异常');
      const p = await realpath(`/sys/dev/block/${n}`);
      if (!p.startsWith('/sys/devices/') || (await readFile(`${p}/dev`, 'utf8')).trim() !== n) throw Error('底层块设备身份异常');
      blocks.add(n);
      let partition = false;
      try { await lstat(`${p}/partition`); partition = true; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (partition) {
        const parent = dirname(p), startText = (await readFile(`${p}/start`, 'utf8')).trim(), sizeText = (await readFile(`${p}/size`, 'utf8')).trim();
        if (!/^\d+$/.test(startText) || !/^\d+$/.test(sizeText) || BigInt(sizeText) === 0n || protectedRanges.has(parent)) throw Error('底层分区范围不可核验');
        const start = BigInt(startText); protectedRanges.set(parent, { start, end: start + BigInt(sizeText), child: n });
        pending.push((await readFile(`${parent}/dev`, 'utf8')).trim());
      }
      // holder 可能是 dm 等额外映射；尚无法完整证明时不继续。
      const holders = await readdir(`${p}/holders`);
      if (holders.length) throw Error('底层块设备存在未核验的 holder');
      if (!partition) {
        for (const slave of await readdir(`${p}/slaves`)) pending.push((await readFile(`${p}/slaves/${slave}/dev`, 'utf8')).trim());
        // 其他分区可能与目标范围重叠；没有完整区间证明时保守拒绝。
        const diskSizeText = (await readFile(`${p}/size`, 'utf8')).trim(), targetRange = protectedRanges.get(p);
        if (!/^\d+$/.test(diskSizeText) || BigInt(diskSizeText) === 0n || (targetRange && targetRange.end > BigInt(diskSizeText))) throw Error('底层设备大小不可核验');
        const siblings = await readdir(p);
        for (const sibling of siblings) {
          try { await lstat(`${p}/${sibling}/partition`); }
          catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) continue; throw e; }
          const child = (await readFile(`${p}/${sibling}/dev`, 'utf8')).trim(), range = protectedRanges.get(p);
          const startText = (await readFile(`${p}/${sibling}/start`, 'utf8')).trim(), sizeText = (await readFile(`${p}/${sibling}/size`, 'utf8')).trim();
          if (!range || !/^\d+$/.test(startText) || !/^\d+$/.test(sizeText) || BigInt(sizeText) === 0n) throw Error('底层设备分区范围不可核验');
          const start = BigInt(startText), end = start + BigInt(sizeText);
          if (end > BigInt(diskSizeText) || child !== range.child && start < range.end && range.start < end) throw Error('底层设备存在重叠或越界分区');
        }
      }
    }
    return { file, blocks };
  }
  const escape = Bun.spawn(['/usr/bin/systemd-escape', '--path', '--suffix=mount', dataPath], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: '/root' } });
  const escapeTimeout = setTimeout(() => escape.kill(), 10000);
  let mountName: string;
  try { const [out, code] = await Promise.all([new Response(escape.stdout).text(), escape.exited]); if (code || out.length > 4096) throw Error('数据挂载单元不可核验'); mountName = out.trim(); }
  finally { clearTimeout(escapeTimeout); }
  if (!config.dataMountUnit.endsWith('.mount') || config.dataMountUnit !== mountName) throw Error('数据挂载单元与目标路径不符');
  const names = [...fixedUnits, config.appUnit, config.quotaUnit, config.dataMountUnit, ...config.additionalUnits];
  if (new Set(names).size !== names.length || !config.appUnit.endsWith('.service') || !config.quotaUnit.endsWith('.service')) throw Error('维护入口清单无效');
  const workerPath = '/var/lib/toonflow-trim/worker/.worker.lock', appDir = resolve(dataPath, 'projectQuota'), appPath = resolve(appDir, '.trimApp.lock');
  const workerDir = dirname(workerPath), workerDirInfo = await lstat(workerDir, { bigint: true }), appDirInfo = await lstat(appDir, { bigint: true });
  if (!workerDirInfo.isDirectory() || workerDirInfo.isSymbolicLink() || workerDirInfo.uid.toString() !== config.workerUid || (workerDirInfo.mode & 0o077n) !== 0n || await realpath(workerDir) !== workerDir || !appDirInfo.isDirectory() || appDirInfo.isSymbolicLink() || appDirInfo.uid !== 0n || (appDirInfo.mode & 0o022n) !== 0n || appDirInfo.dev !== data.dev || await realpath(appDir) !== appDir) throw Error('维护锁目录身份不符');
  const libc = dlopen('libc.so.6', { flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int }, fcntl: { args: [FFIType.int, FFIType.int, FFIType.int], returns: FFIType.int }, __errno_location: { args: [], returns: FFIType.ptr } });
  const held: Awaited<ReturnType<typeof open>>[] = [];
  async function lock(path: string, uid: string, gid: string | undefined, mode: bigint, dev: string, ino: string) {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.uid.toString() !== uid || (gid !== undefined && before.gid.toString() !== gid) || before.nlink !== 1n || (before.mode & 0o7777n) !== mode || before.dev.toString() !== dev || before.ino.toString() !== ino) throw Error('维护锁身份不符');
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); held.push(fd);
    const current = await fd.stat({ bigint: true });
    if (current.dev !== before.dev || current.ino !== before.ino || current.uid !== before.uid || current.gid !== before.gid || current.nlink !== 1n || (current.mode & 0o7777n) !== mode || libc.symbols.fcntl(fd.fd, 2, 1) !== 0 || libc.symbols.flock(fd.fd, 6) !== 0) throw Error('维护锁不可用');
  }
  async function check() {
    if (await trustedFile(manifestPath) !== raw) throw Error('维护清单变化');
    const now = await lstat(dataPath, { bigint: true });
    if (now.dev !== data.dev || now.ino !== data.ino) throw Error('维护卷已变化');
    await Promise.all(names.map(checkUnit));
    const topo = await topology();
    await scan(device, dataPath, topo.file.dev, topo.file.ino, topo.blocks);
    const afterTopo = await topology();
    if (afterTopo.file.dev !== topo.file.dev || afterTopo.file.ino !== topo.file.ino || [...topo.blocks].sort().join() !== [...afterTopo.blocks].sort().join()) throw Error('后备拓扑变化');
    const workerDirNow = await lstat(workerDir, { bigint: true }), appDirNow = await lstat(appDir, { bigint: true });
    if (workerDirNow.dev !== workerDirInfo.dev || workerDirNow.ino !== workerDirInfo.ino || workerDirNow.uid !== workerDirInfo.uid || (workerDirNow.mode & 0o077n) !== 0n || appDirNow.dev !== appDirInfo.dev || appDirNow.ino !== appDirInfo.ino || appDirNow.uid !== 0n || (appDirNow.mode & 0o022n) !== 0n) throw Error('维护锁目录变化');
    for (let i = 0; i < held.length; i++) {
      const current = await held[i]!.stat({ bigint: true });
      const path = i === 0 ? workerPath : appPath, entry = await lstat(path, { bigint: true });
      const expected = i === 0
        ? { uid: config.workerUid, gid: config.workerFenceGid, dev: config.workerFenceDev, ino: config.workerFenceIno, mode: 0o600n }
        : { uid: '0', gid: config.appFenceGid, dev: config.appFenceDev, ino: config.appFenceIno, mode: 0o640n };
      const matches = (info: typeof entry) => info.isFile() && !info.isSymbolicLink() && info.uid.toString() === expected.uid && info.gid.toString() === expected.gid && info.dev.toString() === expected.dev && info.ino.toString() === expected.ino && (info.mode & 0o7777n) === expected.mode && info.nlink === 1n;
      const flags = libc.symbols.fcntl(held[i]!.fd, 1, 0);
      if (flags < 0 || (flags & 1) !== 1 || !matches(current) || !matches(entry)) throw Error('维护锁身份变化');
      // 重新 open 得到不同 open-file-description；只能接受明确的 EWOULDBLOCK。
      const probe = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const identity = await probe.stat({ bigint: true });
        if (identity.dev !== current.dev || identity.ino !== current.ino || identity.uid !== current.uid || identity.gid !== current.gid || identity.nlink !== 1n) throw Error('锁竞争探针身份变化');
        const result = libc.symbols.flock(probe.fd, 6);
        const errnoPointer = result === -1 ? libc.symbols.__errno_location() : null;
        if (result === -1 && !errnoPointer) throw Error('锁竞争错误码不可核验');
        const errno = errnoPointer ? read.i32(errnoPointer, 0) : 0;
        if (result !== -1 || errno !== 11) throw Error('维护锁未持续持有或竞争状态未知');
      } finally { await probe.close(); }

    }
  }
  let failed = false, primary: unknown;
  try {
    await lock(workerPath, config.workerUid, config.workerFenceGid, 0o600n, config.workerFenceDev, config.workerFenceIno);
    await lock(appPath, '0', config.appFenceGid, 0o640n, config.appFenceDev, config.appFenceIno);
    await check();
    // 调用者仍必须在持锁期间执行 daemon、账本与持续屏障校验。
    const result = await action(check);
    await check();
    return result;
  } catch (error) {
    failed = true; primary = error; throw error;
  } finally {
    const closed = await Promise.allSettled(held.reverse().map(fd => fd.close()));
    const cleanup: unknown[] = closed.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    try { libc.close(); } catch (error) { cleanup.push(error); }
    if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, '维护窗口或锁清理失败');
  }
}
