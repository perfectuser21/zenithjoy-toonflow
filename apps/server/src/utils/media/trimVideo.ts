import { trimMode } from "@/utils/media/trimMode";
import { constants, lstat, open, readlink, realpath } from "@toonflow/file";
import { request as httpRequest } from "node:http";
import { dirname, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { acquireBackgroundBudget, finishBackgroundBudget, listOwnTrimReservations, markTrimDispatched, openDatabase, readOwnTrimReservation, recordTrimIntent, recoverTrimIntent, releaseInterruptedTrim, renewBackgroundBudget } from "@toonflow/multi-tenant-db";
import { z } from "zod";
import conf from "@/utils/conf";
import { pipeline } from "node:stream/promises";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import { withWorkspaceQuota } from "@/utils/workspace/quota";
import { ensureProjectQuota } from "@/utils/workspace/projectQuota";
import { trimStoreRequest } from "@/utils/media/trimStoreClient";
import { withSealedMedia } from "@/utils/media/sealedMedia";
import { ensureTrimSingleton } from "@/utils/media/trimSingleton";
import { readTrimSecret } from "@/utils/media/trimSecret";

const maxInput = 512 * 1024 * 1024, maxOutput = 128 * 1024 * 1024;
let databasePromise: ReturnType<typeof openDatabase> | undefined;
function invalid(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
async function databaseAccess<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch { return invalid("裁剪资源存储不可用，请联系管理员", 503); }
}
function within(root: string, path: string) { const part = relative(root, path); return part !== ".." && !part.startsWith(`..${sep}`) && !part.startsWith("/"); }
async function verifiedFd(root: string, fd: number) {
  const target = await readlink(`/proc/self/fd/${fd}`);
  if (!target.startsWith("/") || !within(root, target) || target.endsWith(" (deleted)")) invalid("工作区文件位置已变化", 409);
  return target;
}
function identity(info: { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
function requestHash(source: string, start: number, end: number, fileIdentity: string) {
  return createHash("sha256").update(JSON.stringify({ source, start, end, fileIdentity })).digest("hex");
}
function parametersHash(source: string, start: number, end: number) {
  return createHash("sha256").update(JSON.stringify({ source, start, end })).digest("hex");
}

// 客户裁剪只使用经认证的固定处理器；不将用户路径或命令传入隔离执行器。
export async function getTrimWorkerConfig() {
  await ensureTrimSingleton();
  if (process.platform !== "linux") invalid("安全裁剪暂未在此系统开放", 503);
  const socket = process.env.TOONFLOW_TRIM_SOCKET;
  const uid = process.env.TOONFLOW_TRIM_HELPER_UID;
  if (!socket || !socket.startsWith("/") || process.env.TOONFLOW_TRIM_TOKEN || !uid || !/^[0-9]+$/.test(uid) || Number(uid) < 1) invalid("安全裁剪尚未配置", 503);
  const token = await readTrimSecret(process.env.TOONFLOW_TRIM_TOKEN_FILE).catch(() => invalid("安全裁剪尚未配置", 503));
  const socketDirectory = dirname(resolve(socket));
  const directoryInfo = await lstat(socketDirectory), socketInfo = await lstat(socket);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || await realpath(socketDirectory) !== socketDirectory
    || (directoryInfo.mode & 0o027) !== 0 || !socketInfo.isSocket() || socketInfo.isSymbolicLink()
    || (socketInfo.mode & 0o007) !== 0 || directoryInfo.uid !== 0 || socketInfo.uid !== Number(uid)
    || directoryInfo.gid !== socketInfo.gid || process.getuid && directoryInfo.uid === process.getuid()) invalid("安全裁剪连接不可用", 503);
  for (let parent = dirname(socketDirectory);;) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || info.uid !== 0 && info.uid !== Number(uid)
      || process.getuid && info.uid === process.getuid()) invalid("安全裁剪连接路径不安全", 503);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return { socket, token };
}
export async function trimVideo(cwd: string, sourcePath: string, start: number, end: number, signal: AbortSignal, ownerId: string, authorize: () => Promise<void>, operationId: string) {
  const managed = await withManagedTrim(cwd, ownerId, sourcePath, signal, bytes => withSealedMedia(bytes, path => trimVideoFromSource(cwd, sourcePath, start, end, signal, ownerId, authorize, operationId, path)));
  if (managed.managed) return managed.value;
  return trimVideoFromSource(cwd, sourcePath, start, end, signal, ownerId, authorize, operationId);
}

async function trimVideoFromSource(cwd: string, sourcePath: string, start: number, end: number, signal: AbortSignal, ownerId: string, authorize: () => Promise<void>, operationId: string, sealedPath?: string) {
  const { socket, token } = await getTrimWorkerConfig();
  await authorize();
  await ensureProjectQuota(ownerId, "trimInit");
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 120) invalid("裁剪时间范围无效");
  const { source, sourceFile } = await (async () => {
    const release = lockWorkspaceFiles([cwd]);
    try {
      await authorize();
      const source = sealedPath ? { path: sealedPath } : await resolveWorkspacePath(cwd, sourcePath);
      const sourceFile = await open(source.path, constants.O_RDONLY | (sealedPath ? 0 : constants.O_NOFOLLOW));
      try { if (!sealedPath && await verifiedFd(cwd, sourceFile.fd) !== source.path) invalid("源视频位置已变化", 409); }
      catch (error) { await sourceFile.close(); throw error; }
      return { source, sourceFile };
    } finally { release(); }
  })();
  try {
    const info = await sourceFile.stat();
    if (!info.isFile() || !sealedPath && info.nlink !== 1 || info.size < 1 || info.size > maxInput) invalid("源视频必须是大小不超过 512MB 的普通文件", 413);
    if (!sealedPath && await verifiedFd(cwd, sourceFile.fd) !== source.path) invalid("源视频位置已变化", 409);
    const nodeId = z.uuidv4().parse(operationId), path = `assets/${nodeId}/video.mp4`, expected = resolve(cwd, path);
    databasePromise ??= openDatabase(dirname(conf.path), false);
    const database = await databaseAccess(() => databasePromise!);
    if (!database) invalid("裁剪资源存储不可用", 503);
    const lease = await databaseAccess(() => acquireBackgroundBudget(database, { operationId: nodeId, ownerId, workspaceHash: createHash("sha256").update(cwd).digest("hex"), kind: "trim", requestHash: requestHash(source.path, start, end, identity(info)), parametersHash: parametersHash(sourcePath, start, end), trimRequest: { source: sourcePath, start, end } }));
    if (!lease) invalid("裁剪服务繁忙或空间不足", 429);
    const controller = new AbortController(), active = AbortSignal.any([signal, controller.signal]);
    const timer = setInterval(() => { void renewBackgroundBudget(database, lease).then(ok => { if (!ok) controller.abort(); }).catch(() => controller.abort()); }, 30000);
    // 在请求交给 worker 之前，确认没有任何远程作业；交付后须等待明确终态。
    let touched = false, finalized = false, helperSettled = true;
    try {
      // 先短暂检查容量，不在耗时转码期间持有跨用户工作区锁。
      await withWorkspaceQuota(expected, maxOutput, false, async () => {});
        const baseline = createHash("sha256");
        for await (const chunk of sourceFile.createReadStream({ autoClose: false, start: 0 })) { active.throwIfAborted(); baseline.update(chunk); }
        const originalDigest = baseline.digest("hex");
        if (identity(await sourceFile.stat()) !== identity(info) || !sealedPath && await verifiedFd(cwd, sourceFile.fd) !== source.path) invalid("原视频在裁剪前已变化", 409);
        active.throwIfAborted();
        if (!await databaseAccess(() => markTrimDispatched(database, lease))) invalid("裁剪租约已失效", 409);
        active.throwIfAborted();
        const sourceHash = createHash("sha256");
        let upload: Promise<void> | undefined;
        const response = await new Promise<import("node:http").IncomingMessage>((resolveResponse, reject) => {
          helperSettled = false;
          const req = httpRequest({ socketPath: socket, path: "/trim", method: "POST", headers: { authorization: `Bearer ${token}`, "content-length": String(info.size), "x-trim-start": String(start), "x-trim-end": String(end), "x-trim-operation": nodeId, "x-trim-owner": ownerId, "x-trim-workspace": createHash("sha256").update(cwd).digest("hex") }, signal: AbortSignal.any([active, AbortSignal.timeout(240000)]) }, resolveResponse);
          req.once("error", reject);
          const input = sourceFile.createReadStream({ autoClose: false, start: 0 });
          input.on("data", chunk => sourceHash.update(chunk));
          upload = pipeline(input, req);
          void upload.catch(reject);
        });
        if (response.statusCode !== 200) {
          // 422 仅由管理器在确认容器消失后返回；503/断连均视为状态未知。
          helperSettled = [400, 403, 404, 422, 429].includes(response.statusCode ?? 0);
          response.resume(); invalid("安全裁剪失败，请检查视频或稍后重试", response.statusCode === 429 ? 429 : 422);
        }
        const duration = Number(response.headers["x-trim-duration"]), width = Number(response.headers["x-trim-width"]), height = Number(response.headers["x-trim-height"]);
        if (!Number.isFinite(duration) || Math.abs(duration - (end - start)) > 0.15 || !Number.isInteger(width) || width < 1 || width > 3840 || !Number.isInteger(height) || height < 1 || height > 3840) invalid("裁剪结果信息无效", 422);
        const chunks: Buffer[] = [], hash = createHash("sha256"); let size = 0;
        for await (const chunk of response) { active.throwIfAborted(); size += chunk.length; if (size > maxOutput) invalid("裁剪结果超过空间上限", 413); hash.update(chunk); chunks.push(Buffer.from(chunk)); }
        if (!upload) invalid("裁剪输入状态无效", 503);
        await upload;
        if (sourceHash.digest("hex") !== originalDigest) invalid("原视频在裁剪期间发生变化", 409);
        helperSettled = true;
        if (!size || identity(await sourceFile.stat()) !== identity(info) || !sealedPath && await verifiedFd(cwd, sourceFile.fd) !== source.path) invalid("文件在裁剪期间发生变化", 409);
        await authorize(); active.throwIfAborted();
        if (!await databaseAccess(() => renewBackgroundBudget(database, lease))) invalid("裁剪租约已失效", 409);
        await authorize(); active.throwIfAborted();
        const outputDigest = hash.digest("hex");
        if (!await databaseAccess(() => recordTrimIntent(database, lease, { bytes: size, digest: outputDigest, sourceDigest: originalDigest }))) invalid("裁剪租约已变化", 409);
        touched = true; // 存储请求一经发出即可能落盘；未知状态保留预留。
        // 只在最终落盘期间持锁并重新核验空间；项目配额仍对整个私有目录生效。
        await withWorkspaceQuota(expected, size, false, async () => trimStoreRequest("POST", ownerId, createHash("sha256").update(cwd).digest("hex"), nodeId, active, Buffer.concat(chunks)));
        await authorize(); active.throwIfAborted();
        if (!await databaseAccess(() => renewBackgroundBudget(database, lease))) invalid("裁剪租约已变化", 409);
        if (!await databaseAccess(() => finishBackgroundBudget(database, lease, size, outputDigest, originalDigest))) invalid("裁剪资源状态已变化", 409);
        finalized = true;
      return { nodeId, outputPath: path, duration, width, height };
    } finally {
      clearInterval(timer);
      if (!finalized) await finishBackgroundBudget(database, lease, !touched && helperSettled ? 0 : undefined).catch(() => {});
    }
  } finally { await sourceFile.close(); }
}

