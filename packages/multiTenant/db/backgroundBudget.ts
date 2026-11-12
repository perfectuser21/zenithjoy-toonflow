import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AdminDatabase } from "./schema";

// 单行既是跨实例互斥锁，也是持久字节账本。操作完成或租约失效后，字节仍保留，直到确认清理或结算。
const budgetKey = { jobId: "00000000-0000-4000-8000-000000000001", ownerId: "system", workspaceHash: "0".repeat(64) };
const perJobBytes = 512 * 1024 * 1024;
const perUserBytes = 1024 * 1024 * 1024;
const workspaceSchema = z.string().regex(/^[a-f0-9]{64}$/);
const reservationSchema = z.strictObject({ operationId: z.uuid(), ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), workspaceHash: workspaceSchema.optional(), kind: z.enum(["prepare", "frame"]).optional(), state: z.enum(["reserved", "committed"]).optional(), bytes: z.number().int().min(0).max(perJobBytes) });
const payloadSchema = z.strictObject({ kind: z.literal("backgroundBudget"), reservations: z.array(reservationSchema).max(10000), holder: z.strictObject({ operationId: z.uuid(), ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), workspaceHash: workspaceSchema.optional(), kind: z.enum(["plan", "prepare", "frame"]), leaseOwner: z.uuid() }).optional(), audit: z.array(z.strictObject({ attemptId: z.uuid(), operationId: z.uuid(), ownerId: z.string(), workspaceHash: workspaceSchema, actor: z.string().min(1).max(64), reason: z.string().min(16).max(500), result: z.literal("released") })).max(5000).optional() });
type Payload = z.infer<typeof payloadSchema>;
export type BackgroundBudgetLease = { operationId: string; ownerId: string; workspaceHash: string; leaseOwner: string; generation: number; revision: number; kind: "plan" | "prepare" | "frame" };

/** 仅由显式管理员迁移调用，普通请求不得创建账本。 */
export async function initializeBackgroundBudget(db: AdminDatabase) {
  await db.createBackgroundJob({ ...budgetKey, payload: { kind: "backgroundBudget", reservations: [] } });
  const row = await db.getBackgroundJob(budgetKey);
  if (!row || !payloadSchema.safeParse(row.payload).success) throw new Error("后台资源预算未初始化");
}

