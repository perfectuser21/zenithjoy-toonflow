// 实验性运维命令：只解除 worker active，不删除素材、不直接释放预算。
// 必须先人工屏蔽并停止 worker/socket/专用 daemon，只启动 root 独占维护 daemon。
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, readdir, stat, statfs } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { openDatabase } from "../../../packages/multiTenant/db/index";
import { withConfirmedTrimCancellation, withLiveTrimCancellationLease } from "../../../packages/multiTenant/db/backgroundBudget";
import { verifyTrimRecoveryIdentity } from "./verifyTrimRecoveryIdentity";
import { withTrustedTrimMaintenanceWindow } from "./verifyTrimMaintenanceWindow";
import { containsOldRuntimeSocket, inspectMaintenanceContainers, authorizedJournalJob, requireMatchingAppManagement, requireRuntimeBinding, runtimeProcessAssociated, type AdditionalRuntime } from "./recoveryDeploymentPolicy";

const [data, operationId, ownerId, workspaceHash, confirm, ...extra] = process.argv.slice(2);
if (process.platform !== "linux" || process.getuid?.() !== 0 || !data?.startsWith("/") || resolve(data) !== data || !operationId || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId) || !ownerId || !/^[a-zA-Z0-9_-]{1,64}$/.test(ownerId) || !workspaceHash || !/^[a-f0-9]{64}$/.test(workspaceHash) || confirm !== "--confirm-offline-recovery" || extra.length) throw new Error("需要 root、固定数据目录、操作 ID、账号、工作区摘要和离线恢复确认");
// 离线维护必须通过下方实际维护窗口、部署身份、专用运行时和账本租约核验。
// 受信维护窗口要求已登记的所有自动化与旧客户端持续停用，未知状态一律拒绝。
const state = "/var/lib/toonflow-trim/worker", daemonRoot = "/var/lib/toonflow-trim-docker", socket = "/run/toonflow-trim-maintenance/docker.sock", cgroup = "/sys/fs/cgroup/toonflow-trim-jobs";
const env = { PATH: "/usr/bin:/bin", HOME: "/root", DOCKER_HOST: `unix://${socket}`, DOCKER_CONFIG: "/run/toonflow-trim-maintenance/docker-config" };
async function command(bin: string, args: string[]) {
  const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  const timeout = setTimeout(() => proc.kill(), 15000);
  try {
    const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (exit !== 0 || out.length > 1_000_000 || err.length > 100_000) throw new Error("命令失败或结果过大");
    return out.trim();
  } finally { clearTimeout(timeout); }
}
async function rootPath(path: string) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022) || await realpath(path) !== path) throw new Error("受控路径身份无效");
  return entry;
}
for (const path of ["/usr", "/usr/bin", "/usr/bin/docker", "/usr/bin/dockerd", "/usr/bin/systemctl", "/usr/bin/systemd-escape", "/usr/bin/getent", "/usr/bin/containerd", "/var", "/var/lib", "/var/lib/toonflow-trim", "/run", "/run/toonflow-trim-maintenance", daemonRoot]) await rootPath(path);
if (await realpath(data) !== data) throw new Error("数据目录身份异常");
async function stoppedAndMasked(unit: string, service: boolean) {
  const output = await command("/usr/bin/systemctl", ["show", unit, "--property=LoadState,ActiveState,UnitFileState,MainPID,Job"]);
  const values = Object.fromEntries(output.split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (values.LoadState !== "masked" || !["masked", "masked-runtime"].includes(values.UnitFileState) || values.ActiveState !== "inactive" || values.Job || service && values.MainPID !== "0") throw new Error("旧服务未屏蔽或仍在运行");
}
// 旧固定身份仍须扫描；新部署身份只增加屏障，不替代旧屏障。
const legacyWorkerUid = Number(await command("/usr/bin/id", ["-u", "toonflow-trim-worker"]));
if (!Number.isSafeInteger(legacyWorkerUid) || legacyWorkerUid < 1) throw new Error("旧 worker 身份无效");
const groupFields = (await command("/usr/bin/getent", ["group", "toonflow-trim-docker"])).split(":");
const daemonGid = Number(groupFields[2]);
if (groupFields.length !== 4 || groupFields[0] !== "toonflow-trim-docker" || !Number.isSafeInteger(daemonGid) || daemonGid < 1) throw new Error("专用 daemon 用户组不可核验");
async function noWorkerProcesses(maintenancePid: number, runtimePid: number, workerUid: number, extra?: AdditionalRuntime, journalJobId?: string) {
  // /proc/net/unix 只覆盖当前网络命名空间；逐个进程检查独立 netns。
  const namespaces = new Set<string>();
  for (const pid of await readdir("/proc")) {
    if (!/^[0-9]+$/.test(pid)) continue;
    let status: string, args: string;
    try { [status, args] = await Promise.all([readFile(`/proc/${pid}/status`, "utf8"), readFile(`/proc/${pid}/cmdline`, "utf8")]); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") continue; throw error; }
    try {
      const ns = await stat(`/proc/${pid}/ns/net`), key = `${ns.dev}:${ns.ino}`;
      if (!namespaces.has(key)) {
        const unix = await readFile(`/proc/${pid}/net/unix`, "utf8");
        if (!unix.startsWith("Num")) throw new Error("Unix socket 状态不可核验");
        if (containsOldRuntimeSocket(unix, extra)) throw new Error("旧专用 socket 仍有监听或连接");
        namespaces.add(key);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") continue; throw error; }
    const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    const gid = /^Gid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    const groups = /^Groups:[ \t]*(.*)$/m.exec(status);
    if (!uid || !gid || !groups) throw new Error("进程身份不可核验");
    if (uid.slice(1).some(value => Number(value) === workerUid || Number(value) === legacyWorkerUid)) throw new Error("worker 身份仍有进程");
    if (!uid.slice(1).some(value => Number(value) === 0) && [...gid.slice(1), ...groups[1]!.trim().split(/\s+/)].some(value => value && (Number(value) === daemonGid || extra && Number(value) === Number(extra.dockerGid)))) throw new Error("仍有专用 daemon 组客户端");
    const parts = args.split("\0").filter(Boolean), exe = parts[0] ?? "";
    const references = ["/var/lib/toonflow-trim-docker", "/var/lib/toonflow-trim-containerd", "/run/toonflow-trim-docker/runtime", "/run/toonflow-trim-containerd", "/run/toonflow-trim-containerd/containerd.sock", "/run/toonflow-trim-docker/docker.sock"];
    if (Number(pid) !== maintenancePid && Number(pid) !== runtimePid && ["dockerd", "containerd", "containerd-shim-runc-v2"].includes(exe.split("/").pop() ?? "")
      && parts.some(value => references.some(ref => value === ref || value.endsWith(`=${ref}`) || value.endsWith(`:${ref}`)))) throw new Error("旧专用 daemon 或运行时仍在运行");
    if (extra && Number(pid) !== maintenancePid && Number(pid) !== runtimePid && ["dockerd", "containerd", "containerd-shim-runc-v2"].includes(exe.split("/").pop() ?? "")) {
      let cwd: string;
      try { cwd = await realpath(`/proc/${pid}/cwd`); }
      catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
      if (runtimeProcessAssociated(extra, exe.split("/").pop() ?? "", parts, cwd, journalJobId)) throw new Error("附加运行时或 shim 仍在运行");
    }
  }
}
async function emptyJobs() {
  const info = await lstat(cgroup);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || await realpath(cgroup) !== cgroup) throw new Error("作业 cgroup 不可核验");
  const events = await readFile(`${cgroup}/cgroup.events`, "utf8");
  if (!/^populated 0$/m.test(events)) throw new Error("作业 cgroup 仍有进程或状态未知");
}
// 仅在已确认取消、专用运行时屏障及完整容器 ID 均成立时，结束唯一匹配的孤儿 cgroup。
async function stopKnownOrphan(containerId: string, stillLeased: () => Promise<boolean>) {
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error("容器身份未知，不能终止孤儿作业");
  const root = await lstat(cgroup);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== 0 || await realpath(cgroup) !== cgroup) throw new Error("作业 cgroup 不可核验");
  const dirs = (await readdir(cgroup, { withFileTypes: true })).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name);
  if (dirs.length !== 1 || dirs[0] !== containerId) throw new Error("孤儿 cgroup 数量或身份异常");
  const child = `${cgroup}/${containerId}`, before = await lstat(child);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== 0 || await realpath(child) !== child) throw new Error("孤儿 cgroup 身份异常");
  const events = await readFile(`${child}/cgroup.events`, "utf8");
  if (!/^populated 1$/m.test(events) || !await stillLeased()) throw new Error("孤儿进程状态或取消租约异常");
  const killPath = `${child}/cgroup.kill`, killInfo = await lstat(killPath);
  if (!killInfo.isFile() || killInfo.isSymbolicLink() || killInfo.uid !== 0) throw new Error("孤儿终止入口不可核验");
  const kill = await open(killPath, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const opened = await kill.stat(), now = await lstat(child);
    if (!opened.isFile() || opened.dev !== killInfo.dev || opened.ino !== killInfo.ino || now.dev !== before.dev || now.ino !== before.ino || !await stillLeased()) throw new Error("孤儿 cgroup 身份已变化");
    await kill.writeFile("1\n");
  } finally { await kill.close(); }
  // cgroup.kill 异步生效；未及时退出时保持阻塞，绝不猜测成功。
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await readFile(`${child}/cgroup.events`, "utf8").catch(() => "");
    if (/^populated 0$/m.test(status)) return;
    await Bun.sleep(100);
  }
  throw new Error("孤儿作业尚未确认退出");
}
async function verifyRootProgram(path: string, expected: string) {
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const info = await rootPath(parent);
    if (!info.isDirectory()) throw new Error("预检程序祖先不可核验");
    if (parent === "/") break;
  }
  const before = await rootPath(path);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 512 * 1024 * 1024) throw new Error("预检程序身份异常");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await file.stat();
    if (held.dev !== before.dev || held.ino !== before.ino || held.uid !== 0 || held.nlink !== 1 || (held.mode & 0o022) || held.size !== before.size) throw new Error("预检程序已变化");
    const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    for (;;) { const { bytesRead } = await file.read(buffer); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    const after = await file.stat(), pathAfter = await lstat(path);
    if (after.dev !== held.dev || after.ino !== held.ino || after.size !== held.size || pathAfter.dev !== held.dev || pathAfter.ino !== held.ino || hash.digest("hex") !== expected) throw new Error("预检程序摘要不一致");
  } finally { await file.close(); }
}
async function additionalRuntimeStopped(runtime: AdditionalRuntime, workerUid: number) {
  const proof = runtime.proof;
  await verifyRootProgram(proof.workerExecutable, proof.workerExecutableSha256);
  await verifyRootProgram(proof.workerScript, proof.workerScriptSha256);
  if ((await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() !== proof.bootId) throw new Error("附加运行时预检不属于当前启动周期");
  for (const [pid, start] of [[proof.workerPid, proof.workerStart], [proof.daemonPid, proof.daemonStart], [proof.containerdPid, proof.containerdStart]] as const) {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => { if (["ENOENT", "ESRCH"].includes(error.code ?? "")) return null; throw error; });
    if (raw !== null) {
      const end = raw.lastIndexOf(") "), fields = end < 0 ? [] : raw.slice(end + 2).trim().split(/\s+/);
      if (fields.length < 20 || !/^[0-9]+$/.test(fields[19]!)) throw new Error("旧进程启动身份不可核验");
      if (fields[19] === start) throw new Error("预检登记的旧进程仍在运行");
    }
  }
  for (const [original, maintenance, dev, ino] of [[runtime.daemonRoot, "/var/lib/toonflow-trim-docker", proof.daemonRootDev, proof.daemonRootIno], [runtime.containerdRoot, "/var/lib/toonflow-trim-containerd", proof.containerdRootDev, proof.containerdRootIno]] as const) {
    const source = await lstat(original, { bigint: true }), target = await lstat(maintenance, { bigint: true });
    if (!source.isDirectory() || source.isSymbolicLink() || source.uid !== 0n || source.dev.toString() !== dev || source.ino.toString() !== ino || target.dev !== source.dev || target.ino !== source.ino) throw new Error("维护 daemon 数据根与事前预检不一致");
  }
  for (const [path, dev, ino] of [[runtime.daemonState, proof.daemonStateDev, proof.daemonStateIno], [runtime.containerdState, proof.containerdStateDev, proof.containerdStateIno]] as const) {
    const st = await lstat(path, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0n || st.dev.toString() !== dev || st.ino.toString() !== ino) throw new Error("附加运行时目录身份已变化");
  }
  for (const [path, dev, ino, uid, gid] of [[runtime.workerSocket, proof.workerSocketDev, proof.workerSocketIno, String(workerUid), undefined], [runtime.dockerSocket, proof.dockerSocketDev, proof.dockerSocketIno, "0", runtime.dockerGid], [runtime.containerdSocket, proof.containerdSocketDev, proof.containerdSocketIno, "0", "0"]] as const) {
    const st = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (st && (!st.isSocket() || st.isSymbolicLink() || st.uid.toString() !== uid || gid !== undefined && st.gid.toString() !== gid || st.dev.toString() !== dev || st.ino.toString() !== ino)) throw new Error("旧运行时 socket 身份变化");
  }
  for (const [unit, service] of [[runtime.workerUnit, true], [runtime.workerSocketUnit, false], [runtime.daemonUnit, true], [runtime.containerdUnit, true]] as const) await stoppedAndMasked(unit, service);
  const group = (await command("/usr/bin/getent", ["group", runtime.dockerGid])).split(":");
  if (group.length !== 4 || group[2] !== runtime.dockerGid) throw new Error("附加 daemon 授权组不可核验");
  for (const path of [runtime.daemonRoot, runtime.daemonState, runtime.containerdRoot, runtime.containerdState, dirname(runtime.dockerSocket), dirname(runtime.containerdSocket)]) {
    for (let parent = path;; parent = dirname(parent)) { const item = await rootPath(parent); if (!item.isDirectory()) throw new Error("附加运行目录不可核验"); if (parent === "/") break; }
  }
  // 受信维护窗口内 PID1/管理员不替换 cgroup 祖先；任何读取或消失错误均拒绝。
  // 只沿 cgroupfs 中逐层 lstat 的目录遍历；Bun realpath 会误解析 systemd 名称里的字面量反斜线。
  const cgroupRoot = await lstat("/sys/fs/cgroup", { bigint: true });
  if (!cgroupRoot.isDirectory() || cgroupRoot.isSymbolicLink() || cgroupRoot.uid !== 0n || await realpath("/sys/fs/cgroup") !== "/sys/fs/cgroup" || (await statfs("/sys/fs/cgroup", { bigint: true })).type !== 0x63677270n) throw new Error("cgroup 根身份不可核验");
  // 遍历整个 cgroup v2 树，不假设服务位于 system.slice。
  const names = new Set([runtime.workerUnit, runtime.daemonUnit, runtime.containerdUnit]), pending = ["/sys/fs/cgroup"];
  let scanned = 0;
  while (pending.length) {
    const path = pending.pop()!;
    if (++scanned > 100000) throw new Error("cgroup 树过大，无法核验");
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("cgroup 树存在异常链接");
      if (!entry.isDirectory()) continue;
      const child = `${path}/${entry.name}`, item = await lstat(child, { bigint: true });
      if (!item.isDirectory() || item.isSymbolicLink() || item.uid !== 0n || item.dev !== cgroupRoot.dev) throw new Error("cgroup 身份不可核验");
      if (names.has(entry.name) && !/^populated 0$/m.test(await readFile(`${child}/cgroup.events`, "utf8"))) throw new Error("附加服务 cgroup 未清空");
      pending.push(child);
    }
  }
  const taskRoot = `${runtime.containerdState}/io.containerd.runtime.v2.task`;
  const root = await rootPath(taskRoot);
  if (!root.isDirectory()) throw new Error("附加运行时任务目录不可核验");
  for (const namespace of await readdir(taskRoot, { withFileTypes: true })) {
    if (!namespace.isDirectory() || namespace.isSymbolicLink() || !/^[A-Za-z0-9_.-]+$/.test(namespace.name)) throw new Error("附加运行时任务命名空间异常");
    const path = `${taskRoot}/${namespace.name}`;
    const item = await rootPath(path);
    if (!item.isDirectory() || (await readdir(path)).length) throw new Error("附加运行时仍有任务");
  }
}
let maintenanceIdentity: { pid: number; dev: number; ino: number; runtimePid: number; runtimeDev: number; runtimeIno: number } | undefined;
async function barrier(workerUid: number, extra?: AdditionalRuntime, journalJobId?: string) {
  await stoppedAndMasked("toonflowTrimWorker.socket", false);
  await stoppedAndMasked("toonflowTrimWorker.service", true);
  await stoppedAndMasked("toonflowTrimDocker.service", true);
  await stoppedAndMasked("toonflowTrimContainerd.service", true);
  const runtimeShow = await command("/usr/bin/systemctl", ["show", "toonflowTrimMaintenanceContainerd.service", "--property=ActiveState,MainPID,ControlGroup"]);
  const runtimeValues = Object.fromEntries(runtimeShow.split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  const runtimePid = Number(runtimeValues.MainPID);
  if (runtimeValues.ActiveState !== "active" || !Number.isSafeInteger(runtimePid) || runtimePid < 1 || !runtimeValues.ControlGroup?.endsWith("/toonflowTrimMaintenanceContainerd.service")) throw new Error("维护运行时未运行或身份异常");
  const runtimeExe = await realpath(`/proc/${runtimePid}/exe`), runtimeArgs = (await readFile(`/proc/${runtimePid}/cmdline`, "utf8")).split("\0").filter(Boolean);
  const expectedRuntimeArgs = ["/usr/bin/containerd", "--config", "/etc/toonflow-trim/containerd.toml", "--root", "/var/lib/toonflow-trim-containerd", "--state", "/run/toonflow-trim-maintenance/containerd", "--address", "/run/toonflow-trim-maintenance/containerd/containerd.sock"];
  if (runtimeExe !== await realpath("/usr/bin/containerd") || JSON.stringify(runtimeArgs) !== JSON.stringify(expectedRuntimeArgs)) throw new Error("维护运行时配置异常");
  const runtimeGroup = await readFile(`/proc/${runtimePid}/cgroup`, "utf8");
  if (!runtimeGroup.split("\n").some(line => line === `0::${runtimeValues.ControlGroup}`)) throw new Error("维护运行时 cgroup 不匹配");
  const runtimeSocket = await lstat("/run/toonflow-trim-maintenance/containerd/containerd.sock");
  if (!runtimeSocket.isSocket() || runtimeSocket.isSymbolicLink() || runtimeSocket.uid !== 0 || runtimeSocket.gid !== 0 || (runtimeSocket.mode & 0o007)) throw new Error("维护运行时 socket 身份异常");
  const show = await command("/usr/bin/systemctl", ["show", "toonflowTrimMaintenance.service", "--property=ActiveState,MainPID,ControlGroup"]);
  const values = Object.fromEntries(show.split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  const pid = Number(values.MainPID);
  if (values.ActiveState !== "active" || !Number.isSafeInteger(pid) || pid < 1 || !values.ControlGroup?.endsWith("/toonflowTrimMaintenance.service")) throw new Error("维护 daemon 未运行或身份异常");
  const executable = await realpath(`/proc/${pid}/exe`), args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
  if (executable !== await realpath("/usr/bin/dockerd") || !args.includes(`--containerd=/run/toonflow-trim-maintenance/containerd/containerd.sock`) || !args.includes(`--host=unix://${socket}`) || !args.includes(`--data-root=${daemonRoot}`) || !args.includes("--exec-root=/run/toonflow-trim-maintenance/runtime") || !args.includes("--live-restore=false") || !args.includes("--group=root")) throw new Error("维护 daemon 进程身份异常");
  const procGroup = await readFile(`/proc/${pid}/cgroup`, "utf8");
  if (!procGroup.split("\n").some(line => line === `0::${values.ControlGroup}`)) throw new Error("维护 daemon cgroup 不匹配");
  if (extra) await additionalRuntimeStopped(extra, workerUid);
  await noWorkerProcesses(pid, runtimePid, workerUid, extra, journalJobId);
  const info = await lstat(socket);
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o777) !== 0o660) throw new Error("维护 socket 身份无效");
  if (maintenanceIdentity && (maintenanceIdentity.pid !== pid || maintenanceIdentity.dev !== info.dev || maintenanceIdentity.ino !== info.ino || maintenanceIdentity.runtimePid !== runtimePid || maintenanceIdentity.runtimeDev !== runtimeSocket.dev || maintenanceIdentity.runtimeIno !== runtimeSocket.ino)) throw new Error("维护 daemon、运行时或 socket 已变化");
  maintenanceIdentity ??= { pid, dev: info.dev, ino: info.ino, runtimePid, runtimeDev: runtimeSocket.dev, runtimeIno: runtimeSocket.ino };
  const details = JSON.parse(await command("/usr/bin/docker", ["info", "--format", "{{json .}}"]));
  if (details.DockerRootDir !== daemonRoot || details.LiveRestoreEnabled !== false || details.CgroupDriver !== "cgroupfs" || String(details.CgroupVersion) !== "2") throw new Error("维护 daemon 配置无效");
}
let recoveryAttemptEntered = false, outerFailed = false, outerError: unknown, alreadyRecoveredResult: boolean | undefined;
const libc = dlopen("libc.so.6", { renameat2: { args: [FFIType.int, FFIType.ptr, FFIType.int, FFIType.ptr, FFIType.u32], returns: FFIType.int } });
try {
 alreadyRecoveredResult = await withTrustedTrimMaintenanceWindow(data, async (verifyWindow, { workerUid, additionalRuntime, appManagement }) => {
  recoveryAttemptEntered = true;
  requireRuntimeBinding(workerUid, legacyWorkerUid, false, additionalRuntime);
  // UID 来自 root 受控清单，窗口核验器已按该 UID 锁定并反复核验真实 inode。
  const stateInfo = await lstat(state);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || stateInfo.uid !== workerUid || (stateInfo.mode & 0o077) || await realpath(state) !== state) throw new Error("worker 状态目录无效");
  if (additionalRuntime && (String(stateInfo.dev) !== additionalRuntime.proof.workerStateDev || String(stateInfo.ino) !== additionalRuntime.proof.workerStateIno)) throw new Error("worker 状态与预检不一致");
  const fencePath = `${state}/.worker.lock`, before = await lstat(fencePath);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== workerUid || before.nlink !== 1 || (before.mode & 0o077)) throw new Error("worker 锁无效");
  let initialJob: string | null | undefined, removedJob = false, journalJobId: string | undefined;
  const guard = async () => {
    await verifyWindow();
    await barrier(workerUid, additionalRuntime, journalJobId); // 在访问维护 daemon 前先核验其身份和独占屏障。
    const identity = await verifyTrimRecoveryIdentity(data);
    requireMatchingAppManagement(identity.appManagement, appManagement);
    requireRuntimeBinding(workerUid, legacyWorkerUid, identity.maintenanceAllowed.length > 0, additionalRuntime);
    const jobs = await inspectMaintenanceContainers(
      async () => { await verifyWindow(); await barrier(workerUid, additionalRuntime, journalJobId); },
      async () => (await command("/usr/bin/docker", ["ps", "-aq", "--no-trunc"])).split("\n").filter(Boolean),
      async id => { const result = JSON.parse(await command("/usr/bin/docker", ["inspect", id])); if (!Array.isArray(result) || result.length !== 1) throw new Error("维护容器身份不可核验"); return result[0]; },
      identity.maintenanceAllowed,
    );
    if (additionalRuntime && (identity.maintenanceAllowed.some(item => !additionalRuntime.knownContainerIds.includes(item.id)) || jobs.some(id => id !== journalJobId))) throw new Error("维护容器与静态清单或已验证任务日志不符");
    const currentJob = jobs[0] ?? null;
    if (initialJob === undefined) initialJob = currentJob;
    else if (currentJob !== (removedJob ? null : initialJob)) throw new Error("维护容器列表已变化");
    return jobs;
  };
  await verifyWindow(); // 先持双锁、核验维护窗口，再只读日志以取得动态容器身份。
  const currentPath = `${state}/active`, archivedPath = `${state}/recovered-${operationId}`;
  const current = await lstat(currentPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  // 仅在原 active 不存在时考虑只读验证已有归档，不能根据名字推测结果。
  const alreadyRecovered = !current, activePath = alreadyRecovered ? archivedPath : currentPath;
  const active = current ?? await lstat(archivedPath), journalPath = `${activePath}/lastJob.json`;
  if (!active.isDirectory() || active.isSymbolicLink() || active.uid !== workerUid || (active.mode & 0o077)) throw new Error("活动目录不可核验");
  const entries = (await readdir(activePath)).sort();
  const journalInfo = await lstat(journalPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  let journal: { operationId: string; ownerId: string; workspaceHash: string; name: string; image?: string; containerId?: string; phase?: string } | undefined;
  let orphanEntry: { name: string; dev: number; ino: number; size: number; hash: string } | undefined;
  const tmpNames = entries.filter(name => name !== "lastJob.json");
  if (tmpNames.length > 1 || tmpNames.some(name => !/^\.trim-state-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(name))) throw new Error("活动目录内容异常");
  let tmpBytes: Buffer | undefined;
  if (tmpNames.length) {
    const name = tmpNames[0]!, path = `${activePath}/${name}`, info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== workerUid || info.nlink !== 1 || (info.mode & 0o077) || info.size > 4096) throw new Error("活动临时文件异常");
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await fd.stat();
      if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size || opened.uid !== workerUid || opened.nlink !== 1 || (opened.mode & 0o077)) throw new Error("活动临时文件已变化");
      const bytes = await fd.readFile();
      if (bytes.length !== info.size) throw new Error("活动临时文件已变化");
      tmpBytes = bytes;
      orphanEntry = { name, dev: info.dev, ino: info.ino, size: info.size, hash: createHash("sha256").update(bytes).digest("hex") };
    } finally { await fd.close(); }
  }
  if (journalInfo) {
    if (!journalInfo.isFile() || journalInfo.isSymbolicLink() || journalInfo.uid !== workerUid || journalInfo.nlink !== 1 || (journalInfo.mode & 0o077) || journalInfo.size > 4096) throw new Error("活动日志不可核验");
    const journalFd = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await journalFd.stat(); if (stat.dev !== journalInfo.dev || stat.ino !== journalInfo.ino) throw new Error("日志已变化"); journal = JSON.parse(await journalFd.readFile("utf8")); } finally { await journalFd.close(); }
    if (!journal || journal.operationId !== operationId || journal.ownerId !== ownerId || journal.workspaceHash !== workspaceHash || journal.name !== `toonflow-trim-${operationId}` || !/^sha256:[a-f0-9]{64}$/.test(journal.image ?? "") || !["creating", "created", "starting", "started"].includes(journal.phase ?? "") || ((journal as any).protocolVersion !== 2) || (journal.phase === "creating" ? journal.containerId !== undefined : !/^[a-f0-9]{64}$/.test(journal.containerId ?? ""))) throw new Error("日志身份异常");
  }
  if (additionalRuntime) journalJobId = authorizedJournalJob(journal, additionalRuntime);
  if (journal && tmpBytes) {
    let candidate: any;
    try { candidate = JSON.parse(tmpBytes.toString("utf8")); } catch { candidate = undefined; }
    // 可解析的内容必须属于同一操作；不完整内容只留作证据，不能据此扩大权限。
    if (candidate !== undefined && (!candidate || typeof candidate !== "object" || candidate.protocolVersion !== 2 || candidate.operationId !== journal.operationId || candidate.ownerId !== journal.ownerId || candidate.workspaceHash !== journal.workspaceHash || candidate.name !== journal.name || candidate.image !== journal.image || (additionalRuntime && candidate.runtimeNonce !== additionalRuntime.proof.nonce) || (journal.containerId && candidate.containerId && journal.containerId !== candidate.containerId))) throw new Error("临时日志身份不一致");
  }
  // 临时文件可能在写入中途被截断；保留原始字节，不以其推断作业身份或状态。
  // 即使有完整新日志，也只能使用已持久发布的 lastJob.json 以及独立屏障作判断。
  await guard(); // 只有经过日志身份校验后才枚举并接受唯一作业。

  const db = await openDatabase(data, false);
  if (!db) throw new Error("账本不可用");
  let dbFailed = false, dbError: unknown;
  try {
    const ok = await withConfirmedTrimCancellation(db, ownerId, workspaceHash, operationId, async (stillLeased, recordVerified, hasVerified) => {
      const ids = await guard();
      if (alreadyRecovered) {
        // 必须读回同一取消意图预先写入的稳定核验证据；不得为已有目录补造证明。
        if (ids.length || !await hasVerified()) throw new Error("恢复记录缺少可核验证据或容器仍存在");
        await emptyJobs(); if (!await stillLeased()) throw new Error("取消租约已失效");
        const seals = `${state}/sealed`, sealsInfo = await lstat(seals), target = `${seals}/${operationId}`;
        if (!sealsInfo.isDirectory() || sealsInfo.isSymbolicLink() || sealsInfo.uid !== workerUid || (sealsInfo.mode & 0o077)) throw new Error("封禁目录异常");
        const info = await lstat(target), expected = JSON.stringify({ operationId, ownerId, workspaceHash });
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== workerUid || info.nlink !== 1 || (info.mode & 0o077) || info.size > 1024) throw new Error("封禁记录异常");
        const fd = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const held = await fd.stat();
          if (held.dev !== info.dev || held.ino !== info.ino || held.uid !== workerUid || held.nlink !== 1 || (held.mode & 0o077) || await fd.readFile("utf8") !== expected) throw new Error("封禁身份不符");
          await fd.sync();
        } finally { await fd.close(); }
        for (const path of [seals, archivedPath, state]) {
          const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { await dir.sync(); } finally { await dir.close(); }
        }
        await guard(); await emptyJobs();
        if (!await stillLeased() || !await hasVerified()) throw new Error("恢复租约或核验证据失效");
        const [nowArchive, nowFence, entriesNow] = await Promise.all([lstat(archivedPath), lstat(fencePath), readdir(archivedPath)]);
        if (nowArchive.dev !== active.dev || nowArchive.ino !== active.ino || nowFence.dev !== before.dev || nowFence.ino !== before.ino || JSON.stringify(entriesNow.sort()) !== JSON.stringify(entries)) throw new Error("恢复记录身份变化");
        try { await lstat(currentPath); throw new Error("活动目录重新出现"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        // 已有文件逐项检查其身份与内容，不能仅比较目录项名称。
        if (journalInfo) {
          const held = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const now = await held.stat();
            if (now.dev !== journalInfo.dev || now.ino !== journalInfo.ino || now.uid !== workerUid || now.nlink !== 1 || (now.mode & 0o077) || now.size !== journalInfo.size || !isDeepStrictEqual(JSON.parse(await held.readFile("utf8")), journal)) throw new Error("恢复日志变化");
          } finally { await held.close(); }
        }
        if (orphanEntry) {
          const held = await open(`${archivedPath}/${orphanEntry.name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const now = await held.stat(), bytes = await held.readFile();
            if (now.dev !== orphanEntry.dev || now.ino !== orphanEntry.ino || now.uid !== workerUid || now.nlink !== 1 || (now.mode & 0o077) || now.size !== orphanEntry.size || bytes.length !== orphanEntry.size || createHash("sha256").update(bytes).digest("hex") !== orphanEntry.hash) throw new Error("恢复临时日志变化");
          } finally { await held.close(); }
        }
        return true;
      }
      if (ids.length) {
        if (!journal) throw new Error("无日志时存在容器，拒绝推断其身份");
        const [container] = JSON.parse(await command("/usr/bin/docker", ["inspect", ids[0]!]));
        if (container.Id !== ids[0] || journal.containerId && journal.containerId !== ids[0] || container.Name !== `/${journal.name}` || container.Image !== journal.image || container.Config?.Labels?.["com.zenithjoy.trim.operation"] !== operationId || container.Config?.Labels?.["com.zenithjoy.trim.protocol"] !== "2" || container.HostConfig?.CgroupParent !== "/toonflow-trim-jobs") throw new Error("容器身份不符");
        await guard();
        await withLiveTrimCancellationLease(stillLeased, () => command("/usr/bin/docker", ["rm", "-f", ids[0]!]));
        removedJob = true;
      }
      await guard();
      try { await emptyJobs(); }
      catch {
        // 无完整 ID、存在其他容器或其他 cgroup 时均拒绝，不能从列表空推断作业结束。
        if (ids.length || !journal?.containerId) throw new Error("作业终态未知，不能恢复");
        await guard();
        await stopKnownOrphan(journal.containerId, stillLeased);
        await guard(); await emptyJobs();
      }
      if ((await guard()).length) throw new Error("容器尚未全部结束");
      if (!await stillLeased()) throw new Error("取消租约已失效");
      const seals = `${state}/sealed`, sealsInfo = await lstat(seals);
      if (!sealsInfo.isDirectory() || sealsInfo.isSymbolicLink() || sealsInfo.uid !== workerUid || (sealsInfo.mode & 0o077)) throw new Error("封禁目录异常");
      const target = `${seals}/${operationId}`, tmp = `${seals}/.recovery-${randomUUID()}`, record = JSON.stringify({ operationId, ownerId, workspaceHash });
      await guard();
      const f = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await f.chown(workerUid, stateInfo.gid); await f.writeFile(record); await f.sync(); } finally { await f.close(); }
      // RENAME_NOREPLACE 原子发布，不使用 link+unlink，避免崩溃留下双硬链。
      await guard(); if (!await stillLeased()) throw new Error("取消租约已失效");
      const renamed = libc.symbols.renameat2(-100, ptr(Buffer.from(`${tmp}\0`)), -100, ptr(Buffer.from(`${target}\0`)), 1);
      if (renamed !== 0) {
        // 不根据 errno 猜测原因；只有已有目标经后续完整校验才能继续。
        await lstat(target);
      }
      const existing = await lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== workerUid || existing.size > 1024 || existing.nlink !== 1 || (existing.mode & 0o077) || await readFile(target, "utf8") !== record) throw new Error("封禁记录不一致");
      const confirmed = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const entry = await confirmed.stat();
        if (!entry.isFile() || entry.dev !== existing.dev || entry.ino !== existing.ino || entry.uid !== workerUid || entry.nlink !== 1 || (entry.mode & 0o077) || entry.size !== existing.size || await confirmed.readFile("utf8") !== record) throw new Error("封禁身份异常");
        await confirmed.sync();
      } finally { await confirmed.close(); }
      const directory = await open(seals, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
      await guard(); await emptyJobs(); if (!await stillLeased()) throw new Error("取消租约已失效");
      const now = await lstat(activePath), fenceNow = await lstat(fencePath), nowEntries = (await readdir(activePath)).sort();
      if (now.dev !== active.dev || now.ino !== active.ino || fenceNow.dev !== before.dev || fenceNow.ino !== before.ino || JSON.stringify(nowEntries) !== JSON.stringify(entries)) throw new Error("状态身份已变化");
      if (journalInfo) {
        const journalNow = await lstat(journalPath);
        if (journalNow.dev !== journalInfo.dev || journalNow.ino !== journalInfo.ino || journalNow.size !== journalInfo.size) throw new Error("日志已变化");
      }
      if (orphanEntry) {
        const tmpPath = `${activePath}/${orphanEntry.name}`, tmpNow = await lstat(tmpPath);
        if (!tmpNow.isFile() || tmpNow.isSymbolicLink() || tmpNow.uid !== workerUid || tmpNow.nlink !== 1 || (tmpNow.mode & 0o077) || tmpNow.dev !== orphanEntry.dev || tmpNow.ino !== orphanEntry.ino || tmpNow.size !== orphanEntry.size) throw new Error("活动临时文件已变化");
        const fd = await open(tmpPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await fd.stat(), bytes = await fd.readFile();
          if (opened.dev !== orphanEntry.dev || opened.ino !== orphanEntry.ino || opened.uid !== workerUid || opened.nlink !== 1 || (opened.mode & 0o077) || opened.size !== orphanEntry.size || bytes.length !== orphanEntry.size || createHash("sha256").update(bytes).digest("hex") !== orphanEntry.hash) throw new Error("活动临时文件内容已变化");
        } finally { await fd.close(); }
      }
      await guard();
      if (!await recordVerified()) throw new Error("运维核验审计不可用");
      const archived = `${state}/recovered-${operationId}`;
      try { await lstat(archived); throw new Error("恢复记录已存在"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // RENAME_NOREPLACE 防止并发覆盖任何已有目录。
      await guard(); if (!await stillLeased()) throw new Error("取消租约已失效");
      if (libc.symbols.renameat2(-100, ptr(Buffer.from(`${activePath}\0`)), -100, ptr(Buffer.from(`${archived}\0`)), 1) !== 0) throw new Error("保留活动记录失败");
      const stateFd = await open(state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await stateFd.sync(); } finally { await stateFd.close(); }
      return true;
    });
    if (!ok) throw new Error("未找到已确认的取消意图或预算租约不可用");
    return alreadyRecovered;
  } catch (error) {
    dbFailed = true; dbError = error; throw error;
  } finally {
    try { await db.close(); }
    catch (error) { if (dbFailed) throw new AggregateError([dbError, error], "恢复操作和账本关闭均失败"); throw error; }
  }
 });
} catch (error) {
  // 外部动作、封禁或归档一旦开始，即使后续核验失败也不能断言没有副作用。
  outerFailed = true;
  outerError = recoveryAttemptEntered ? new Error("恢复结果未知：操作可能已生效；请在受控维护窗口读回封禁、归档及账本后再重试", { cause: error }) : error;
} finally {
  try { libc.close(); }
  catch (error) {
    if (outerFailed) throw new AggregateError([outerError, error], "恢复及运行时清理均失败");
    if (recoveryAttemptEntered) throw new Error("恢复结果未知：操作可能已生效；请在受控维护窗口读回封禁、归档及账本后再重试", { cause: error });
    throw error;
  }
}
if (outerFailed) throw outerError;
// 最终窗口检查、数据库和锁/运行时清理均完成后才能输出成功。
console.log(alreadyRecoveredResult ? "已核验此前恢复记录；仍须通过正常管理入口验证 store 并处理预算" : "worker 已持久封禁；仍须通过正常管理入口验证 store 并处理预算");
