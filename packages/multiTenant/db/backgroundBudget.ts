import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AdminDatabase } from "./schema";

// 单行既是跨实例互斥锁，也是持久字节账本。操作完成或租约失效后，字节仍保留，直到确认清理或结算。
const budgetKey = { jobId: "00000000-0000-4000-8000-000000000001", ownerId: "system", workspaceHash: "0".repeat(64) };
const perJobBytes = 512 * 1024 * 1024;
const maxCrossGroupBytes = 1024 * 128 * 1024 * 1024;
const perUserBytes = 1024 * 1024 * 1024;
const perUserRecords = 100;
const archiveAt = 1000;
const archiveAtBytes = 2 * 1024 * 1024;
const archiveBatch = 100;
const workspaceSchema = z.string().regex(/^[a-f0-9]{64}$/);
const trimRequestSchema = z.strictObject({ source: z.string().min(1).max(4096), start: z.number().finite().nonnegative(), end: z.number().finite().positive().max(120) }).refine(value => value.end > value.start);
const cancelIntentSchema = z.strictObject({ attemptId: z.uuid(), actor: z.string().min(1).max(64), reason: z.string().trim().min(16).max(500), kind: z.enum(["user", "admin"]) });
const reservationSchema = z.strictObject({ operationId: z.uuid(), ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), workspaceHash: workspaceSchema.optional(), kind: z.enum(["prepare", "frame", "trim"]).optional(), archived: z.literal(true).optional(), groupIds: z.string().max(87384).optional(), groupSizes: z.string().max(21848).optional(), crossEntries: z.string().max(160000).optional(), state: z.enum(["reserved", "committed", "interrupted"]).optional(), trimPhase: z.enum(["preflight", "dispatched"]).optional(), cancelIntent: cancelIntentSchema.optional(), cancelCompletion: z.strictObject({ eventId: z.uuid(), actor: z.string().min(1).max(64), at: z.number().int().nonnegative(), outcome: z.enum(["sealed", "resultPreserved"]) }).optional(), bytes: z.number().int().min(0).max(maxCrossGroupBytes), digest: z.string().regex(/^[a-f0-9]{64}$/).optional(), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), requestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), parametersHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), trimRequest: trimRequestSchema.optional(), trimIntent: z.strictObject({ bytes: z.number().int().positive().max(128 * 1024 * 1024), digest: z.string().regex(/^[a-f0-9]{64}$/), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).optional() }).superRefine((item, context) => {
  if (!item.crossEntries && item.bytes > perJobBytes) context.addIssue({ code: "custom", message: "单任务资源预留异常" });
  if (item.trimPhase && (item.kind !== "trim" || item.trimPhase === "preflight" && (item.state !== "reserved" || item.trimIntent))) context.addIssue({ code: "custom", message: "裁剪发送状态异常" });
  if (item.cancelCompletion && (!item.cancelIntent || (item.cancelCompletion.outcome === "sealed" ? item.state !== "interrupted" || item.bytes !== 0 : item.state !== "committed" || !item.trimIntent || item.bytes !== item.trimIntent.bytes || item.digest !== item.trimIntent.digest || item.sourceDigest !== item.trimIntent.sourceDigest))) context.addIssue({ code: "custom", message: "裁剪取消回执状态异常" });
  if (item.cancelIntent && (item.kind !== "trim" || !["reserved", "interrupted"].includes(item.state ?? "") && !(item.state === "committed" && item.cancelCompletion?.outcome === "resultPreserved") || item.trimPhase === "preflight")) context.addIssue({ code: "custom", message: "裁剪取消状态异常" });
});
// 普通预留仍限制为单任务 512 MiB；跨项目分组是多账号记录的总和。
const payloadSchema = z.strictObject({ kind: z.literal("backgroundBudget"), reservations: z.array(reservationSchema).max(10000), holder: z.strictObject({ operationId: z.uuid(), ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), workspaceHash: workspaceSchema.optional(), kind: z.enum(["plan", "prepare", "frame", "trim"]), leaseOwner: z.uuid() }).optional(), audit: z.array(z.strictObject({ attemptId: z.uuid(), operationId: z.uuid(), ownerId: z.string(), workspaceHash: workspaceSchema, actor: z.string().min(1).max(64), reason: z.string().min(16).max(500), result: z.literal("released") })).max(5000).optional() });
type Payload = z.infer<typeof payloadSchema>;
type Reservation = z.infer<typeof reservationSchema>;
const maxTrimGroupIds = 4096;
function decodeTrimGroup(item: Reservation): string[] {
  if (item.kind !== "trim" || item.state !== "committed" || !item.archived || !item.groupIds || item.crossEntries || !item.workspaceHash || item.bytes < 1) throw new Error("裁剪分组状态异常");
  const raw = Buffer.from(item.groupIds, "base64");
  if (!raw.length || raw.length % 16 || raw.length / 16 > maxTrimGroupIds || raw.toString("base64") !== item.groupIds) throw new Error("裁剪分组索引异常");
  const ids: string[] = [];
  for (let offset = 0; offset < raw.length; offset += 16) {
    const hex = raw.subarray(offset, offset + 16).toString("hex");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    if (!z.uuid().safeParse(id).success) throw new Error("裁剪分组任务标识异常");
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) throw new Error("裁剪分组任务重复");
  const sizes = Buffer.from(item.groupSizes ?? "", "base64");
  if (sizes.length !== ids.length * 4 || sizes.toString("base64") !== item.groupSizes) throw new Error("裁剪分组占用索引异常");
  let total = 0;
  for (let index = 0; index < ids.length; index++) {
    const size = sizes.readUInt32BE(index * 4);
    if (!size || size > 128 * 1024 * 1024) throw new Error("裁剪分组单项占用异常");
    total += size;
  }
  if (total !== item.bytes) throw new Error("裁剪分组占用不一致");
  return ids;
}
type CrossEntry = { ownerId: string; workspaceHash: string; operationId: string; bytes: number };
const maxCrossEntries = 1024;
function decodeCrossGroup(item: Reservation): CrossEntry[] {
  if (item.kind !== "trim" || item.state !== "committed" || !item.archived || !item.crossEntries || item.groupIds || item.groupSizes
    || item.ownerId !== budgetKey.ownerId || item.workspaceHash !== budgetKey.workspaceHash || item.bytes < 1) throw new Error("跨项目裁剪分组状态异常");
  const raw = Buffer.from(item.crossEntries, "base64");
  if (raw.toString("base64") !== item.crossEntries) throw new Error("跨项目裁剪索引异常");
  const entries: CrossEntry[] = [], ids = new Set<string>();
  let offset = 0, total = 0;
  while (offset < raw.length) {
    const length = raw.readUInt8(offset++);
    if (!length || length > 64 || offset + length + 52 > raw.length || entries.length >= maxCrossEntries) throw new Error("跨项目裁剪索引异常");
    const ownerBytes = raw.subarray(offset, offset + length);
    const ownerId = ownerBytes.toString("ascii"); offset += length;
    if (!Buffer.from(ownerId, "ascii").equals(ownerBytes) || !/^[a-zA-Z0-9_-]{1,64}$/.test(ownerId)) throw new Error("跨项目裁剪账号异常");
    const workspaceHash = raw.subarray(offset, offset + 32).toString("hex"); offset += 32;
    const hex = raw.subarray(offset, offset + 16).toString("hex"); offset += 16;
    const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const bytes = raw.readUInt32BE(offset); offset += 4;
    if (!z.uuid().safeParse(operationId).success || ids.has(operationId) || !bytes || bytes > 128 * 1024 * 1024) throw new Error("跨项目裁剪记录异常");
    ids.add(operationId); total += bytes; entries.push({ ownerId, workspaceHash, operationId, bytes });
  }
  if (!entries.length || total !== item.bytes) throw new Error("跨项目裁剪占用不一致");
  return entries;
}
function assertGroupIntegrity(payload: Payload) {
  for (const item of payload.reservations) {
    if (item.crossEntries !== undefined) decodeCrossGroup(item);
    else {
      if (item.bytes > perJobBytes) throw new Error("单任务资源预留异常");
      if (item.groupIds !== undefined || item.groupSizes !== undefined) decodeTrimGroup(item);
    }
  }
}
function encodeCrossEntry(item: Reservation) {
  if (!item.workspaceHash || item.operationId !== item.operationId.toLowerCase() || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.ownerId)
    || item.bytes < 1 || item.bytes > 128 * 1024 * 1024) throw new Error("跨项目裁剪记录异常");
  const owner = Buffer.from(item.ownerId, "ascii"), size = Buffer.alloc(4); size.writeUInt32BE(item.bytes);
  return Buffer.concat([Buffer.from([owner.length]), owner, Buffer.from(item.workspaceHash, "hex"), Buffer.from(item.operationId.replaceAll("-", ""), "hex"), size]);
}
async function archivedTrim(db: AdminDatabase, ownerId: string, workspaceHash: string, operationId: string): Promise<Reservation> {
  const archived = await db.getBackgroundJob({ ...budgetKey, jobId: operationId });
  if (archived?.payload?.kind !== "trimCommittedArchive") throw new Error("裁剪归档不可用");
  const full = reservationSchema.parse(archived.payload.record);
  if (full.archived || full.groupIds || full.groupSizes || full.crossEntries || full.kind !== "trim" || full.state !== "committed" || full.operationId !== operationId
    || full.ownerId !== ownerId || full.workspaceHash !== workspaceHash || full.bytes < 1 || full.bytes > 128 * 1024 * 1024
    || !full.digest || !full.sourceDigest || !full.requestHash || !full.parametersHash) throw new Error("裁剪归档与预算不一致");
  return full;
}
async function archivedInterruptedTrim(db: AdminDatabase, ownerId: string, workspaceHash: string, operationId: string): Promise<Reservation | undefined> {
  const archive = await db.getBackgroundJob({ ...budgetKey, jobId: operationId });
  if (archive?.payload?.kind !== "trimInterruptedArchive") return undefined;
  const restored = reservationSchema.parse(archive.payload.record);
  if (restored.kind !== "trim" || restored.state !== "interrupted" || restored.bytes !== 0 || restored.operationId !== operationId || restored.ownerId !== ownerId || restored.workspaceHash !== workspaceHash) throw new Error("中断裁剪归档不一致");
  return restored;
}
async function expandCommittedTrim(db: AdminDatabase, item: Reservation): Promise<Reservation> {
  if (!item.archived) return item;
  if (item.kind !== "trim" || item.state !== "committed" || item.groupIds || item.crossEntries || !item.workspaceHash) throw new Error("裁剪归档状态异常");
  const full = await archivedTrim(db, item.ownerId, item.workspaceHash, item.operationId);
  if (full.bytes !== item.bytes) throw new Error("裁剪归档与预算不一致");
  return full;
}
export type BackgroundBudgetLease = { operationId: string; ownerId: string; workspaceHash: string; leaseOwner: string; generation: number; revision: number; kind: "plan" | "prepare" | "frame" | "trim" };