export async function assertActiveTrimOwner(ownerId: string) {
  databasePromise ??= openDatabase(dirname(conf.path), false);
  const database = await databaseAccess(() => databasePromise!);
  if (!database) invalid("裁剪资源存储不可用", 503);
  const owner = await databaseAccess(() => database.getUserById(ownerId));
  if (!owner || owner.disabled) invalid("账号已停用，不能上传裁剪素材", 403);
}

export async function listTrimRecoveries(cwd: string, ownerId: string) {
  databasePromise ??= openDatabase(dirname(conf.path), false);
  const database = await databaseAccess(() => databasePromise!);
  if (!database) invalid("裁剪资源存储不可用", 503);
  return databaseAccess(() => listOwnTrimReservations(database, ownerId, createHash("sha256").update(cwd).digest("hex")));
}

export async function releaseInterruptedTrimSpace(cwd: string, ownerId: string, operationId: string, authorize: () => Promise<void>) {
  await ensureTrimSingleton();
  databasePromise ??= openDatabase(dirname(conf.path), false);
  const db = await databaseAccess(() => databasePromise!);
  if (!db) invalid("裁剪资源存储不可用", 503);
  const workspaceHash = createHash("sha256").update(cwd).digest("hex");
  const released = await databaseAccess(() => releaseInterruptedTrim(db, ownerId, workspaceHash, operationId, async () => {
    try { await trimStoreRequest("SEAL", ownerId, workspaceHash, operationId, AbortSignal.timeout(30000)); await authorize(); return true; }
    catch { return false; }
  }));
  if (!released) invalid("暂无法确认中断任务的空间状态", 409);
}

