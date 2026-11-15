// 在允许任务进入前采集受信运行时。只接受 root 受控模板，禁止覆盖旧证明。
import { constants } from 'node:fs';
import { lstat, stat, open, readFile, readlink, readdir, realpath, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { dlopen, FFIType, read } from 'bun:ffi';
import { trustedAdditionalRuntime, trustedWorkerUid, runtimeProofPath, requireExpectedRuntimeHashes } from './recoveryDeploymentPolicy';
import { assertFreshListener } from './trimStartupAdmission';

const templatePath = '/etc/toonflow-trim/runtimePreflight.json';
if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.argv.length !== 2) throw new Error('需要 Linux root 和固定预检模板');
// 入口未屏蔽且旧 socket 未重建前，不能证明预检先于任何任务。
throw new Error('任务入口屏障尚未完成，禁止生成运行时预检证明');
async function controlled(path: string, secret = false) {
  if (resolve(path) !== path || await realpath(path) !== path) throw new Error('预检路径不可核验');
  for (let p = dirname(path);; p = dirname(p)) {
    const s = await lstat(p);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) || await realpath(p) !== p) throw new Error('预检路径祖先不安全');
    if (p === '/') break;
  }
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || st.nlink !== 1 || (st.mode & (secret ? 0o077 : 0o022)) || st.size < 1 || st.size > 512 * 1024 * 1024) throw new Error('预检文件不安全');
  return st;
}
async function bytes(path: string, secret = false) {
  const before = await controlled(path, secret), fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await fd.stat();
    if (held.dev !== before.dev || held.ino !== before.ino || held.size !== before.size || held.uid !== 0 || held.nlink !== 1 || (held.mode & (secret ? 0o077 : 0o022))) throw new Error('预检文件已变化');
    const data = await fd.readFile(), after = await fd.stat(), pathAfter = await lstat(path);
    if (after.dev !== held.dev || after.ino !== held.ino || after.size !== held.size || pathAfter.dev !== held.dev || pathAfter.ino !== held.ino || data.length !== held.size) throw new Error('预检文件读取期间变化');
    return data;
  } finally { await fd.close(); }
}
async function run(bin: string, args: string[]) {
  const p = Bun.spawn([bin, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', HOME: '/root' } });
  const timer = setTimeout(() => p.kill(), 15000);
  try { const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); if (code !== 0 || out.length > 1000000 || err.length > 100000) throw new Error('预检命令失败'); return out.trim(); }
  finally { clearTimeout(timer); }
}
function sha(data: Buffer) { return createHash('sha256').update(data).digest('hex'); }
function startTime(raw: string) { const end = raw.lastIndexOf(') '), fields = end < 0 ? [] : raw.slice(end + 2).trim().split(/\s+/); if (fields.length < 20 || !/^[1-9][0-9]*$/.test(fields[19]!)) throw new Error('进程启动时间不可核验'); return fields[19]!; }
const request = JSON.parse((await bytes(templatePath, true)).toString('utf8'));
if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).sort().join(',') !== 'additionalRuntime,additionalUnits,expectedHashes,workerExecutable,workerScript,workerUid' || !Array.isArray(request.additionalUnits)) throw new Error('预检模板格式异常');
const workerUid = trustedWorkerUid(request.workerUid);
const placeholder = { nonce: '00000000-0000-4000-8000-000000000002', capturedAt: '1', workerExecutable: request.workerExecutable, workerScript: request.workerScript,
  workerExecutableSha256: '0'.repeat(64), workerScriptSha256: '0'.repeat(64), workerUnitSha256: '0'.repeat(64), workerSocketUnitSha256: '0'.repeat(64), daemonUnitSha256: '0'.repeat(64), containerdUnitSha256: '0'.repeat(64),
  bootId: '00000000-0000-4000-8000-000000000001', workerPid: '1', workerStart: '1', daemonPid: '2', daemonStart: '1', containerdPid: '3', containerdStart: '1', workerStateDev: '1', workerStateIno: '1', workerLockDev: '1', workerLockIno: '1', daemonRootDev: '1', daemonRootIno: '1', containerdRootDev: '1', containerdRootIno: '1', workerSocketDev: '1', workerSocketIno: '1', listenerInode: '1', daemonStateDev: '1', daemonStateIno: '1', containerdStateDev: '1', containerdStateIno: '1', dockerSocketDev: '1', dockerSocketIno: '1', containerdSocketDev: '1', containerdSocketIno: '1' };