/** 仅由显式管理员迁移调用，普通请求不得创建账本。 */
export async function initializeBackgroundBudget(db: AdminDatabase) {
  await db.createBackgroundJob({ ...budgetKey, payload: { kind: "backgroundBudget", reservations: [] } });
  const row = await db.getBackgroundJob(budgetKey);
  if (!row || !payloadSchema.safeParse(row.payload).success) throw new Error("后台资源预算未初始化");
}

/** 成功时返回唯一持有者；undefined 表示并发占用或额度不足。 */
async function acquireBudget(db: AdminDatabase, input: { operationId: string; ownerId: string; workspaceHash: string; kind: "plan" | "prepare" | "frame" | "trim"; requestHash?: string; parametersHash?: string; trimRequest?: z.infer<typeof trimRequestSchema> }): Promise<BackgroundBudgetLease | undefined> {
  const value = z.strictObject({ operationId: z.uuid(), ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), workspaceHash: workspaceSchema, kind: z.enum(["plan", "prepare", "frame", "trim"]), requestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), parametersHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), trimRequest: trimRequestSchema.optional() }).parse(input);
  if (value.kind === "trim" && (!value.requestHash || !value.parametersHash)) throw new Error("裁剪请求摘要缺失");
  if (value.kind !== "trim" && value.trimRequest) throw new Error("后台资源请求类型无效");
  const leaseOwner = randomUUID();
  if (!await db.acquireBackgroundJobLease({ ...budgetKey, leaseOwner, ttlMs: 120000 })) return undefined;
  let keep = false;
  try {
    const row = await db.getBackgroundJob(budgetKey);
    if (!row || row.leaseOwner !== leaseOwner) throw new Error("后台资源预算不可用");
    const payload = payloadSchema.parse(row.payload);
    assertGroupIntegrity(payload);
    // 获得新租约后，仅带明确发送前标记的旧预留可安全回收；旧版无标记及已发送均保持未知。
    payload.reservations = payload.reservations.filter(item => !(item.kind === "trim" && item.state === "reserved" && item.trimPhase === "preflight"));
    // 裁剪状态未知时，旧容器可能仍在运行；超时不能当作退出证明。
    if (payload.reservations.some(item => item.kind === "trim" && item.state === "reserved")) return undefined;
    if (value.kind !== "plan") {
      if (payload.reservations.some(item => item.operationId === value.operationId)) return undefined;
      // 已释放的裁剪记录可归档到独立持久行；先验证归档、再修改原账本，崩溃时宁可重复保留。
      // 归档保留全部原始字段及任务 ID，用于避免重放，不能以删除记录代替归档。
      const archivedId = { jobId: value.operationId, ownerId: budgetKey.ownerId, workspaceHash: budgetKey.workspaceHash };
      const archived = await db.getBackgroundJob(archivedId);
      if (["trimInterruptedArchive", "trimCommittedArchive"].includes(String(archived?.payload?.kind))) return undefined;
      const used = payload.reservations.reduce((sum, item) => sum + (item.crossEntries
        ? decodeCrossGroup(item).filter(entry => entry.ownerId === value.ownerId).reduce((part, entry) => part + entry.bytes, 0)
        : item.ownerId === value.ownerId ? item.bytes : 0), 0);
      const recordCount = payload.reservations.filter(item => item.ownerId === value.ownerId && item.kind === "trim" && item.state === "interrupted" && item.bytes > 0).length;
      const bytes = value.kind === "frame" ? 10 * 1024 * 1024 : perJobBytes;
      if (used + bytes > perUserBytes || value.kind === "trim" && recordCount >= perUserRecords) return undefined;
      if (payload.reservations.length >= archiveAt || Buffer.byteLength(JSON.stringify(payload), "utf8") >= archiveAtBytes) {
        let moved = 0;
        const retained: typeof payload.reservations = [];
        const groups = payload.reservations.filter(item => item.groupIds !== undefined);
        const crossGroups = payload.reservations.filter(item => item.crossEntries !== undefined);
        for (const group of groups) decodeTrimGroup(group);
        const crossIds = new Set<string>();
        for (const group of crossGroups) for (const entry of decodeCrossGroup(group)) {
          if (crossIds.has(entry.operationId)) throw new Error("跨项目裁剪任务重复");
          crossIds.add(entry.operationId);
        }
        const addToCrossGroup = async (item: Reservation) => {
          if (crossIds.has(item.operationId)) throw new Error("跨项目裁剪任务重复");
          const encoded = encodeCrossEntry(item);
          let group = crossGroups.find(candidate => candidate.bytes + item.bytes <= maxCrossGroupBytes && decodeCrossGroup(candidate).length < maxCrossEntries);
          if (!group) {
            const groupId = randomUUID();
            if (payload.reservations.some(candidate => candidate.operationId === groupId) || await db.getBackgroundJob({ ...budgetKey, jobId: groupId })) return false;
            group = { operationId: groupId, ownerId: budgetKey.ownerId, workspaceHash: budgetKey.workspaceHash, kind: "trim", state: "committed", archived: true, bytes: item.bytes, crossEntries: encoded.toString("base64") };
            crossGroups.push(group); retained.push(group);
          } else {
            group.crossEntries = Buffer.concat([Buffer.from(group.crossEntries!, "base64"), encoded]).toString("base64");
            group.bytes += item.bytes;
          }
          crossIds.add(item.operationId);
          return true;
        };
        const addToGroup = async (item: Reservation, full: Reservation) => {
          if (!item.workspaceHash || item.operationId !== item.operationId.toLowerCase()) return false;
          if (full.bytes < 1 || full.bytes > 128 * 1024 * 1024) throw new Error("裁剪归档占用异常");
          let group = groups.find(candidate => candidate.ownerId === item.ownerId && candidate.workspaceHash === item.workspaceHash
            && candidate.bytes + full.bytes <= perJobBytes && decodeTrimGroup(candidate).length < maxTrimGroupIds);
          const encodedSize = Buffer.alloc(4); encodedSize.writeUInt32BE(full.bytes);
          if (!group) {
            const groupId = randomUUID();
            const collision = payload.reservations.some(candidate => candidate.operationId === groupId)
              || await db.getBackgroundJob({ ...budgetKey, jobId: groupId });
            if (collision) return false;
            group = { operationId: groupId, ownerId: item.ownerId, workspaceHash: item.workspaceHash, kind: "trim", state: "committed", archived: true, bytes: full.bytes,
              groupIds: Buffer.from(item.operationId.replaceAll("-", ""), "hex").toString("base64"), groupSizes: encodedSize.toString("base64") };
            groups.push(group); retained.push(group);
          } else {
            const ids = decodeTrimGroup(group);
            if (ids.includes(item.operationId)) throw new Error("裁剪分组任务重复");
            group.groupIds = Buffer.concat([Buffer.from(group.groupIds!, "base64"), Buffer.from(item.operationId.replaceAll("-", ""), "hex")]).toString("base64");
            group.groupSizes = Buffer.concat([Buffer.from(group.groupSizes!, "base64"), encodedSize]).toString("base64");
            group.bytes += full.bytes;
          }
          return true;
        };
        // 满账本时先处理能实际减少条数的分组，避免前面孤立记录让后续可合并记录永远得不到机会。
        let candidates = payload.reservations;
        const counts = new Map<string, number>();
        const bucket = (item: Reservation) => JSON.stringify([item.ownerId, item.workspaceHash]);
        if (payload.reservations.length >= 10000) {
          const groupsByBucket = new Map<string, Reservation[]>();
          for (const group of groups) {
            const key = bucket(group), batch = groupsByBucket.get(key) ?? [];
            batch.push(group); groupsByBucket.set(key, batch);
          }
          for (const item of payload.reservations) if (item.kind === "trim" && item.state === "committed" && !item.groupIds && !item.crossEntries && item.workspaceHash
            && item.operationId === item.operationId.toLowerCase() && item.bytes > 0 && item.bytes <= 128 * 1024 * 1024
            && (item.archived || item.digest && item.sourceDigest && item.requestHash && item.parametersHash)) {
            counts.set(bucket(item), (counts.get(bucket(item)) ?? 0) + 1);
          }
          const priority = (item: Reservation) => {
            if (item.kind === "trim" && item.state === "interrupted" && item.bytes === 0 && item.trimIntent) return true;
            if (item.kind !== "trim" || item.state !== "committed" || item.groupIds || item.crossEntries || !item.workspaceHash) return false;
            if ((counts.get(bucket(item)) ?? 0) >= 2) return true;
            return (groupsByBucket.get(bucket(item)) ?? []).some(group =>
              group.bytes + item.bytes <= perJobBytes && decodeTrimGroup(group).length < maxTrimGroupIds);
          };
          const first: Reservation[] = [], rest: Reservation[] = [];
          const byBucket = new Map<string, Reservation[]>();
          for (const item of payload.reservations) {
            if (!priority(item)) { rest.push(item); continue; }
            if (item.state === "interrupted" || (counts.get(bucket(item)) ?? 0) < 2) { first.push(item); continue; }
            const key = bucket(item), batch = byBucket.get(key) ?? [];
            batch.push(item); byBucket.set(key, batch);
          }
          candidates = [...first, ...[...byBucket.values()].flat(), ...rest];
        }
        for (const item of candidates) {
          if (payload.reservations.length >= 10000 && item.groupIds && item.workspaceHash) {
            const ids = decodeTrimGroup(item);
            if (ids.length <= archiveBatch - moved) {
              const sizes = Buffer.from(item.groupSizes!, "base64");
              const originals = await Promise.all(ids.map(id => archivedTrim(db, item.ownerId, item.workspaceHash!, id)));
              if (originals.some((entry, index) => entry.bytes !== sizes.readUInt32BE(index * 4))) throw new Error("裁剪分组单项占用不一致");
              for (const entry of originals) if (!await addToCrossGroup(entry)) throw new Error("跨项目裁剪分组不可用");
              groups.splice(groups.indexOf(item), 1); // 原分组不再保留，后续不能把新记录追加到已移除对象。
              moved += ids.length;
              continue;
            }
          }
          const cross = moved < archiveBatch && !item.groupIds && !item.crossEntries && payload.reservations.length >= 10000 && (counts.get(bucket(item)) ?? 0) < 2
            && !groups.some(group => group.ownerId === item.ownerId && group.workspaceHash === item.workspaceHash
              && group.bytes + item.bytes <= perJobBytes && decodeTrimGroup(group).length < maxTrimGroupIds);
          if (moved < archiveBatch && item.kind === "trim" && item.state === "committed" && item.archived && !item.groupIds && !item.crossEntries
            && item.workspaceHash && item.operationId === item.operationId.toLowerCase()) {
            const full = await expandCommittedTrim(db, item);
            if (await (cross ? addToCrossGroup(full) : addToGroup(item, full))) { moved++; continue; }
          }
          if (moved < archiveBatch && item.kind === "trim" && item.state === "interrupted" && item.bytes === 0 && (item.trimIntent || item.cancelIntent)) {
            const archiveKey = { jobId: item.operationId, ownerId: budgetKey.ownerId, workspaceHash: budgetKey.workspaceHash };
            const archivePayload = { kind: "trimInterruptedArchive", record: item };
            await db.createBackgroundJob({ ...archiveKey, payload: archivePayload });
            const saved = await db.getBackgroundJob(archiveKey);
            if (saved && isDeepStrictEqual(saved.payload, archivePayload)) { moved++; continue; }
          }
          if (moved < archiveBatch && item.kind === "trim" && item.state === "committed" && !item.archived && !item.crossEntries
            && item.workspaceHash && item.digest && item.sourceDigest && item.requestHash && item.parametersHash) {
            const archiveKey = { jobId: item.operationId, ownerId: budgetKey.ownerId, workspaceHash: budgetKey.workspaceHash };
            const archivePayload = { kind: "trimCommittedArchive", record: item };
            await db.createBackgroundJob({ ...archiveKey, payload: archivePayload });
            const saved = await db.getBackgroundJob(archiveKey);
            if (saved && isDeepStrictEqual(saved.payload, archivePayload)) {
              if (!await (cross ? addToCrossGroup(item) : addToGroup(item, item))) retained.push({ operationId: item.operationId, ownerId: item.ownerId, workspaceHash: item.workspaceHash, kind: "trim", state: "committed", bytes: item.bytes, archived: true });
              moved++;
              continue;
            }
          }
          retained.push(item);
        }
        payload.reservations = retained;
      }
      if (payload.reservations.length >= 10000) return undefined;
      payload.reservations.push({ operationId: value.operationId, ownerId: value.ownerId, workspaceHash: value.workspaceHash, kind: value.kind, state: "reserved", bytes, ...(value.kind === "trim" ? { trimPhase: "preflight" as const } : {}), ...(value.requestHash ? { requestHash: value.requestHash } : {}), ...(value.parametersHash ? { parametersHash: value.parametersHash } : {}), ...(value.trimRequest ? { trimRequest: value.trimRequest } : {}) });
    }
    payload.holder = { operationId: value.operationId, ownerId: value.ownerId, workspaceHash: value.workspaceHash, kind: value.kind, leaseOwner };
    if (!await db.updateBackgroundJob({ ...budgetKey, leaseOwner, generation: row.leaseGeneration, expectedRevision: row.revision, payload: payloadSchema.parse(payload) })) throw new Error("后台资源预算已变化");
    keep = true;
    return { ...value, leaseOwner, generation: row.leaseGeneration, revision: row.revision + 1 };
  } finally {
    if (!keep) {
      const row = await db.getBackgroundJob(budgetKey).catch(() => undefined);
      if (row?.leaseOwner === leaseOwner) await db.releaseBackgroundJobLease({ ...budgetKey, leaseOwner, generation: row.leaseGeneration }).catch(() => {});
    }
  }
}
export async function acquireBackgroundBudget(db: AdminDatabase, input: { operationId: string; ownerId: string; workspaceHash: string; kind: "plan" | "prepare" | "frame" | "trim"; requestHash?: string; parametersHash?: string; trimRequest?: z.infer<typeof trimRequestSchema> }) {
  return acquireBudget(db, input);
}
/** 恢复列表只包含当前账户及工作区，旧记录缺少请求详情时不会假造。 */
export async function listOwnTrimReservations(db: AdminDatabase, ownerId: string, workspaceHash: string) {
  z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).parse(ownerId); workspaceSchema.parse(workspaceHash);
  const row = await db.getBackgroundJob(budgetKey);
  if (!row) throw new Error("后台资源预算未初始化");
  const payload = payloadSchema.parse(row.payload);
  assertGroupIntegrity(payload);
  const items = payload.reservations.filter(item => item.kind === "trim" && (item.crossEntries || item.ownerId === ownerId && item.workspaceHash === workspaceHash) && (item.state !== "interrupted" || item.bytes > 0));
  const result: { operationId: string; state: Reservation["state"]; trimRequest: Reservation["trimRequest"] }[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.crossEntries) {
      const entries = decodeCrossGroup(item).filter(entry => entry.ownerId === ownerId && entry.workspaceHash === workspaceHash);
      for (let offset = 0; offset < entries.length; offset += 50) {
        const selected = entries.slice(offset, offset + 50);
        const batch = await Promise.all(selected.map(entry => archivedTrim(db, ownerId, workspaceHash, entry.operationId)));
        for (const [index, full] of batch.entries()) {
          if (full.bytes !== selected[index]!.bytes) throw new Error("跨项目裁剪单项占用不一致");
          if (seen.has(full.operationId)) throw new Error("裁剪分组任务重复");
          seen.add(full.operationId);
          result.push({ operationId: full.operationId, state: full.state, trimRequest: full.trimRequest });
        }
      }
    } else if (item.groupIds) {
      const ids = decodeTrimGroup(item);
      let bytes = 0;
      for (let offset = 0; offset < ids.length; offset += 50) {
        const batch = await Promise.all(ids.slice(offset, offset + 50).map(id => archivedTrim(db, ownerId, workspaceHash, id)));
        for (const [index, full] of batch.entries()) {
          if (Buffer.from(item.groupSizes!, "base64").readUInt32BE((offset + index) * 4) !== full.bytes) throw new Error("裁剪分组单项占用不一致");
          if (seen.has(full.operationId)) throw new Error("裁剪分组任务重复");
          seen.add(full.operationId); bytes += full.bytes;
          result.push({ operationId: full.operationId, state: full.state, trimRequest: full.trimRequest });
        }
      }
      if (bytes !== item.bytes) throw new Error("裁剪分组占用不一致");
    } else {
      const full = await expandCommittedTrim(db, item);
      if (seen.has(full.operationId)) throw new Error("裁剪分组任务重复");
      seen.add(full.operationId);
      result.push({ operationId: full.operationId, state: full.state, trimRequest: full.trimRequest });
    }
  }
  return result;
}
export async function renewBackgroundBudget(db: AdminDatabase, lease: BackgroundBudgetLease) {
  return db.renewBackgroundJobLease({ ...budgetKey, leaseOwner: lease.leaseOwner, generation: lease.generation, ttlMs: 120000 });
}
/** 发送请求之前持久化未知边界；只有当前有效租约可越过此边界。 */
export async function markTrimDispatched(db: AdminDatabase, lease: BackgroundBudgetLease) {
  if (lease.kind !== "trim" || !await renewBackgroundBudget(db, lease)) return false;
  const row = await db.getBackgroundJob(budgetKey);
  if (!row || row.leaseOwner !== lease.leaseOwner || row.leaseGeneration !== lease.generation || row.revision !== lease.revision) return false;
  const payload = payloadSchema.parse(row.payload), holder = payload.holder;
  if (!holder || holder.leaseOwner !== lease.leaseOwner || holder.ownerId !== lease.ownerId || holder.workspaceHash !== lease.workspaceHash || holder.operationId !== lease.operationId || holder.kind !== "trim") return false;
  const item = payload.reservations.find(entry => entry.kind === "trim" && entry.state === "reserved" && entry.ownerId === lease.ownerId && entry.workspaceHash === lease.workspaceHash && entry.operationId === lease.operationId);
  if (!item || item.trimPhase !== "preflight") return false;
  item.trimPhase = "dispatched";
  if (!await db.updateBackgroundJob({ ...budgetKey, leaseOwner: lease.leaseOwner, generation: lease.generation, expectedRevision: lease.revision, payload: payloadSchema.parse(payload) })) return false;
  lease.revision++;
  return true;
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
/** 只读查询当前账号和工作区的单个裁剪预留，不返回其他账号或账本内容。 */
export async function readOwnTrimReservation(db: AdminDatabase, ownerId: string, workspaceHash: string, operationId: string) {
  z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).parse(ownerId);
  workspaceSchema.parse(workspaceHash); z.uuid().parse(operationId);
  const row = await db.getBackgroundJob(budgetKey);
  if (!row) throw new Error("后台资源预算未初始化");
  const payload = payloadSchema.parse(row.payload);
  assertGroupIntegrity(payload);
  const entry = payload.reservations.find(item => item.kind === "trim" && !item.groupIds && !item.crossEntries && item.ownerId === ownerId && item.workspaceHash === workspaceHash && item.operationId === operationId);
  const matches = payload.reservations.filter(item => item.kind === "trim" && item.groupIds && item.ownerId === ownerId && item.workspaceHash === workspaceHash && decodeTrimGroup(item).includes(operationId));
  const cross = payload.reservations.filter(item => item.crossEntries).flatMap(item => decodeCrossGroup(item).filter(candidate => candidate.ownerId === ownerId && candidate.workspaceHash === workspaceHash && candidate.operationId === operationId));
  if (matches.length + cross.length + Number(!!entry) > 1) throw new Error("裁剪分组任务重复");
  let item = entry ? await expandCommittedTrim(db, entry) : matches.length || cross.length ? await archivedTrim(db, ownerId, workspaceHash, operationId) : undefined;
  if (!item) item = await archivedInterruptedTrim(db, ownerId, workspaceHash, operationId);
  if (item && matches.length) {
    const group = matches[0]!, index = decodeTrimGroup(group).indexOf(operationId);
    if (index < 0 || Buffer.from(group.groupSizes!, "base64").readUInt32BE(index * 4) !== item.bytes) throw new Error("裁剪分组占用不一致");
  }
  if (item && cross.length && item.bytes !== cross[0]!.bytes) throw new Error("跨项目裁剪单项占用不一致");
  return item ? { state: item.state, bytes: item.bytes, digest: item.digest, sourceDigest: item.sourceDigest, requestHash: item.requestHash, parametersHash: item.parametersHash, cancellationPending: item.state === "reserved" && !!item.cancelIntent, cancellationResultPreserved: item.cancelCompletion?.outcome === "resultPreserved" } : undefined;
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
  if (!item || item.kind !== "prepare" || item.state !== "committed" || actualBytes > item.bytes) return false;
  if (actualBytes === 0) payload.reservations = payload.reservations.filter(entry => entry !== item);
  else item.bytes = actualBytes;
  if (!await db.updateBackgroundJob({ ...budgetKey, leaseOwner: lease.leaseOwner, generation: lease.generation, expectedRevision: lease.revision, payload: payloadSchema.parse(payload) })) return false;
  lease.revision++;
  return true;
}
// 仅独立运维 CLI 引入，不从包入口导出；调用方必须先核实执行隔离和相关目录不存在。
async function adminReleaseReserved(db: AdminDatabase, lease: BackgroundBudgetLease, operationId: string, kind: "prepare" | "trim", audit: { attemptId: string; actor: string; reason: string }) {
  z.uuid().parse(operationId);
  if (lease.kind !== "plan") return false;
  const row = await db.getBackgroundJob(budgetKey);
  if (!row || row.leaseOwner !== lease.leaseOwner || row.leaseGeneration !== lease.generation || row.revision !== lease.revision) return false;
  const payload = payloadSchema.parse(row.payload);
  const holder = payload.holder;
  if (!holder || holder.leaseOwner !== lease.leaseOwner || holder.ownerId !== lease.ownerId || holder.workspaceHash !== lease.workspaceHash || holder.operationId !== lease.operationId || holder.kind !== "plan") return false;
  const item = payload.reservations.find(entry => entry.operationId === operationId && entry.ownerId === lease.ownerId && entry.workspaceHash === lease.workspaceHash);
  if (!item || item.kind !== kind || item.state !== "reserved") return false;
  if ((payload.audit?.length ?? 0) >= 5000) throw new Error("审计空间不足");
  payload.audit ??= [];
  payload.audit.push({ ...audit, operationId, ownerId: lease.ownerId, workspaceHash: lease.workspaceHash, result: "released" });
  payload.reservations = payload.reservations.filter(entry => entry !== item);
  if (!await db.updateBackgroundJob({ ...budgetKey, leaseOwner: lease.leaseOwner, generation: lease.generation, expectedRevision: lease.revision, payload: payloadSchema.parse(payload) })) return false;
  lease.revision++;
  return true;
}
export async function adminReleaseReservedPrepare(db: AdminDatabase, lease: BackgroundBudgetLease, operationId: string, audit: { attemptId: string; actor: string; reason: string }) {
  return adminReleaseReserved(db, lease, operationId, "prepare", audit);
}

