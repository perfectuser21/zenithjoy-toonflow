import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "@toonflow/file";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { openDatabase } from "./index";
import { acquireBackgroundBudget, adminReleaseReservedPrepare, finishBackgroundBudget } from "./backgroundBudget";

// 运维必须在原执行节点或明确隔离的同一卷上运行；此程序只对账，不删除任何文件。
const [directory, ownerId, workspace, operationId, tempRoot, actor, reason, stopped, isolated, ...extra] = process.argv.slice(2);
if (!directory || !ownerId || !workspace || !operationId || !tempRoot || !actor || !reason || extra.length || stopped !== "--execution-stopped" || isolated !== "--volume-isolated") throw new Error("参数无效：需要数据目录、账号、工作区、操作编号、临时根目录、操作员、隔离证据及两个确认参数");
if (![directory, workspace, tempRoot].every(isAbsolute)) throw new Error("目录必须使用规范绝对路径");
z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).parse(ownerId);
z.uuid().parse(operationId);
z.string().regex(/^[a-zA-Z0-9_.@-]{1,64}$/).parse(actor);
z.string().trim().min(16).max(500).parse(reason);
const dataDir = resolve(directory), cwd = resolve(workspace), tmp = resolve(tempRoot);
for (const path of [dataDir, cwd, tmp]) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error("目录必须是规范的普通目录");
}
const ownerRoot = join(dataDir, "multiTenant", "workspaces", ownerId);
const ownerInfo = await lstat(ownerRoot);
if (!ownerInfo.isDirectory() || ownerInfo.isSymbolicLink() || await realpath(ownerRoot) !== ownerRoot || tmp !== await realpath(tmpdir())) throw new Error("工作区或临时根目录不匹配");
const rel = relative(ownerRoot, cwd);
if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("工作区不属于指定账号");
// Linux bind mount 可能与父目录有相同 st_dev，额外检查当前命名空间的挂载点。
const mounts = process.platform === "linux" ? new Set((await readFile("/proc/self/mountinfo", "utf8")).split("\n").filter(Boolean).map(line => {
  const field = line.split(" ")[4];
  if (!field) throw new Error("无法核实挂载信息");
  return field.replace(/\\([0-7]{3})/g, (_, digits: string) => String.fromCharCode(parseInt(digits, 8)));
})) : new Set<string>();
async function verifyChildren(root: string, parts: string[], allowMissing: boolean) {
  let current = root;
  const device = (await lstat(root)).dev;
  for (const part of parts.filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (info.isSymbolicLink() || info.dev !== device || mounts.has(current)) throw new Error("目标路径包含符号链接或挂载点");
  }
  return true;
}
await verifyChildren(ownerRoot, rel.split(sep), false);
const hash = createHash("sha256").update(cwd).digest("hex"), attemptId = randomUUID();
const database = await openDatabase(dataDir, false);
if (!database) throw new Error("多租户数据库不存在");
const auditKey = { ownerId: "system", workspaceHash: "0".repeat(64) };
const audit = async (phase: "attempt" | "result", outcome: string) => {
  if (!await database.createBackgroundJob({ ...auditKey, jobId: randomUUID(), payload: { kind: "backgroundOrphanAudit", phase, attemptId, ownerId, workspaceHash: hash, operationId, actor, reason, outcome } })) throw new Error("无法记录操作审计");
};
async function absent(root: string, parts: string[]) {
  return !await verifyChildren(root, parts, true);
}
let lease: Awaited<ReturnType<typeof acquireBackgroundBudget>>;
let outcome = "rejected";
try {
  if (!await database.getAdmin()) throw new Error("管理员尚未初始化");
  await audit("attempt", "started");
  lease = await acquireBackgroundBudget(database, { operationId: randomUUID(), ownerId, workspaceHash: hash, kind: "plan" });
  if (!lease) throw new Error("预算锁不可用");
  const suffix = operationId.replaceAll("-", "");
  if (!await absent(cwd, ["assets", "generated", `background${suffix}`]) || !await absent(tmp, [`toonflowBackground${suffix}`])) throw new Error("相关目录仍存在");
  if (!await adminReleaseReservedPrepare(database, lease, operationId, { attemptId, actor, reason })) throw new Error("预留不存在或不允许处置");
  outcome = "released";
  console.log("预留已对账；未删除任何文件");
} catch {
  throw new Error("孤儿预留处置失败，请检查隔离证据、目录和预留状态");
} finally {
  if (lease) await finishBackgroundBudget(database, lease).catch(() => {});
  await audit("result", outcome).catch(() => {});
  await database.close().catch(() => {});
}
