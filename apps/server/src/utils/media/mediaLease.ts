import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { openDatabase } from "@toonflow/multi-tenant-db";
import type { AuthIdentity } from "@toonflow/multi-tenant-auth";
import type { GeneratedMedia } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";

type Key = { jobId: string; ownerId: string; workspaceHash: string };
export type MediaLease = { key: Key; taskId: string; leaseOwner: string; generation: number; revision: number; checkpointGeneration?: number; checkpointId?: string; executionGeneration?: number; takeoverObserved?: boolean };
let database: ReturnType<typeof openDatabase> | undefined;
async function db() {
  database ??= openDatabase(dirname(conf.path), false);
  const value = await database;
  if (!value) throw new Error("database unavailable");
  return value;
}
async function access<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch { throw Object.assign(new Error("媒体任务租约不可用，请联系管理员"), { status: 503 }); }
}
function key(cwd: string, leaseId: string, ownerId: string): Key {
  return { jobId: leaseId, ownerId, workspaceHash: createHash("sha256").update(cwd).digest("hex") };
}
export async function createMediaLease(cwd: string, leaseId: string, taskId: string, actor: AuthIdentity) {
  const value = key(cwd, leaseId, actor.id);
  return access(async () => (await db()).createBackgroundJob({ ...value, payload: { kind: "mediaTask", taskId, state: "pending" } }));
}
export async function acquireMediaLease(cwd: string, leaseId: string, taskId: string, ownerId: string): Promise<MediaLease | undefined> {
  return access(async () => {
    const database = await db(), value = key(cwd, leaseId, ownerId), leaseOwner = randomUUID();
    if (!await database.acquireBackgroundJobLease({ ...value, leaseOwner, ttlMs: 120000 })) return undefined;
    const row = await database.getBackgroundJob(value);
    if (!row || row.payload.kind !== "mediaTask" || row.payload.taskId !== taskId || row.leaseOwner !== leaseOwner) {
      if (row?.leaseOwner === leaseOwner) await database.releaseBackgroundJobLease({ ...value, leaseOwner, generation: row.leaseGeneration });
      throw new Error("invalid media lease");
    }
    const checkpoint = row.payload.checkpointGeneration;
    if (checkpoint !== undefined && (!Number.isSafeInteger(checkpoint) || (checkpoint as number) < 1 || (checkpoint as number) > row.leaseGeneration)) {
      await database.releaseBackgroundJobLease({ ...value, leaseOwner, generation: row.leaseGeneration });
      throw new Error("invalid checkpoint generation");
    }
    const checkpointId = row.payload.checkpointId;
    if (checkpoint === undefined && checkpointId !== undefined || checkpoint !== undefined && (typeof checkpointId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(checkpointId))) {
      await database.releaseBackgroundJobLease({ ...value, leaseOwner, generation: row.leaseGeneration });
      throw new Error("invalid checkpoint id");
    }
    const executionGeneration = row.payload.executionGeneration;
    const takeoverObserved = row.payload.takeoverObserved;
    if (executionGeneration !== undefined && (!Number.isSafeInteger(executionGeneration) || (executionGeneration as number) < 1 || (executionGeneration as number) > row.leaseGeneration || typeof takeoverObserved !== "boolean")) {
      await database.releaseBackgroundJobLease({ ...value, leaseOwner, generation: row.leaseGeneration });
      throw new Error("invalid execution generation");
    }
    return { key: value, taskId, leaseOwner, generation: row.leaseGeneration, revision: row.revision,
      ...(typeof executionGeneration === "number" && typeof takeoverObserved === "boolean" ? { executionGeneration, takeoverObserved } : {}),
      ...(typeof checkpoint === "number" && typeof checkpointId === "string" ? { checkpointGeneration: checkpoint, checkpointId } : {}) };
  });
}
export async function renewMediaLease(lease: MediaLease) {
  return access(async () => (await db()).renewBackgroundJobLease({ ...lease.key, leaseOwner: lease.leaseOwner, generation: lease.generation, ttlMs: 120000 }));
}
export async function publishMediaCheckpoint(lease: MediaLease, checkpointId: string, files?: GeneratedMedia[]) {
  const updated = await access(async () => (await db()).updateBackgroundJob({ ...lease.key, leaseOwner: lease.leaseOwner, generation: lease.generation,
    expectedRevision: lease.revision, payload: { kind: "mediaTask", taskId: lease.taskId, state: files ? "succeeded" : "working",
      checkpointGeneration: lease.generation, checkpointId,
      ...(lease.executionGeneration ? { executionGeneration: lease.executionGeneration, takeoverObserved: lease.takeoverObserved ?? false } : {}),
      ...(files ? { files: files.map(({ path, mimeType, mediaType }) => ({ path, mimeType, mediaType })) } : {}) } }));
  if (updated) { lease.revision++; lease.checkpointGeneration = lease.generation; lease.checkpointId = checkpointId; }
  return updated;
}
// 只有真正启动执行或恢复才记录执行代次；只读查询取得租约不等于发生接管。
export async function beginMediaExecution(lease: MediaLease) {
  const takeoverObserved = lease.takeoverObserved === true || lease.executionGeneration !== undefined && lease.executionGeneration !== lease.generation;
  const row = await access(async () => (await db()).getBackgroundJob(lease.key));
  if (!row || row.revision !== lease.revision || row.leaseOwner !== lease.leaseOwner || row.leaseGeneration !== lease.generation) return false;
  const payload = { ...row.payload, executionGeneration: lease.generation, takeoverObserved };
  const updated = await access(async () => (await db()).updateBackgroundJob({ ...lease.key, leaseOwner: lease.leaseOwner,
    generation: lease.generation, expectedRevision: lease.revision, payload }));
  if (updated) { lease.revision++; lease.executionGeneration = lease.generation; lease.takeoverObserved = takeoverObserved; }
  return updated;
}
export async function releaseMediaLease(lease: MediaLease) {
  return access(async () => (await db()).releaseBackgroundJobLease({ ...lease.key, leaseOwner: lease.leaseOwner, generation: lease.generation }));
}
export async function readMediaLease(cwd: string, leaseId: string, taskId: string, ownerId: string) {
  const row = await access(async () => (await db()).getBackgroundJob(key(cwd, leaseId, ownerId)));
  if (!row || row.payload.kind !== "mediaTask" || row.payload.taskId !== taskId) return undefined;
  return row.payload;
}