/** 在写私有存储前记录已结束作业的不可变结果摘要。 */
export async function recordTrimIntent(db: AdminDatabase, lease: BackgroundBudgetLease, intent: { bytes: number; digest: string; sourceDigest: string }) {
  const value = reservationSchema.shape.trimIntent.unwrap().parse(intent);
  if (lease.kind !== "trim" || !await renewBackgroundBudget(db, lease)) return false;
  const row = await db.getBackgroundJob(budgetKey);
  if (!row || row.leaseOwner !== lease.leaseOwner || row.leaseGeneration !== lease.generation || row.revision !== lease.revision) return false;
  const payload = payloadSchema.parse(row.payload), holder = payload.holder;
  if (!holder || holder.leaseOwner !== lease.leaseOwner || holder.ownerId !== lease.ownerId || holder.workspaceHash !== lease.workspaceHash || holder.operationId !== lease.operationId || holder.kind !== "trim") return false;
  const item = payload.reservations.find(entry => entry.kind === "trim" && entry.state === "reserved" && entry.ownerId === lease.ownerId && entry.workspaceHash === lease.workspaceHash && entry.operationId === lease.operationId);
  if (!item || item.trimIntent || item.cancelIntent) return false;
  item.trimIntent = value;
  if (!await db.updateBackgroundJob({ ...budgetKey, leaseOwner: lease.leaseOwner, generation: lease.generation, expectedRevision: lease.revision, payload: payloadSchema.parse(payload) })) return false;
  lease.revision++;
  return true;
}