const runtime = trustedAdditionalRuntime({ ...request.additionalRuntime, proof: placeholder }, request.additionalUnits);
if (!runtime) throw new Error('缺少运行时模板');
const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
if (await lstat(`${runtime.workerState}/active`).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error('worker 已有任务，不得补造事前预检');
async function unit(name: string, service: boolean) {
  const out = await run('/usr/bin/systemctl', ['show', name, '--property=LoadState,ActiveState,MainPID,Job,FragmentPath,DropInPaths,NeedDaemonReload,ControlGroup,ExecStart,Listen']);
  const fields = Object.fromEntries(out.split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (fields.LoadState !== 'loaded' || fields.ActiveState !== 'active' || fields.Job || fields.DropInPaths || fields.NeedDaemonReload !== 'no' || !fields.FragmentPath?.startsWith('/')) throw new Error('预检 unit 未稳定运行');
  const hash = sha(await bytes(fields.FragmentPath));
  if (!service) { if (fields.Listen !== `${runtime!.workerSocket} (Stream)`) throw new Error('worker socket unit 不匹配'); return { fields, hash, pid: 0, start: '', args: [] as string[] }; }
  const pid = Number(fields.MainPID);
  if (!Number.isSafeInteger(pid) || pid < 2 || !fields.ControlGroup) throw new Error('预检进程不可核验');
  const [stat, cgroup, cmd] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/cgroup`, 'utf8'), readFile(`/proc/${pid}/cmdline`)]);
  if (!cgroup.split('\n').includes(`0::${fields.ControlGroup}`)) throw new Error('预检进程 cgroup 不匹配');
  const args = cmd.toString('utf8').split('\0').filter(Boolean), match = /argv\[\]=([^;]+) ;/.exec(fields.ExecStart ?? '');
  if (!match || !args.length || match[1]!.trim() !== args.join(' ')) throw new Error('运行参数与加载的 unit 不一致');
  return { fields, hash, pid, start: startTime(stat), args };
}
const worker = await unit(runtime.workerUnit, true), workerSocketUnit = await unit(runtime.workerSocketUnit, false);
const daemon = await unit(runtime.daemonUnit, true), containerd = await unit(runtime.containerdUnit, true);
if (new Set([worker.pid, daemon.pid, containerd.pid]).size !== 3) throw new Error('运行时 PID 冲突');
const workerStatus = await readFile(`/proc/${worker.pid}/status`, 'utf8'), daemonStatus = await readFile(`/proc/${daemon.pid}/status`, 'utf8'), containerdStatus = await readFile(`/proc/${containerd.pid}/status`, 'utf8');
function uid(status: string) { const m = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status); if (!m || !m.slice(1).every(x => x === m[1])) throw new Error('进程 UID 不可核验'); return Number(m[1]); }
const groups = /^Groups:\s*(.*)$/m.exec(workerStatus)?.[1]?.trim().split(/\s+/) ?? [];
if (uid(workerStatus) !== workerUid || uid(daemonStatus) !== 0 || uid(containerdStatus) !== 0 || !groups.includes(runtime.dockerGid)) throw new Error('运行时用户或授权组不一致');
const workerExe = await realpath(request.workerExecutable), workerScript = await realpath(request.workerScript);
if (workerExe !== request.workerExecutable || workerScript !== request.workerScript || await realpath(`/proc/${worker.pid}/exe`) !== workerExe || worker.args.length !== 3 || worker.args[2] !== '--require-startup-admission' || await realpath(worker.args[0]!) !== workerExe || await realpath(worker.args[1]!) !== workerScript) throw new Error('worker 程序身份不一致');
const workerExecutableSha256 = sha(await bytes(workerExe)), workerScriptSha256 = sha(await bytes(workerScript));
requireExpectedRuntimeHashes(request.expectedHashes, { workerExecutableSha256, workerScriptSha256, workerUnitSha256: worker.hash, workerSocketUnitSha256: workerSocketUnit.hash, daemonUnitSha256: daemon.hash, containerdUnitSha256: containerd.hash });
const env = (await readFile(`/proc/${worker.pid}/environ`)).toString('utf8').split('\0');
if (env.filter(x => x === 'TOONFLOW_TRIM_STARTUP_ADMISSION=root-v1').length !== 1) throw new Error('worker 未启用事前握手');
for (const entry of [`LISTEN_PID=${worker.pid}`, 'LISTEN_FDS=1', 'LISTEN_FDNAMES=trimWorker']) if (env.filter(x => x === entry).length !== 1) throw new Error('worker 监听继承信息无效');
const workerFd = await readlink(`/proc/${worker.pid}/fd/3`);
const matchFd = /^socket:\[([1-9][0-9]*)\]$/.exec(workerFd);
if (!matchFd) throw new Error('worker 监听描述符无效');
let pid1HasFd = false;
for (const fd of await readdir('/proc/1/fd')) {
  try { if (await readlink(`/proc/1/fd/${fd}`) === workerFd) pid1HasFd = true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
const unixRows = (await readFile('/proc/net/unix', 'utf8')).split('\n').map(line => line.trim().split(/\s+/));
const matches = unixRows.filter(row => row[6] === matchFd[1] && row[7] === runtime.workerSocket && row[4] === '0001' && row[3] === '00010000');
if (!pid1HasFd || matches.length !== 1) throw new Error('worker 监听不是 PID1 持有的目标 socket');

for (const [key, value] of [['TOONFLOW_TRIM_SOCKET', runtime.workerSocket], ['TOONFLOW_TRIM_STATE', runtime.workerVisibleState], ['TOONFLOW_TRIM_DAEMON_SOCKET', runtime.dockerSocket]]) if (env.filter(x => x === `${key}=${value}`).length !== 1) throw new Error('worker 配置与运行时不一致');
function option(args: string[], key: string) {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === key && i + 1 < args.length) found.push(args[++i]!); else if (args[i]!.startsWith(`${key}=`)) found.push(args[i]!.slice(key.length + 1)); }
  if (found.length !== 1) throw new Error('daemon 参数不唯一'); return found[0];
}
if (await realpath(`/proc/${daemon.pid}/exe`) !== await realpath('/usr/bin/dockerd') || option(daemon.args, '--host') !== `unix://${runtime.dockerSocket}` || option(daemon.args, '--data-root') !== runtime.daemonRoot || option(daemon.args, '--exec-root') !== runtime.daemonState || option(daemon.args, '--containerd') !== runtime.containerdSocket) throw new Error('Docker 进程配置不匹配');
if (await realpath(`/proc/${containerd.pid}/exe`) !== await realpath('/usr/bin/containerd') || option(containerd.args, '--root') !== runtime.containerdRoot || option(containerd.args, '--state') !== runtime.containerdState || option(containerd.args, '--address') !== runtime.containerdSocket) throw new Error('containerd 进程配置不匹配');
const info = JSON.parse(await run('/usr/bin/docker', [`--host=unix://${runtime.dockerSocket}`, 'info', '--format', '{{json .}}']));
if (info.DockerRootDir !== runtime.daemonRoot || info.LiveRestoreEnabled !== false || info.CgroupDriver !== 'cgroupfs' || String(info.CgroupVersion) !== '2') throw new Error('Docker 运行时配置不符合恢复合同');
const ids = (await run('/usr/bin/docker', [`--host=unix://${runtime.dockerSocket}`, 'ps', '-aq', '--no-trunc'])).split('\n').filter(Boolean).sort();
if (JSON.stringify(ids) !== JSON.stringify([...runtime.knownContainerIds].sort())) throw new Error('容器列表与预先登记清单不一致');
for (const id of ids) { const value = JSON.parse(await run('/usr/bin/docker', [`--host=unix://${runtime.dockerSocket}`, 'inspect', id])); if (!Array.isArray(value) || value.length !== 1 || value[0]?.Id !== id) throw new Error('登记容器不可核验'); }
const python = 'import socket,struct,sys;s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(3);s.connect(sys.argv[1]);print(*struct.unpack("3i",s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12)));s.close()';
async function peer(path: string, pid: number) { const result = (await run('/usr/bin/python3', ['-c', python, path])).split(' '); if (result.length !== 3 || Number(result[0]) !== pid || Number(result[1]) !== 0) throw new Error('socket 对端不是已登记进程'); }
await peer(runtime.dockerSocket, daemon.pid); await peer(runtime.containerdSocket, containerd.pid);
for (let p = dirname(runtime.workerVisibleState);; p = dirname(p)) {
  const st = await lstat(`/proc/${worker.pid}/root${p}`);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) throw new Error('worker 私有路径祖先不安全');
  if (p === '/') break;
}
const visibleWorkerState = await lstat(`/proc/${worker.pid}/root${runtime.workerVisibleState}`, { bigint: true });
const workerState = await lstat(runtime.workerState, { bigint: true }), daemonRoot = await lstat(runtime.daemonRoot, { bigint: true }), containerdRoot = await lstat(runtime.containerdRoot, { bigint: true }), daemonState = await lstat(runtime.daemonState, { bigint: true }), containerdState = await lstat(runtime.containerdState, { bigint: true });
if (!visibleWorkerState.isDirectory() || visibleWorkerState.isSymbolicLink() || visibleWorkerState.dev !== workerState.dev || visibleWorkerState.ino !== workerState.ino) throw new Error('worker 私有挂载与宿主状态目录不一致');
if (!workerState.isDirectory() || workerState.isSymbolicLink() || workerState.uid.toString() !== request.workerUid || (workerState.mode & 0o077n) || !daemonRoot.isDirectory() || daemonRoot.isSymbolicLink() || daemonRoot.uid !== 0n || !containerdRoot.isDirectory() || containerdRoot.isSymbolicLink() || containerdRoot.uid !== 0n || !daemonState.isDirectory() || daemonState.isSymbolicLink() || daemonState.uid !== 0n || !containerdState.isDirectory() || containerdState.isSymbolicLink() || containerdState.uid !== 0n) throw new Error('运行目录身份不符');
const dockerSocket = await lstat(runtime.dockerSocket, { bigint: true }), containerdSocket = await lstat(runtime.containerdSocket, { bigint: true }), workerSocket = await lstat(runtime.workerSocket, { bigint: true });
if (!dockerSocket.isSocket() || dockerSocket.uid !== 0n || dockerSocket.gid.toString() !== runtime.dockerGid || !containerdSocket.isSocket() || containerdSocket.uid !== 0n || containerdSocket.gid !== 0n || !workerSocket.isSocket() || workerSocket.uid.toString() !== request.workerUid) throw new Error('socket 身份不匹配');
const libc = dlopen('libc.so.6', { flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int }, __errno_location: { args: [], returns: FFIType.ptr } });
const workerLock = await open(`${runtime.workerState}/.worker.lock`, constants.O_RDONLY | constants.O_NOFOLLOW);
let workerLockDev = '', workerLockIno = '';
try {
 const st = await workerLock.stat();
 workerLockDev = String(st.dev); workerLockIno = String(st.ino);
 if (!st.isFile() || st.uid !== workerUid || st.nlink !== 1 || (st.mode & 0o777) !== 0o600) throw new Error('worker 锁身份不匹配');
 let foundWorkerFd = false;
 for (const entry of await readdir(`/proc/${worker.pid}/fd`)) {
   try { const fdStat = await stat(`/proc/${worker.pid}/fd/${entry}`); if (fdStat.isFile() && fdStat.dev === st.dev && fdStat.ino === st.ino) foundWorkerFd = true; }
   catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
 }
 const dev = BigInt(st.dev), major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n), minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
 const lockRows = (await readFile('/proc/locks', 'utf8')).trim().split('\n').map(line => line.trim().split(/\s+/));
 const matches = lockRows.filter(row => {
   const id = /^([a-f0-9]+):([a-f0-9]+):([0-9]+)$/i.exec(row[5] ?? '');
   return row[1] === 'FLOCK' && row[2] === 'ADVISORY' && row[3] === 'WRITE' && row[4] === String(worker.pid)
     && !!id && BigInt(`0x${id[1]}`) === major && BigInt(`0x${id[2]}`) === minor && BigInt(id[3]!) === BigInt(st.ino);
 });
 if (!foundWorkerFd || matches.length !== 1) throw new Error('worker 没有持有登记的独占锁');
 const result = libc.symbols.flock(workerLock.fd, 6), err = result === -1 ? libc.symbols.__errno_location() : null;
 if (result !== -1 || !err || read.i32(err, 0) !== 11) throw new Error('worker 锁未被占有');
} finally { await workerLock.close(); libc.close(); }
for (const item of [worker, daemon, containerd]) if (startTime(await readFile(`/proc/${item.pid}/stat`, 'utf8')) !== item.start) throw new Error('预检进程发生变化');
if ((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() !== bootId || await lstat(`${runtime.workerState}/active`).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error('预检期间任务或启动周期发生变化');
const proof = { nonce: randomUUID(), capturedAt: String(Date.now()), bootId, workerExecutable: workerExe, workerScript, workerExecutableSha256, workerScriptSha256,
  workerUnitSha256: worker.hash, workerSocketUnitSha256: workerSocketUnit.hash, daemonUnitSha256: daemon.hash, containerdUnitSha256: containerd.hash,
  workerPid: String(worker.pid), workerStart: worker.start, daemonPid: String(daemon.pid), daemonStart: daemon.start, containerdPid: String(containerd.pid), containerdStart: containerd.start,
  workerStateDev: String(workerState.dev), workerStateIno: String(workerState.ino), workerLockDev, workerLockIno, daemonRootDev: String(daemonRoot.dev), daemonRootIno: String(daemonRoot.ino), containerdRootDev: String(containerdRoot.dev), containerdRootIno: String(containerdRoot.ino), workerSocketDev: String(workerSocket.dev), workerSocketIno: String(workerSocket.ino), listenerInode: matchFd[1]!, daemonStateDev: String(daemonState.dev), daemonStateIno: String(daemonState.ino), containerdStateDev: String(containerdState.dev), containerdStateIno: String(containerdState.ino), dockerSocketDev: String(dockerSocket.dev), dockerSocketIno: String(dockerSocket.ino), containerdSocketDev: String(containerdSocket.dev), containerdSocketIno: String(containerdSocket.ino) };
const additionalRuntime = trustedAdditionalRuntime({ ...request.additionalRuntime, proof }, request.additionalUnits);
const output = JSON.stringify({ workerUid: request.workerUid, additionalRuntime });
if (!additionalRuntime) throw new Error('预检身份不可用');
const proofPath = runtimeProofPath(additionalRuntime);
for (let p = dirname(proofPath);; p = dirname(p)) {
  const st = await lstat(p);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) || await realpath(p) !== p) throw new Error('预检证明目录不安全');
  if (p === '/') break;
}
// Root-provisioned lock serializes generation scan and both durable publications.
const generationLockPath = '/etc/toonflow-trim/runtime-proofs.lock';
const lockBefore = await lstat(generationLockPath);
if (!lockBefore.isFile() || lockBefore.isSymbolicLink() || lockBefore.uid !== 0 || lockBefore.nlink !== 1 || (lockBefore.mode & 0o777) !== 0o600) throw new Error('预检代际锁不安全');
const generationLock = await open(generationLockPath, constants.O_RDWR | constants.O_NOFOLLOW);
const generationLibc = dlopen('libc.so.6', { flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int } });
try {
  const held = await generationLock.stat(), current = await lstat(generationLockPath);
  if (held.dev !== lockBefore.dev || held.ino !== lockBefore.ino || held.dev !== current.dev || held.ino !== current.ino || held.uid !== 0 || held.nlink !== 1 || (held.mode & 0o777) !== 0o600) throw new Error('预检代际锁身份变化');
  if (generationLibc.symbols.flock(generationLock.fd, 6) !== 0) throw new Error('预检代际锁已占用');
// A previously attested listener cannot be reused.  This alone cannot prove
// old clients or accepted FDs have drained; the collector remains hard-closed.
const priorNames = await readdir(dirname(proofPath));
if (priorNames.length > 10000) throw new Error('历史预检证明过多');
const priorListeners: Array<{ bootId: string; listenerInode: string }> = [];
for (const name of priorNames) {
  if (!/^[a-f0-9-]+-[1-9][0-9]*-[1-9][0-9]*\.json$/.test(name)) throw new Error('历史预检目录包含未知文件');
  const oldPath = resolve(dirname(proofPath), name), st = await controlled(oldPath, true);
  if (st.size > 65536) throw new Error('历史预检证明过大');
  const old = JSON.parse((await bytes(oldPath, true)).toString('utf8'));
  if (!old || Object.keys(old).sort().join(',') !== 'additionalRuntime,workerUid') throw new Error('历史预检证明格式异常');
  trustedWorkerUid(old.workerUid);
  const prior = trustedAdditionalRuntime(old.additionalRuntime, request.additionalUnits);
  if (!prior || runtimeProofPath(prior) !== oldPath) throw new Error('历史预检证明身份不符');
  priorListeners.push({ bootId: prior.proof.bootId, listenerInode: prior.proof.listenerInode });
}
assertFreshListener(priorListeners, bootId, matchFd[1]!);
const tmp = `${proofPath}.${randomUUID()}.tmp`, fd = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
try { await fd.writeFile(output); await fd.sync(); } finally { await fd.close(); }
await link(tmp, proofPath); // 不覆盖；若崩溃留下双硬链，离线核验会拒绝。
const directory = await open(dirname(proofPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
try { await directory.sync(); await unlink(tmp); await directory.sync(); } finally { await directory.close(); }


// 独立公开回执不含凭据，只在完整 root 证明落盘后发布；名称绑定进程实例。
const admissionDirectory = '/run/toonflow-trim-admission';
for (let p = admissionDirectory;; p = dirname(p)) {
  const st = await lstat(p);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) || await realpath(p) !== p) throw new Error('启动证明目录不安全');
  if (p === '/') break;
}
const admissionPath = `${admissionDirectory}/${bootId}-${worker.pid}-${worker.start}.json`;
const admissionTmp = `${admissionPath}.${randomUUID()}.tmp`;
const admissionFd = await open(admissionTmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
try {
  await admissionFd.chmod(0o644);
  await admissionFd.writeFile(JSON.stringify({ bootId, workerPid: worker.pid, workerStart: worker.start, listenerInode: matchFd[1], nonce: proof.nonce }));
  await admissionFd.sync();
} finally { await admissionFd.close(); }
// link 保证不覆盖；任何中断留下的双链接由 worker 拒绝，需人工核查。
await link(admissionTmp, admissionPath);
const admissionDirFd = await open(admissionDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
try { await admissionDirFd.sync(); await unlink(admissionTmp); await admissionDirFd.sync(); } finally { await admissionDirFd.close(); }

} finally {
  try { await generationLock.close(); } finally { generationLibc.close(); }
}
console.log('运行时任务前预检及启动回执已持久化');