/** 成功时返回唯一持有者；undefined 表示并发占用或额度不足。 */
export async function acquireBackgroundBudget(db: AdminDatabase, input: { operationId: string; ownerId: string; workspaceHash: string; kind: "plan" | "prepare" | "frame" }): Promise<BackgroundBudgetLease | undefined> {
  const value = z.strictObject({ operationId: z.uuid(), ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), workspaceHash: workspaceSchema, kind: z.enum(["plan", "prepare", "frame"]) }).parse(input);
  const leaseOwner = randomUUID();
  if (!await db.acquireBackgroundJobLease({ ...budgetKey, leaseOwner, ttlMs: 120000 })) return undefined;
  let keep = false;
  try {
    const row = await db.getBackgroundJob(budgetKey);
    if (!row || row.leaseOwner !== leaseOwner) throw new Error("后台资源预算不可用");
    const payload = payloadSchema.parse(row.payload);
    if (value.kind !== "plan") {
      if (payload.reservations.some(item => item.operationId === value.operationId)) return undefined;
      const used = payload.reservations.filter(item => item.ownerId === value.ownerId).reduce((sum, item) => sum + item.bytes, 0);
      const bytes = value.kind === "frame" ? 10 * 1024 * 1024 : perJobBytes;
      if (used + bytes > perUserBytes || payload.reservations.length >= 10000) return undefined;
      payload.reservations.push({ operationId: value.operationId, ownerId: value.ownerId, workspaceHash: value.workspaceHash, kind: value.kind, state: "reserved", bytes });
    }
    payload.holder = { ...value, leaseOwner };
    if (!await db.updateBackgroundJob({ ...budgetKey, leaseOwner, generation: row.leaseGeneration, expectedRevision: row.revision, payload })) throw new Error("后台资源预算已变化");
    keep = true;
    return { ...value, leaseOwner, generation: row.leaseGeneration, revision: row.revision + 1 };
  } finally {
    if (!keep) {
      const row = await db.getBackgroundJob(budgetKey).catch(() => undefined);
      if (row?.leaseOwner === leaseOwner) await db.releaseBackgroundJobLease({ ...budgetKey, leaseOwner, generation: row.leaseGeneration }).catch(() => {});
    }
  }
}
export async function renewBackgroundBudget(db: AdminDatabase, lease: BackgroundBudgetLease) {
  return db.renewBackgroundJobLease({ ...budgetKey, leaseOwner: lease.leaseOwner, generation: lease.generation, ttlMs: 120000 });
}
/** 仅返回当前账户和工作区的记录；旧版未绑定工作区的记录不会被列出或自动释放。 */
export async function listBackgroundReservations(db: AdminDatabase, lease: BackgroundBudgetLease) {
  if (lease.kind !== "plan" || !await renewBackgroundBudget(db, lease)) return undefined;
  const row = await db.getBackgroundJob(budgetKey);
  if (!row || row.leaseOwner !== lease.leaseOwner || row.leaseGeneration !== lease.generation || row.revision !== lease.revision) return undefined;
  const payload = payloadSchema.parse(row.payload);
  const holder = payload.holder;
  if (!holder || holder.leaseOwner !== lease.leaseOwner || holder.ownerId !== lease.ownerId || holder.workspaceHash !== lease.workspaceHash || holder.operationId !== lease.operationId || holder.kind !== lease.kind) return undefined;
  return payload.reservations.filter(item => item.ownerId === lease.ownerId && item.workspaceHash === lease.workspaceHash)
    .map(({ operationId, kind, state, bytes }) => ({ operationId, kind, state, bytes }));
}
export async function hasBackgroundReservation(db: AdminDatabase, lease: BackgroundBudgetLease, operationId: string) {
  z.uuid().parse(operationId);
  const reservations = await listBackgroundReservations(db, lease);
  return reservations === undefined ? undefined : reservations.some(item => item.operationId === operationId);
}
/** 恢复过期预留：调用者需先取得同一账号的 plan 锁并确认本人文件已清理或实际占用。 */
export async function reconcileBackgroundReservation(db: AdminDatabase, lease: BackgroundBudgetLease, operationId: string, actualBytes: number) {
  z.uuid().parse(operationId);
  z.number().int().min(0).max(perJobBytes).parse(actualBytes);
  if (lease.kind !== "plan") throw new Error("资源预留恢复需要计划锁");
  const row = await db.getBackgroundJob(budgetKey);
  if (!row || row.leaseOwner !== lease.leaseOwner || row.leaseGeneration !== lease.generation || row.revision !== lease.revision) return false;
  const payload = payloadSchema.parse(row.payload);
  if (!payload.holder || payload.holder.leaseOwner !== lease.leaseOwner || payload.holder.ownerId !== lease.ownerId || payload.holder.workspaceHash !== lease.workspaceHash || payload.holder.operationId !== lease.operationId || payload.holder.kind !== lease.kind) return false;
  const item = payload.reservations.find(entry => entry.operationId === operationId && entry.ownerId === lease.ownerId && entry.workspaceHash === lease.workspaceHash);
  if (!item || !item.kind || item.state !== "committed" || actualBytes > item.bytes) return false;
  if (actualBytes === 0) payload.reservations = payload.reservations.filter(entry => entry !== item);
  else item.bytes = actualBytes;
  if (!await db.updateBackgroundJob({ ...budgetKey, leaseOwner: lease.leaseOwner, generation: lease.generation, expectedRevision: lease.revision, payload })) return false;
  lease.revision++;
  return true;
}
// 仅独立运维 CLI 引入，不从包入口导出；调用方必须先核实执行隔离和相关目录不存在。
export async function adminReleaseReservedPrepare(db: AdminDatabase, lease: BackgroundBudgetLease, operationId: string, audit: { attemptId: string; actor: string; reason: string }) {
  z.uuid().parse(operationId);
  if (lease.kind !== "plan") return false;
  const row = await db.getBackgroundJob(budgetKey);
  if (!row || row.leaseOwner !== lease.leaseOwner || row.leaseGeneration !== lease.generation || row.revision !== lease.revision) return false;
  const payload = payloadSchema.parse(row.payload);
  const holder = payload.holder;
  if (!holder || holder.leaseOwner !== lease.leaseOwner || holder.ownerId !== lease.ownerId || holder.workspaceHash !== lease.workspaceHash || holder.operationId !== lease.operationId || holder.kind !== "plan") return false;
  const item = payload.reservations.find(entry => entry.operationId === operationId && entry.ownerId === lease.ownerId && entry.workspaceHash === lease.workspaceHash);
  if (!item || item.kind !== "prepare" || item.state !== "reserved") return false;
  if ((payload.audit?.length ?? 0) >= 5000) throw new Error("审计空间不足");
  payload.audit ??= [];
  payload.audit.push({ ...audit, operationId, ownerId: lease.ownerId, workspaceHash: lease.workspaceHash, result: "released" });
  payload.reservations = payload.reservations.filter(entry => entry !== item);
  if (!await db.updateBackgroundJob({ ...budgetKey, leaseOwner: lease.leaseOwner, generation: lease.generation, expectedRevision: lease.revision, payload })) return false;
  lease.revision++;
  return true;
}
/** actualBytes 不传时保留全部预留；传 0 仅适用于确认已清理的情况。 */
export async function finishBackgroundBudget(db: AdminDatabase, lease: BackgroundBudgetLease, actualBytes?: number) {
  if (actualBytes !== undefined) z.number().int().min(0).max(perJobBytes).parse(actualBytes);
  const row = await db.getBackgroundJob(budgetKey);
  if (!row || row.leaseOwner !== lease.leaseOwner || row.leaseGeneration !== lease.generation || row.revision !== lease.revision) return false;
  const stored = payloadSchema.parse(row.payload);
  if (!stored.holder || stored.holder.leaseOwner !== lease.leaseOwner || stored.holder.ownerId !== lease.ownerId || stored.holder.workspaceHash !== lease.workspaceHash || stored.holder.operationId !== lease.operationId || stored.holder.kind !== lease.kind) return false;
  if (lease.kind !== "plan" && actualBytes !== undefined) {
    const payload: Payload = stored;
    const item = payload.reservations.find(item => item.operationId === lease.operationId && item.ownerId === lease.ownerId && item.workspaceHash === lease.workspaceHash);
    if (!item || item.kind !== lease.kind || item.state !== "reserved" || actualBytes > item.bytes) throw new Error("后台资源预留不存在或超出预留额度");
    if (actualBytes === 0) payload.reservations = payload.reservations.filter(entry => entry !== item);
    else { item.bytes = actualBytes; item.state = "committed"; }
    if (!await db.updateBackgroundJob({ ...budgetKey, leaseOwner: lease.leaseOwner, generation: lease.generation, expectedRevision: lease.revision, payload })) return false;
    lease.revision++;
  }
  return db.releaseBackgroundJobLease({ ...budgetKey, leaseOwner: lease.leaseOwner, generation: lease.generation });
}