/** 仅能恢复已确认完整落盘且摘要一致的结果；任何不确定情况保持预留。 */
export async function recoverTrimIntent(db: AdminDatabase, ownerId: string, workspaceHash: string, operationId: string,
  verify: (intent: { bytes: number; digest: string; sourceDigest: string }) => Promise<"complete" | "interrupted" | "unknown">) {
  z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).parse(ownerId); workspaceSchema.parse(workspaceHash); z.uuid().parse(operationId);
  const leaseOwner = randomUUID();
  if (!await db.acquireBackgroundJobLease({ ...budgetKey, leaseOwner, ttlMs: 120000 })) return false;
  let generation: number | undefined;
  try {
    const row = await db.getBackgroundJob(budgetKey);
    if (!row || row.leaseOwner !== leaseOwner) return false;
    generation = row.leaseGeneration;
    const payload = payloadSchema.parse(row.payload);
    const item = payload.reservations.find(entry => entry.kind === "trim" && entry.state === "reserved" && entry.ownerId === ownerId && entry.workspaceHash === workspaceHash && entry.operationId === operationId);
    if (!item?.trimIntent || item.cancelIntent || !item.requestHash || !item.parametersHash) return false;
    const verified = await verify(item.trimIntent);
    if (verified !== "complete" && verified !== "interrupted") return false;
    if (!await db.renewBackgroundJobLease({ ...budgetKey, leaseOwner, generation, ttlMs: 120000 })) return false;
    if (verified === "complete") { item.state = "committed"; item.bytes = item.trimIntent.bytes; item.digest = item.trimIntent.digest; item.sourceDigest = item.trimIntent.sourceDigest; }
    else item.state = "interrupted"; // 保留完整预留与记录，不推断磁盘占用已释放。
    delete payload.holder;
    return await db.updateBackgroundJob({ ...budgetKey, leaseOwner, generation, expectedRevision: row.revision, payload: payloadSchema.parse(payload) });
  } finally {
    if (generation !== undefined) await db.releaseBackgroundJobLease({ ...budgetKey, leaseOwner, generation }).catch(() => {});
  }
}