let managedReadBusy = false;
/** 托管素材在回调内持有限额；不存在记录时由调用方读取普通工作区素材。 */
export async function withManagedTrim<T>(cwd: string, ownerId: string, reference: string, signal: AbortSignal, consume: (bytes: Buffer) => Promise<T>): Promise<{ managed: false } | { managed: true; value: T }> {
  if (!trimMode().read) return { managed: false };
  const match = /^assets\/([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/video\.mp4$/.exec(reference);
  if (!match) return { managed: false };
  databasePromise ??= openDatabase(dirname(conf.path), false);
  const db = await databaseAccess(() => databasePromise!);
  if (!db) invalid("裁剪资源存储不可用", 503);
  const workspaceHash = createHash("sha256").update(cwd).digest("hex");
  const record = await databaseAccess(() => readOwnTrimReservation(db, ownerId, workspaceHash, match[1]!));
  if (!record) return { managed: false };
  await ensureTrimSingleton();
  if (record.state !== "committed" || !record.digest || !record.requestHash || !record.sourceDigest) invalid("裁剪结果尚未确认", 409);
  if (managedReadBusy) invalid("裁剪素材正在读取，请稍后重试", 429);
  managedReadBusy = true;
  try {
    const bytes = await trimStoreRequest("GET", ownerId, workspaceHash, match[1]!, signal);
    if (!bytes || bytes.length !== record.bytes || createHash("sha256").update(bytes).digest("hex") !== record.digest) invalid("裁剪结果无法确认", 409);
    return { managed: true, value: await consume(bytes) };
  } finally { managedReadBusy = false; }
}

export async function trimStatus(cwd: string, ownerId: string, operationId: string, sourcePath: string, start: number, end: number, allowRecovery = true) {
  await ensureTrimSingleton();
  const nodeId = z.uuidv4().parse(operationId);
  databasePromise ??= openDatabase(dirname(conf.path), false);
  const db = await databaseAccess(() => databasePromise!);
  if (!db) invalid("裁剪资源存储不可用", 503);
  const record = await databaseAccess(() => readOwnTrimReservation(db, ownerId, createHash("sha256").update(cwd).digest("hex"), nodeId));
  if (!record) return { status: allowRecovery ? "notFound" as const : "pending" as const };
  if (parametersHash(sourcePath, start, end) !== record.parametersHash) invalid("截取请求与原记录不一致，请联系管理员", 409);
  if (record.state === "interrupted") return { status: allowRecovery ? "interrupted" as const : "pending" as const };
  if (!allowRecovery && record.state !== "committed") return { status: "pending" as const };
  const path = `assets/${nodeId}/video.mp4`;
  if (record.state !== "committed") {
    if (managedReadBusy) return { status: "pending" as const };
    managedReadBusy = true;
    try {
      const workspaceHash = createHash("sha256").update(cwd).digest("hex");
      const recovered = await databaseAccess(() => recoverTrimIntent(db, ownerId, workspaceHash, nodeId, async intent => {
        try {
          const bytes = await trimStoreRequest("GET", ownerId, workspaceHash, nodeId, AbortSignal.timeout(30000));
          return bytes && bytes.length === intent.bytes && createHash("sha256").update(bytes).digest("hex") === intent.digest ? "complete" : "unknown";
        } catch (error) {
          if (!["ETRIMNOTFOUND", "ETRIMSEALED"].includes((error as { code?: string })?.code ?? "")) return "unknown";
          try { await trimStoreRequest("SEAL", ownerId, workspaceHash, nodeId, AbortSignal.timeout(30000)); return "interrupted"; }
          catch { return "unknown"; }
        }
      }));
      if (!recovered) return { status: "pending" as const };
      const updated = await databaseAccess(() => readOwnTrimReservation(db, ownerId, workspaceHash, nodeId));
      if (updated?.state === "interrupted") return { status: "interrupted" as const };
    } finally { managedReadBusy = false; }
  }
  const result = await withManagedTrim(cwd, ownerId, path, AbortSignal.timeout(30000), async () => true);
  if (!result.managed) invalid("裁剪结果无法确认", 409);
  return { status: "ready" as const, nodeId, outputPath: path };
}
