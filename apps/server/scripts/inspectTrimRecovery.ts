// 只读诊断未知裁剪；本工具不结束任务、不删除锁、不释放预算。
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { acquireWorkerFence } from "./trimWorkerFence";

const [stateArg, operationArg, ...extra] = process.argv.slice(2);
if (process.platform !== "linux" || !stateArg?.startsWith("/") || !operationArg || extra.length) throw new Error("用法：inspectTrimRecovery <worker状态目录> <操作ID>");
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationArg)) throw new Error("操作ID无效");
const operationId = operationArg, state = resolve(stateArg);
for (let path = dirname(state);;) {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022) || await realpath(path) !== path) throw new Error("状态目录祖先不安全");
  const next = dirname(path); if (next === path) break; path = next;
}
// 诊断不能替首次运行建立锁；只有现存文件和原 worker 共享 inode 的锁才有意义。
const lockPath = resolve(state, ".worker.lock"), lockInfo = await lstat(lockPath);
if (!lockInfo.isFile() || lockInfo.isSymbolicLink() || lockInfo.nlink !== 1) throw new Error("worker 锁不可核验");
const fence = await acquireWorkerFence(state);
try {
  const held = await fence.stat();
  if (held.dev !== lockInfo.dev || held.ino !== lockInfo.ino) throw new Error("worker 锁已变化");
  const activePath = resolve(state, "active"), active = await lstat(activePath);
  if (!active.isDirectory() || active.isSymbolicLink() || active.uid !== process.getuid?.() || (active.mode & 0o077) || await realpath(activePath) !== activePath) throw new Error("活动状态不可核验");
  const journalPath = resolve(activePath, "lastJob.json"), before = await lstat(journalPath);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.() || before.nlink !== 1 || (before.mode & 0o077) || before.size > 4096) throw new Error("作业日志不可核验");
  const fd = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const held = await fd.stat();
    if (held.dev !== before.dev || held.ino !== before.ino || held.size !== before.size || held.uid !== before.uid || held.nlink !== 1 || (held.mode & 0o077)) throw new Error("作业日志已变化");
    raw = await fd.readFile("utf8");
  } finally { await fd.close(); }
  const item = JSON.parse(raw);
  const keys = ["name", "operationId", "ownerId", "workspaceHash", "image", "managerPid", "childPid", "containerId", "phase", "protocolVersion", "startedAt"];
  if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !keys.includes(key)) || typeof item.ownerId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.ownerId) || typeof item.workspaceHash !== "string" || !/^[a-f0-9]{64}$/.test(item.workspaceHash) || typeof item.image !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.image) || !Number.isSafeInteger(item.managerPid) || item.managerPid < 1 || item.childPid !== undefined && (!Number.isSafeInteger(item.childPid) || item.childPid < 1) || item.containerId !== undefined && (typeof item.containerId !== "string" || !/^[a-f0-9]{64}$/.test(item.containerId)) || !["creating", "created", "starting", "started"].includes(item.phase) || item.protocolVersion !== 2 || !Number.isSafeInteger(item.startedAt) || item.startedAt < 0) throw new Error("作业日志无效");
  if (item.operationId !== operationId || item.name !== `toonflow-trim-${operationId}` || (item.phase === "creating" ? !!item.containerId : !item.containerId) || (item.phase === "started" ? !item.childPid : !!item.childPid)) throw new Error("作业身份或阶段异常");
  const classification = item.phase === "creating" ? "创建结果未知" : item.phase === "created" ? "容器已创建" : "启动状态未知或仍在运行";
  console.log(JSON.stringify({ classification, phase: item.phase, hasContainerId: !!item.containerId, safeToRelease: false, reason: "须先证明专用 daemon、客户端和容器运行时屏障；诊断不解除任何状态" }));
} finally { await fence.close(); }