/** 管理端仅展示停用账号的未决操作，或此前已确认取消但尚未完成的操作。 */
export async function listDisabledUnknownTrims(db: AdminDatabase, ownerId: string) {
  z.uuid().parse(ownerId);
  const owner = await db.getUserById(ownerId);
  if (!owner) throw Object.assign(new Error("账号不存在"), { status: 404 });
  const row = await db.getBackgroundJob(budgetKey);
  if (!row) throw new Error("后台资源预算未初始化");
  const payload = payloadSchema.parse(row.payload);
  assertGroupIntegrity(payload);
  const items = payload.reservations.filter(item => item.kind === "trim" && item.state === "reserved" && item.ownerId === ownerId && item.workspaceHash && (owner.disabled || item.cancelIntent?.kind === "admin"))
    .map(item => ({ operationId: item.operationId, workspaceHash: item.workspaceHash!, status: item.cancelIntent ? "cancelling" as const : "unknown" as const }));
  return items;
}

/** 先持久化确认意图，再封禁 worker/store；未知状态始终保留预留。 */
export async function sealUnknownTrim(db: AdminDatabase, ownerId: string, workspaceHash: string, operationId: string, seal: () => Promise<boolean>, operator?: { actor: "host" | "admin:1"; reason: string }) {
  z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).parse(ownerId); workspaceSchema.parse(workspaceHash); z.uuid().parse(operationId);
  if (operator) z.strictObject({ actor: z.enum(["host", "admin:1"]), reason: z.string().trim().min(16).max(500) }).parse(operator);
  const leaseOwner = randomUUID();
  if (!await db.acquireBackgroundJobLease({ ...budgetKey, leaseOwner, ttlMs: 120000 })) return false;
  let generation: number | undefined;
  try {
    const row = await db.getBackgroundJob(budgetKey);
    if (!row || row.leaseOwner !== leaseOwner) return false;
    generation = row.leaseGeneration;
    const payload = payloadSchema.parse(row.payload);
    const item = payload.reservations.find(entry => entry.kind === "trim" && entry.ownerId === ownerId && entry.workspaceHash === workspaceHash && entry.operationId === operationId);
    if (!item) return !!await archivedInterruptedTrim(db, ownerId, workspaceHash, operationId);
    if (item?.state === "interrupted" && item.bytes === 0) return true;
    if (!item || item.state !== "reserved" || !item.requestHash || !item.parametersHash) return false;
    let revision = row.revision;
    if (!item.cancelIntent) {
      const intent = cancelIntentSchema.parse({ attemptId: randomUUID(), actor: operator?.actor ?? ownerId,
        reason: operator?.reason ?? "账号确认封禁未知裁剪任务并安全释放空间预留", kind: operator ? "admin" : "user" });
      const auditKey = { ...budgetKey, jobId: intent.attemptId };
      // 先独立留存尝试并读回；CAS 失败时该记录只表示尝试，不表示已确认或已释放。
      const auditPayload = { kind: "trimCancellationAttempt", operationId, ownerId, workspaceHash, intent };
      await db.createBackgroundJob({ ...auditKey, payload: auditPayload });
      const audit = await db.getBackgroundJob(auditKey);
      if (!audit || !isDeepStrictEqual(audit.payload, auditPayload)) return false;
      item.cancelIntent = intent;
      delete item.trimPhase;
      if (!await db.updateBackgroundJob({ ...budgetKey, leaseOwner, generation, expectedRevision: revision, payload: payloadSchema.parse(payload), ...(operator ? { requireDisabledUserId: ownerId } : {}) })) return false;
      revision++;
    } else {
      const audit = await db.getBackgroundJob({ ...budgetKey, jobId: item.cancelIntent.attemptId });
      const expected = { kind: "trimCancellationAttempt", operationId, ownerId, workspaceHash, intent: item.cancelIntent };
      if (!audit || !isDeepStrictEqual(audit.payload, expected)) return false;
    }
    // 一旦意图提交，管理员已明确确认不可逆取消；即使账号随后启用也可由授权人员继续重试。
    if (!await seal() || !await db.renewBackgroundJobLease({ ...budgetKey, leaseOwner, generation, ttlMs: 120000 })) return false;
    const completion = { eventId: randomUUID(), actor: operator?.actor ?? ownerId, at: Date.now(), outcome: "sealed" as const };
    const completionKey = { ...budgetKey, jobId: completion.eventId };
    // 此回执只证明封禁成功；账本 CAS 成功才证明预算已释放。
    const completionPayload = { kind: "trimCancellationSealed", operationId, ownerId, workspaceHash, attemptId: item.cancelIntent.attemptId, completion };
    await db.createBackgroundJob({ ...completionKey, payload: completionPayload });
    const completed = await db.getBackgroundJob(completionKey);
    if (!completed || !isDeepStrictEqual(completed.payload, completionPayload)) return false;
    item.state = "interrupted"; item.bytes = 0; item.cancelCompletion = completion; delete item.trimPhase;
    delete payload.holder;
    return await db.updateBackgroundJob({ ...budgetKey, leaseOwner, generation, expectedRevision: revision, payload: payloadSchema.parse(payload) });
  } finally { if (generation !== undefined) await db.releaseBackgroundJobLease({ ...budgetKey, leaseOwner, generation }).catch(() => {}); }
}

/** 仅真实存储校验完整结果后，将已确认的取消标记为未生效并保留结果。 */
export async function preserveCancelledTrimResult(db: AdminDatabase, ownerId: string, workspaceHash: string, operationId: string, actor: string, verify: (intent: { bytes: number; digest: string; sourceDigest: string }) => Promise<boolean>) {
  z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).parse(ownerId); workspaceSchema.parse(workspaceHash); z.uuid().parse(operationId); z.string().min(1).max(64).parse(actor); if (actor !== "host" && actor !== "admin:1" && actor !== ownerId) throw new Error("恢复操作者无效");
  const leaseOwner = randomUUID();
  if (!await db.acquireBackgroundJobLease({ ...budgetKey, leaseOwner, ttlMs: 120000 })) return false;
  let generation: number | undefined;
  try {
    const row = await db.getBackgroundJob(budgetKey);
    if (!row || row.leaseOwner !== leaseOwner) return false;
    generation = row.leaseGeneration;
    const payload = payloadSchema.parse(row.payload);
    const item = payload.reservations.find(entry => entry.kind === "trim" && entry.ownerId === ownerId && entry.workspaceHash === workspaceHash && entry.operationId === operationId);
    if (!item || item.state !== "reserved" || !item.cancelIntent || !item.trimIntent || !item.requestHash || !item.parametersHash) return false;
    const original = await db.getBackgroundJob({ ...budgetKey, jobId: item.cancelIntent.attemptId });
    if (!original || !isDeepStrictEqual(original.payload, { kind: "trimCancellationAttempt", operationId, ownerId, workspaceHash, intent: item.cancelIntent })) return false;
    if (!await verify(item.trimIntent) || !await db.renewBackgroundJobLease({ ...budgetKey, leaseOwner, generation, ttlMs: 120000 })) return false;
    const completion = { eventId: randomUUID(), actor, at: Date.now(), outcome: "resultPreserved" as const };
    const key = { ...budgetKey, jobId: completion.eventId };
    const receipt = { kind: "trimCancellationResultVerified", operationId, ownerId, workspaceHash, attemptId: item.cancelIntent.attemptId, completion };
    await db.createBackgroundJob({ ...key, payload: receipt });
    const written = await db.getBackgroundJob(key);
    if (!written || !isDeepStrictEqual(written.payload, receipt)) return false;
    item.state = "committed"; item.bytes = item.trimIntent.bytes; item.digest = item.trimIntent.digest; item.sourceDigest = item.trimIntent.sourceDigest; item.cancelCompletion = completion;
    delete payload.holder;
    return await db.updateBackgroundJob({ ...budgetKey, leaseOwner, generation, expectedRevision: row.revision, payload: payloadSchema.parse(payload), ...(actor === ownerId ? { requireEnabledUserId: ownerId } : {}) });
  } finally { if (generation !== undefined) await db.releaseBackgroundJobLease({ ...budgetKey, leaseOwner, generation }).catch(() => {}); }
}

/** 仅释放已封禁且无结果文件的中断任务预留；保留账本记录。 */
export async function releaseInterruptedTrim(db: AdminDatabase, ownerId: string, workspaceHash: string, operationId: string, confirmSealed: () => Promise<boolean>) {
  z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).parse(ownerId); workspaceSchema.parse(workspaceHash); z.uuid().parse(operationId);
  const leaseOwner = randomUUID();
  if (!await db.acquireBackgroundJobLease({ ...budgetKey, leaseOwner, ttlMs: 120000 })) return false;
  let generation: number | undefined;
  try {
    const row = await db.getBackgroundJob(budgetKey);
    if (!row || row.leaseOwner !== leaseOwner) return false;
    generation = row.leaseGeneration;
    const payload = payloadSchema.parse(row.payload);
    const item = payload.reservations.find(entry => entry.kind === "trim" && entry.state === "interrupted" && entry.ownerId === ownerId && entry.workspaceHash === workspaceHash && entry.operationId === operationId);
    if (!item) return !!await archivedInterruptedTrim(db, ownerId, workspaceHash, operationId);
    if (!item || !item.trimIntent || !await confirmSealed()) return false;
    if (!await db.renewBackgroundJobLease({ ...budgetKey, leaseOwner, generation, ttlMs: 120000 })) return false;
    item.bytes = 0;
    return await db.updateBackgroundJob({ ...budgetKey, leaseOwner, generation, expectedRevision: row.revision, payload: payloadSchema.parse(payload) });
  } finally { if (generation !== undefined) await db.releaseBackgroundJobLease({ ...budgetKey, leaseOwner, generation }).catch(() => {}); }
}
/** actualBytes 不传时保留全部预留；传 0 仅适用于确认已清理的情况。 */
export async function finishBackgroundBudget(db: AdminDatabase, lease: BackgroundBudgetLease, actualBytes?: number, digest?: string, sourceDigest?: string) {
  if (actualBytes !== undefined) z.number().int().min(0).max(perJobBytes).parse(actualBytes);
  const row = await db.getBackgroundJob(budgetKey);
  if (!row || row.leaseOwner !== lease.leaseOwner || row.leaseGeneration !== lease.generation || row.revision !== lease.revision) return false;
  const stored = payloadSchema.parse(row.payload);
  if (!stored.holder || stored.holder.leaseOwner !== lease.leaseOwner || stored.holder.ownerId !== lease.ownerId || stored.holder.workspaceHash !== lease.workspaceHash || stored.holder.operationId !== lease.operationId || stored.holder.kind !== lease.kind) return false;
  if (lease.kind !== "plan" && actualBytes !== undefined) {
    const payload: Payload = stored;
    const item = payload.reservations.find(item => item.operationId === lease.operationId && item.ownerId === lease.ownerId && item.workspaceHash === lease.workspaceHash);
    if (!item || item.cancelIntent || item.kind !== lease.kind || item.state !== "reserved" || actualBytes > item.bytes) throw new Error("后台资源预留不存在或超出预留额度");
    if (actualBytes === 0) payload.reservations = payload.reservations.filter(entry => entry !== item);
    else {
      if (lease.kind === "trim") {
        item.digest = z.string().regex(/^[a-f0-9]{64}$/).parse(digest);
        item.sourceDigest = z.string().regex(/^[a-f0-9]{64}$/).parse(sourceDigest);
        if (!item.trimIntent || item.trimIntent.bytes !== actualBytes || item.trimIntent.digest !== item.digest || item.trimIntent.sourceDigest !== item.sourceDigest) throw new Error("裁剪持久化摘要不一致");
      }
      item.bytes = actualBytes; item.state = "committed";
    }
    if (!await db.updateBackgroundJob({ ...budgetKey, leaseOwner: lease.leaseOwner, generation: lease.generation, expectedRevision: lease.revision, payload: payloadSchema.parse(payload) })) return false;
    lease.revision++;
  }
  return db.releaseBackgroundJobLease({ ...budgetKey, leaseOwner: lease.leaseOwner, generation: lease.generation });
}

/** 离线备份校验使用，不从包入口导出；调用者必须先确认所有写入者均已停机。 */
export async function verifyTrimBackupIndex(db: AdminDatabase, inspect: (item: { ownerId: string; workspaceHash: string; operationId: string; bytes: number; digest: string }) => Promise<boolean>) {
  const row = await db.getBackgroundJob(budgetKey);
  if (!row || row.leaseOwner !== null) throw new Error("备份账本不存在或仍有租约");
  const payload = payloadSchema.parse(row.payload);
  assertGroupIntegrity(payload);
  const seen = new Set<string>();
  let files = 0, bytes = 0;
  async function check(item: Reservation, expected?: number) {
    if (item.kind !== "trim" || item.state !== "committed" || !item.workspaceHash || !item.digest || !item.sourceDigest || !item.requestHash || !item.parametersHash
      || !item.bytes || item.bytes > 128 * 1024 * 1024 || expected !== undefined && item.bytes !== expected || seen.has(item.operationId)) throw new Error("备份裁剪账本异常");
    seen.add(item.operationId);
    if (!await inspect({ ownerId: item.ownerId, workspaceHash: item.workspaceHash, operationId: item.operationId, bytes: item.bytes, digest: item.digest })) throw new Error("备份裁剪素材与账本不一致");
    files++; bytes += item.bytes;
  }
  for (const entry of payload.reservations) {
    if (!entry.kind) throw new Error("备份账本存在未分类记录，不能证明裁剪完整");
    if (entry.kind !== "trim") {
      if (entry.archived || entry.groupIds || entry.groupSizes || entry.crossEntries || entry.digest || entry.sourceDigest || entry.requestHash || entry.parametersHash || entry.trimRequest || entry.trimIntent) throw new Error("备份账本存在类型不一致的裁剪信息");
      continue;
    }
    if (entry.state === "reserved" || entry.state === "interrupted" && entry.bytes > 0) throw new Error("仍有未确认的裁剪记录，不能证明备份一致");
    if (entry.state === "interrupted" && entry.bytes === 0) continue;
    if (entry.crossEntries) {
      for (const value of decodeCrossGroup(entry)) await check(await archivedTrim(db, value.ownerId, value.workspaceHash, value.operationId), value.bytes);
    } else if (entry.groupIds) {
      if (!entry.workspaceHash) throw new Error("备份裁剪账本异常");
      const ids = decodeTrimGroup(entry), sizes = Buffer.from(entry.groupSizes!, "base64");
      for (let index = 0; index < ids.length; index++) await check(await archivedTrim(db, entry.ownerId, entry.workspaceHash, ids[index]!), sizes.readUInt32BE(index * 4));
    } else {
      await check(await expandCommittedTrim(db, entry));
    }
  }
  return { files, bytes };
}
