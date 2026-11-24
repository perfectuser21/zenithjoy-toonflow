import { createHash, randomUUID } from "node:crypto";
import { assertPreparedCleanupReservation } from "@/utils/media/backgroundCleanupGuard";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { lstat, mkdir, readdir, realpath, rm, rmdir, stat, unlink } from "@toonflow/file";
import { acquireBackgroundBudget, finishBackgroundBudget, listBackgroundReservations, openDatabase, reconcileBackgroundReservation, renewBackgroundBudget } from "@toonflow/multi-tenant-db";
import type { BackgroundBudgetLease, AdminDatabase } from "@toonflow/multi-tenant-db";
import type { AuthIdentity } from "@toonflow/multi-tenant-auth";
import { z } from "zod";
import conf from "@/utils/conf";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { inspectBackgroundVideo, mergeBackgroundVideo, planGuidedSegments, splitBackgroundVideo } from "@/utils/media/backgroundPlan";
import * as mediaTasks from "@/utils/media/tasks";
import { acquireMediaLease, createMediaLease, readMediaLease, releaseMediaLease, renewMediaLease, type MediaLease } from "@/utils/media/mediaLease";
import { modelGateway } from "@/utils/multiTenant/gateway";
import { createVideoFrame } from "@/utils/media/preview";
import { writeWorkspaceFile } from "@/utils/workspace/files";
import { backgroundMediaPolicy } from "@/utils/multiTenant/backgroundAdmission";
import { withManagedTrim } from "@/utils/media/trimVideo";
import { withSealedMedia } from "@/utils/media/sealedMedia";

const backgroundImageSchema = z.strictObject({ path: z.string().min(1), mimeType: z.string().regex(/^image\//) });
const shotGuidanceSchema = z.strictObject({ image: backgroundImageSchema, revision: z.string().min(1), prompt: z.string().trim().min(1).max(4000) });
const timelineSchema = z.strictObject({ fps: z.number().finite().min(16).max(120), frameRate: z.string().regex(/^\d{1,8}\/\d{1,8}$/), frameCount: z.number().int().positive() });
const partSchema = z.strictObject({ path: z.string().min(1), mimeType: z.literal("video/mp4"), duration: z.number().positive(),
  startSeconds: z.number().nonnegative(), endSeconds: z.number().positive(), fileRevision: z.string().min(1), taskId: z.uuid(), leaseId: z.uuid(),
  retryIds: z.array(z.uuid()).max(32).optional(), state: z.enum(["pending", "submitting", "submitted", "succeeded", "failed", "unknown", "cancelled"]), resultPath: z.string().optional(), resultRevision: z.string().optional() });
const payloadSchema = z.strictObject({ version: z.literal(1), sourcePath: z.string().min(1), sourceRevision: z.string().min(1), duration: z.number().positive(),
  stage: z.enum(["prepared", "confirmed", "cancelling", "cancelled", "completed", "cleaned"]), parts: z.array(partSchema).min(1).max(100),
  timeline: timelineSchema.optional(), shots: z.array(shotGuidanceSchema).min(1).max(24).optional(),
  image: backgroundImageSchema.optional(), imageRevision: z.string().optional(),
  modelId: z.string().min(1).max(256).optional(), mode: z.array(z.string()).min(1).max(3).optional(), prompt: z.string().min(1).max(100000).optional(), resultPath: z.string().optional() });
type Payload = z.infer<typeof payloadSchema>;
type Access = { jobId: string; ownerId: string; workspaceHash: string };
let database: ReturnType<typeof openDatabase> | undefined;
async function db() {
  database ??= openDatabase(dirname(conf.path), false);
  const value = await database;
  if (!value) throw Object.assign(new Error("多租户数据源尚未初始化"), { status: 503 });
  return value;
}
function invalid(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
async function databaseAccess<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch { return invalid("长视频任务存储不可用，请联系管理员", 503); }
}
function access(cwd: string, jobId: string, actor: AuthIdentity): Access {
  z.uuid().parse(jobId);
  if (!actor?.id || !["user", "admin"].includes(actor.role)) invalid("请先登录 Toonflow", 401);
  return { jobId, ownerId: actor.id, workspaceHash: createHash("sha256").update(cwd).digest("hex") };
}
async function revision(path: string) {
  const info = await stat(path);
  if (!info.isFile() || !info.size) invalid("原视频不存在或为空");
  return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
async function withVideoSource<T>(cwd: string, reference: string, actor: AuthIdentity, signal: AbortSignal, use: (path: string, version: string) => Promise<T>): Promise<T> {
  if (actor.role === "user") {
    const managed = await withManagedTrim(cwd, actor.id, reference, signal, bytes => withSealedMedia(bytes, path => use(path, `sha256:${createHash("sha256").update(bytes).digest("hex")}`)));
    if (managed.managed) return managed.value;
  }
  const file = await resolveWorkspacePath(cwd, reference);
  return use(file.path, await revision(file.path));
}
async function verifySource(cwd: string, payload: Payload, actor: AuthIdentity, signal: AbortSignal) {
  await withVideoSource(cwd, payload.sourcePath, actor, signal, async (_path, version) => { if (version !== payload.sourceRevision) invalid("原视频已改变，请重新准备项目", 409); });
}
function jobFolder(jobId: string) { return `assets/generated/background${jobId.replaceAll("-", "")}`; }
async function jobBytes(cwd: string, jobId: string) {
  const root = await resolveWorkspacePath(cwd, jobFolder(jobId));
  let bytes = 0, count = 0;
  async function visit(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++count > 1000 || entry.isSymbolicLink()) invalid("任务目录包含过多文件或符号链接", 409);
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) bytes += (await lstat(child)).size;
      else invalid("任务目录包含不支持的文件", 409);
      if (bytes > 512 * 1024 * 1024) invalid("任务空间额度不足，请清理后重试", 413);
    }
  }
  await visit(root.path);
  return bytes;
}

async function withBudget<T>(cwd: string, actor: AuthIdentity, kind: "plan" | "prepare" | "frame", signal: AbortSignal,
  operation: (operationId: string, active: AbortSignal, check: () => Promise<void>, lease: BackgroundBudgetLease, database: AdminDatabase) => Promise<{ value: T; bytes?: number }>,
  clean?: (operationId: string) => Promise<boolean>, requestedId?: string) {
  const database = await db();
  const operationId = requestedId ? z.uuid().parse(requestedId) : randomUUID();
  const workspaceHash = createHash("sha256").update(cwd).digest("hex");
  const lease = await databaseAccess(() => acquireBackgroundBudget(database, { operationId, ownerId: actor.id, workspaceHash, kind }));
  if (!lease) invalid("后台视频处理繁忙或空间额度不足；处理中断的任务请联系管理员处理", 429);
  const controller = new AbortController();
  const active = AbortSignal.any([signal, controller.signal]);
  const check = async () => {
    active.throwIfAborted();
    const policy = await backgroundMediaPolicy(cwd);
    if (policy === "none" || kind !== "plan" && policy !== "new") {
      controller.abort();
      invalid("后台视频处理准入已失效", 403);
    }
    if (!await databaseAccess(() => renewBackgroundBudget(database, lease))) {
      controller.abort();
      invalid("后台视频处理租约已失效", 409);
    }
  };
  const timer = setInterval(() => { void check().catch(() => controller.abort()); }, 30000);
  try {
    const result = await operation(operationId, active, check, lease, database);
    await check();
    if (!await databaseAccess(() => finishBackgroundBudget(database, lease, result.bytes))) invalid("后台资源状态已变化", 409);
    return result.value;
  } catch (cause) {
    // 无法证明发布目录不存在时保留完整预留，避免失败反复累积文件绕过配额。
    let cleaned = false;
    if (kind !== "plan" && clean) cleaned = await clean(operationId).catch(() => false);
    await databaseAccess(() => finishBackgroundBudget(database, lease, cleaned ? 0 : undefined)).catch(() => {});
    throw cause;
  } finally { clearInterval(timer); }
}

export async function planBackgroundJob(cwd: string, sourcePath: string, actor: AuthIdentity, signal: AbortSignal) {
  return withBudget(cwd, actor, "plan", signal, async (_id, active, check) => {
    await check();
    return { value: await withVideoSource(cwd, sourcePath, actor, active, path => inspectBackgroundVideo(path, active)) };
  });
}

export async function analyzeGuidedBackground(cwd: string, sourcePath: string, actor: AuthIdentity, signal: AbortSignal) {
  const folderFor = (id: string) => `assets/generated/guided${id.replaceAll("-", "")}`;
  return withBudget(cwd, actor, "frame", signal, async (id, active, check) =>
    withVideoSource(cwd, sourcePath, actor, active, async (path, sourceRevision) => {
      await check();
      const source = await inspectBackgroundVideo(path, active);
      const segments = planGuidedSegments(source, source.timestamps, true);
      const folder = folderFor(id);
      const directory = await resolveWorkspacePath(cwd, folder, true);
      await mkdir(directory.path, { recursive: true });
      let bytes = 0;
      try {
        const scenes = [];
        for (const [index, segment] of segments.entries()) {
          await check();
          const middle = Math.floor((segment.startSeconds + segment.endSeconds) * source.fps / 2) / source.fps;
          const frame = await createVideoFrame(path, Math.max(segment.startSeconds, middle - 0.00001), active, undefined, 480);
          const image = `${folder}/shot${index + 1}.png`;
          const target = await resolveWorkspacePath(cwd, image);
          bytes += frame.data.length;
          if (bytes > 8 * 1024 * 1024) invalid("分镜图片超过单次空间上限", 413);
          await writeWorkspaceFile(target.path, frame.data, true);
          scenes.push({ index: index + 1, start: segment.startSeconds, end: segment.endSeconds, image });
        }
        const manifest = `${folder}/analysis.json`;
        if (!sourceRevision.startsWith("sha256:") && await revision(path) !== sourceRevision) invalid("原视频在分析时已改变", 409);
        const result = { scenes, sourceRevision, duration: source.frameCount / source.fps, width: source.displayWidth, height: source.displayHeight, manifest };
        const content = JSON.stringify(result);
        await check();
        await writeWorkspaceFile((await resolveWorkspacePath(cwd, manifest)).path, content, true);
        return { value: result, bytes: bytes + Buffer.byteLength(content) };
      } catch (error) {
        await rm(directory.path, { recursive: true, force: true });
        throw error;
      }
    }), async id => {
    const folder = await resolveWorkspacePath(cwd, folderFor(id), true);
    return !await lstat(folder.path).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  });
}

export async function createBackgroundFrame(cwd: string, sourcePath: string, timeSeconds: number, actor: AuthIdentity, signal: AbortSignal) {
  return withBudget(cwd, actor, "frame", signal, async (operationId, active, check) => {
    await check();
    const frame = await withVideoSource(cwd, sourcePath, actor, active, path => createVideoFrame(path, timeSeconds, active, operationId));
    const output = await resolveWorkspacePath(cwd, "assets/generated", true);
    await mkdir(output.path, { recursive: true });
    const path = `assets/generated/frame${operationId.replaceAll("-", "")}.png`;
    const target = await resolveWorkspacePath(cwd, path);
    await check();
    await writeWorkspaceFile(target.path, frame.data, true);
    return { value: { path, mimeType: frame.mimeType, operationId }, bytes: frame.data.length };
  }, async operationId => {
    const target = await resolveWorkspacePath(cwd, `assets/generated/frame${operationId.replaceAll("-", "")}.png`, true);
    const temp = join(await realpath(tmpdir()), `toonflowVideoFrame${operationId.replaceAll("-", "")}`);
    const exists = (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    return !await exists(target.path) && !await exists(temp);
  });
}

export async function listOwnBackgroundReservations(cwd: string, actor: AuthIdentity, signal: AbortSignal) {
  return withBudget(cwd, actor, "plan", signal, async (_id, _active, check, lease, database) => {
    const reservations = await databaseAccess(() => listBackgroundReservations(database, lease));
    if (!reservations) invalid("资源预留状态已变化", 409);
    const result = [];
    for (const reservation of reservations) {
      if (reservation.kind === "trim") continue; // 裁剪预留及其分组不属于换背景任务。
      await check();
      const row = reservation.kind === "prepare" ? await databaseAccess(() => database.getBackgroundJob(access(cwd, reservation.operationId, actor))) : undefined;
      const stage = row ? payloadSchema.safeParse(row.payload) : undefined;
      result.push({ ...reservation, jobStage: stage?.success ? stage.data.stage : null,
        needsAdministrator: reservation.state !== "committed" || reservation.kind === "prepare" && !row });
    }
    return { value: result };
  });
}

export async function cleanupBackgroundFrame(cwd: string, operationId: string, actor: AuthIdentity, signal: AbortSignal) {
  z.uuid().parse(operationId);
  return withBudget(cwd, actor, "plan", signal, async (_id, _active, check, lease, database) => {
    const reservations = await databaseAccess(() => listBackgroundReservations(database, lease));
    if (!reservations) invalid("资源预留状态已变化", 409);
    const reservation = reservations.find(item => item.operationId === operationId);
    if (!reservation) return { value: { cleaned: true, removedBytes: 0, releasedBytes: 0 } };
    if (reservation.kind !== "frame" || reservation.state !== "committed") invalid("处理中断，需联系管理员处理", 409);
    // 工作区尚无完整引用索引，不能证明候选、长视频或其他节点不再使用该帧。
    await check();
    invalid("暂无法核实抽帧引用，请联系管理员确认后处理", 409);
  });
}

export async function prepareBackgroundJob(cwd: string, sourcePath: string, actor: AuthIdentity, signal: AbortSignal, jobId: string, guided?: { cuts: number[]; sourceRevision: string }) {
  const key = access(cwd, jobId, actor);
  const existing = await databaseAccess(async () => (await db()).getBackgroundJob(key));
  if (existing) {
    const payload = payloadSchema.parse(existing.payload);
    if (payload.sourcePath !== sourcePath) invalid("相同项目编号不能用于不同的视频", 409);
    if (Boolean(guided) !== Boolean(payload.timeline) || guided && payload.timeline && (guided.sourceRevision !== payload.sourceRevision
      || guided.cuts.length + 1 !== payload.parts.length || guided.cuts.some((cut, index) =>
        Math.round(cut * payload.timeline!.fps) !== Math.round(payload.parts[index]!.endSeconds * payload.timeline!.fps)))) invalid("项目编号与已保存的分镜不一致", 409);
    await verifySource(cwd, payload, actor, signal);
    return withBudget(cwd, actor, "plan", signal, async (_id, _active, check, lease, database) => {
      const reservations = await databaseAccess(() => listBackgroundReservations(database, lease));
      if (!reservations) invalid("资源预留状态已变化", 409);
      const reservation = reservations.find(item => item.operationId === jobId);
      if (!reservation || reservation.kind !== "prepare" || reservation.state !== "committed") invalid("准备状态尚未确认，请联系管理员处理", 409);
      if (payload.stage === "prepared") for (const part of payload.parts) {
        await check();
        if (await revision((await resolveWorkspacePath(cwd, part.path)).path) !== part.fileRevision) invalid("已准备的片段已变化，请联系管理员处理", 409);
      }
      return { value: { jobId, ...payload } };
    });
  }
  return withBudget(cwd, actor, "prepare", signal, async (jobId, active, check) => {
  return withVideoSource(cwd, sourcePath, actor, active, async (sourceFile, initial) => {
  await check();
  if (guided && guided.sourceRevision !== initial) invalid("原视频已改变，请重新分析原片", 409);
  const plan = await inspectBackgroundVideo(sourceFile, active, !guided);
  const segments = guided ? planGuidedSegments(plan, guided.cuts) : plan.segments;
  const timeline = guided ? timelineSchema.parse({ fps: plan.fps, frameRate: plan.frameRate, frameCount: plan.frameCount }) : undefined;
  const files = await splitBackgroundVideo(cwd, sourceFile, jobId, segments, active, check, timeline);
  if (!initial.startsWith("sha256:") && await revision(sourceFile) !== initial) invalid("原视频在切分过程中改变，请重新准备", 409);
  const parts: Payload["parts"] = [];
  for (const file of files) {
    const taskId = randomUUID(), leaseId = randomUUID();
    if (!await createMediaLease(cwd, leaseId, taskId, actor)) invalid("媒体任务租约冲突，请重新准备", 409);
    parts.push({ ...file, fileRevision: await revision((await resolveWorkspacePath(cwd, file.path)).path), taskId, leaseId, state: "pending" });
  }
  const payload: Payload = { version: 1, sourcePath, sourceRevision: initial, duration: timeline ? timeline.frameCount / timeline.fps : plan.duration, stage: "prepared", parts, ...(timeline ? { timeline } : {}) };
  await check();
  if (!await databaseAccess(async () => (await db()).createBackgroundJob({ ...key, payload }))) invalid("项目编号冲突，请重新准备", 409);
  // 完整预留持续覆盖后续生成片段、失败残留及最终合成，清理后再对账。
  return { value: { jobId, ...payload }, bytes: 512 * 1024 * 1024 };
  });
  }, async operationId => {
    const target = await resolveWorkspacePath(cwd, `assets/generated/background${operationId.replaceAll("-", "")}`, true);
    const temp = join(await realpath(tmpdir()), `toonflowBackground${operationId.replaceAll("-", "")}`);
    const exists = (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    return !await exists(target.path) && !await exists(temp);
  }, jobId);
}

async function leased<T>(cwd: string, jobId: string, actor: AuthIdentity, operation: (context: {
  payload: Payload; save(): Promise<void>; key: Access;
}) => Promise<T>) {
  const database = await db();
  const key = access(cwd, jobId, actor);
  const leaseOwner = randomUUID();
  if (!await databaseAccess(() => database.acquireBackgroundJobLease({ ...key, leaseOwner, ttlMs: 3600000 }))) invalid("任务不存在或正在处理", 409);
  const row = await databaseAccess(() => database.getBackgroundJob(key));
  if (!row || row.leaseOwner !== leaseOwner) invalid("任务租约无效", 409);
  let version = row.revision;
  const generation = row.leaseGeneration;
  const payload = payloadSchema.parse(row.payload);
  const save = async () => {
    if (!await databaseAccess(() => database.updateBackgroundJob({ ...key, leaseOwner, generation, expectedRevision: version, payload: payloadSchema.parse(payload) }))) {
      invalid("任务状态已变化，请重新读取", 409);
    }
    version++;
  };
  try { return await operation({ payload, save, key }); }
  finally { await databaseAccess(() => database.releaseBackgroundJobLease({ ...key, leaseOwner, generation })); }
}

export async function confirmBackgroundJob(cwd: string, jobId: string, actor: AuthIdentity,
  options: { image: z.infer<typeof backgroundImageSchema>; modelId: string; prompt: string; shots?: Omit<z.infer<typeof shotGuidanceSchema>, "revision">[] }) {
  return leased(cwd, jobId, actor, async ({ payload, save }) => {
    if (payload.stage !== "prepared") invalid("该项目已确认，不能更换模型或背景", 409);
    await verifySource(cwd, payload, actor, AbortSignal.timeout(30000));
    await withBudget(cwd, actor, "plan", AbortSignal.timeout(30000), async (_id, _active, _check, lease, database) => {
      const reservations = await databaseAccess(() => listBackgroundReservations(database, lease));
      const reservation = reservations?.find(item => item.operationId === jobId);
      if (!reservation || reservation.kind !== "prepare" || reservation.state !== "committed") invalid("准备状态尚未确认，请联系管理员处理", 409);
      return { value: true };
    });
    const image = await resolveWorkspacePath(cwd, options.image.path);
    if (!(await lstat(image.path)).isFile()) invalid("请选择工作区中的背景图片");
    const catalog = await modelGateway.catalog(["video"]);
    const selected = catalog.find(model => model.modelId === options.modelId || model.routeId === options.modelId);
    const mode = selected?.mode?.find(value => Array.isArray(value) && value.some(item => /^imageReference:[1-9]/.test(item))
      && value.some(item => /^videoReference:[1-9]/.test(item)));
    if (!Array.isArray(mode)) invalid("所选模型不支持同时参考视频和图片", 400);
    if (payload.timeline ? options.shots?.length !== payload.parts.length : options.shots !== undefined) invalid("逐镜头方案与准备的分段不一致");
    if (options.shots) {
      const revisions = new Map<string, string>();
      payload.shots = [];
      for (const shot of options.shots) {
        let imageRevision = revisions.get(shot.image.path);
        if (!imageRevision) {
          const file = await resolveWorkspacePath(cwd, shot.image.path);
          if (!(await lstat(file.path)).isFile()) invalid("请选择工作区中的背景图片");
          imageRevision = await revision(file.path);
          revisions.set(shot.image.path, imageRevision);
        }
        payload.shots.push({ ...shot, revision: imageRevision });
      }
    }
    payload.image = options.image;
    payload.imageRevision = await revision(image.path);
    payload.modelId = options.modelId;
    payload.mode = mode;
    payload.prompt = options.prompt;
    payload.stage = "confirmed";
    await save();
    return { jobId, ...payload };
  });
}

export async function readBackgroundJob(cwd: string, jobId: string, actor: AuthIdentity) {
  const row = await databaseAccess(async () => (await db()).getBackgroundJob(access(cwd, jobId, actor)));
  if (!row) invalid("任务不存在", 404);
  return { jobId, ...payloadSchema.parse(row.payload) };
}

export async function advanceBackgroundJob(cwd: string, jobId: string, actor: AuthIdentity, resume: boolean, allowNew = true) {
  return leased(cwd, jobId, actor, async ({ payload, save }) => {
    if (payload.stage !== "confirmed" || !payload.image || !payload.imageRevision || !payload.modelId || !payload.mode || !payload.prompt) return { jobId, ...payload };
    const imageFile = await resolveWorkspacePath(cwd, payload.image.path);
    if (await revision(imageFile.path) !== payload.imageRevision) invalid("所选背景已变化，请重新准备项目", 409);
    await verifySource(cwd, payload, actor, AbortSignal.timeout(30000));
    for (const [index, part] of payload.parts.entries()) {
      if (part.state === "pending") {
        if (!allowNew) break;
        if (await jobBytes(cwd, jobId) > 312 * 1024 * 1024) invalid("剩余空间不足以安全生成下一段并合成", 413);
        if (await revision((await resolveWorkspacePath(cwd, part.path)).path) !== part.fileRevision) invalid("视频片段已变化，请重新准备项目", 409);
        const shot = payload.shots?.[index];
        if (shot && await revision((await resolveWorkspacePath(cwd, shot.image.path)).path) !== shot.revision) invalid("所选背景已变化，请重新准备项目", 409);
        // ACT: 提交前先落库不确定状态；进程失联后若任务不存在，不能自动再发上游。
        part.state = "submitting";
        await save();
        try {
          const requestedDuration = payload.timeline ? part.endSeconds - part.startSeconds : part.duration;
          await mediaTasks.start(cwd, part.taskId, "video", { providerId: "multiTenant", modelId: payload.modelId,
            prompt: shot?.prompt ?? payload.prompt, videos: [{ path: part.path, mimeType: part.mimeType }], images: [shot?.image ?? payload.image],
            duration: Math.max(2, Math.min(15, Math.ceil(requestedDuration - 1e-8))), mode: payload.mode as (`${"video" | "image" | "audio"}Reference:${number}`)[],
            outputDirectory: `${jobFolder(jobId)}/outputs` }, { executionLeaseId: part.leaseId }, actor);
          part.state = "submitted";
        } catch { part.state = "unknown"; }
        await save();
      }
      if (!["submitted", "submitting", "unknown"].includes(part.state)) continue;
      const leaseResult = await readMediaLease(cwd, part.leaseId, part.taskId, actor.id);
      if (leaseResult?.state === "succeeded") {
        const files = z.array(z.strictObject({ path: z.string().min(1), mimeType: z.string().min(1), mediaType: z.literal("video") })).length(1).parse(leaseResult.files);
        part.state = "succeeded";
        part.resultPath = files[0]!.path;
        part.resultRevision = await revision((await resolveWorkspacePath(cwd, part.resultPath)).path);
        await save();
        continue;
      }
      const current = (await mediaTasks.status(cwd, [part.taskId], resume, actor, !allowNew))[0];
      if (!current || current.result?.code === 404) { part.state = "unknown"; await save(); break; }
      if (current.state === "succeeded") part.state = "unknown";
      else if (["failed", "cancelled"].includes(current.state)) part.state = "failed";
      else if (current.state === "interrupted" && !current.resumable) part.state = "unknown";
      else part.state = "submitted";
      await save();
      if (part.state === "unknown" || part.state === "failed") break;
      if (part.state === "submitted" || part.state === "submitting") break;
    }
    return { jobId, ...payload };
  });
}

export async function retryGuidedBackgroundPart(cwd: string, jobId: string, actor: AuthIdentity, partIndex: number, requestId: string) {
  return leased(cwd, jobId, actor, async ({ payload, save }) => {
    const part = payload.parts[partIndex];
    if (!payload.timeline || !payload.shots || !part || !["confirmed", "completed"].includes(payload.stage)) invalid("找不到可重做的片段", 409);
    if (part.retryIds?.includes(requestId)) return { jobId, ...payload };
    if ((part.retryIds?.length ?? 0) >= 32) invalid("此片段已达到重做次数上限", 409);
    if (part.state !== "failed" && part.state !== "succeeded") invalid("片段的供应商状态尚未确认，不能重发", 409);
    await verifySource(cwd, payload, actor, AbortSignal.timeout(30000));
    const taskId = randomUUID();
    const leaseId = randomUUID();
    if (!await createMediaLease(cwd, leaseId, taskId, actor)) invalid("片段任务租约冲突", 409);
    part.taskId = taskId;
    part.leaseId = leaseId;
    part.retryIds = [...(part.retryIds ?? []), requestId];
    part.state = "pending";
    delete part.resultPath;
    delete part.resultRevision;
    payload.stage = "confirmed";
    delete payload.resultPath;
    await save();
    return { jobId, ...payload };
  });
}

export async function finishBackgroundJob(cwd: string, jobId: string, actor: AuthIdentity, signal: AbortSignal) {
  return leased(cwd, jobId, actor, async ({ payload, save }) => {
    if (payload.stage === "completed") return { jobId, ...payload };
    if (payload.stage !== "confirmed" || payload.parts.some(part => part.state !== "succeeded" || !part.resultPath || !part.resultRevision)) invalid("所有片段成功后才能合成", 409);
    for (const part of payload.parts) {
      if (await revision((await resolveWorkspacePath(cwd, part.resultPath!)).path) !== part.resultRevision) invalid("生成片段已变化，无法安全合成", 409);
    }
    const remaining = 512 * 1024 * 1024 - await jobBytes(cwd, jobId);
    return withBudget(cwd, actor, "plan", signal, async (_operationId, active, check) => {
      await check();
      const result = await withVideoSource(cwd, payload.sourcePath, actor, active, async (original, version) => {
        if (version !== payload.sourceRevision) invalid("原视频已改变，请重新准备项目", 409);
        const merged = await mergeBackgroundVideo(cwd, original, payload.parts.map(part => part.resultPath!), randomUUID(), active,
          payload.parts.map(part => part.endSeconds - part.startSeconds), jobFolder(jobId), remaining, payload.timeline);
        if (payload.timeline && !version.startsWith("sha256:") && await revision(original) !== version) invalid("原视频在合成时改变，无法交付该结果", 409);
        return merged;
      });
      await check();
      payload.resultPath = result.path;
      payload.stage = "completed";
      await save();
      return { value: { jobId, ...payload } };
    });
  });
}

export async function cancelBackgroundJob(cwd: string, jobId: string, actor: AuthIdentity) {
  return leased(cwd, jobId, actor, async ({ payload, save }) => {
    if (payload.stage === "completed" || payload.stage === "cancelled") return { jobId, ...payload };
    payload.stage = "cancelling";
    await save();
    for (const part of payload.parts) {
      if (["succeeded", "failed", "cancelled"].includes(part.state)) continue;
      if (part.state === "pending") { part.state = "cancelled"; await save(); continue; }
      // 尚无法确认提交结果时不能制造取消记录，也不能假定上游已取消。
      if (["submitting", "unknown"].includes(part.state)) continue;
      try { await mediaTasks.cancel(cwd, [part.taskId], actor); part.state = "cancelled"; }
      catch { /* 另一实例持有租约时保留 cancelling，稍后重查。 */ }
      await save();
    }
    if (payload.parts.every(part => ["succeeded", "failed", "cancelled"].includes(part.state))) { payload.stage = "cancelled"; await save(); }
    return { jobId, ...payload };
  });
}

// 用户确认后只清理中间产物；最终视频保留原路径。曾失租接管的任务保守拒绝回收。
export async function cleanupPreparedBackgroundJob(cwd: string, jobId: string, actor: AuthIdentity, signal: AbortSignal) {
  return leased(cwd, jobId, actor, async ({ payload, save }) => {
    if (!["prepared", "completed", "cleaned"].includes(payload.stage)) invalid("运行中或状态不明的任务暂不能自动清理", 409);
    const finished = payload.stage === "completed";
    if (payload.stage === "prepared" && payload.parts.some(part => part.state !== "pending")) invalid("任务曾进入执行阶段，暂不能自动清理", 409);
    if (finished && (!payload.resultPath || payload.parts.some(part => part.state !== "succeeded" || !part.resultPath))) invalid("任务结果不完整，不能自动清理", 409);
    return withBudget(cwd, actor, "plan", signal, async (_operationId, active, check, lease, database) => {
      const reservationsBeforeCleanup = await databaseAccess(() => listBackgroundReservations(database, lease));
      if (!reservationsBeforeCleanup) invalid("资源预留状态已变化", 409);
      assertPreparedCleanupReservation(reservationsBeforeCleanup, jobId);
      let removedBytes = 0;
      const mediaLeases: MediaLease[] = [];
      try {
      if (finished) {
        for (const part of payload.parts) {
          const held = await acquireMediaLease(cwd, part.leaseId, part.taskId, actor.id);
          if (!held) invalid("任务执行尚未停止，请稍后重试", 409);
          mediaLeases.push(held);
          const result = await readMediaLease(cwd, part.leaseId, part.taskId, actor.id);
          if (result?.state !== "succeeded" || result.takeoverObserved !== false || typeof result.executionGeneration !== "number"
            || result.executionGeneration !== result.checkpointGeneration) invalid("任务曾发生接管或缺少执行证明，需受控核查后清理", 409);
        }
      }
      if (payload.stage === "prepared" || finished) {
        const directory = await resolveWorkspacePath(cwd, jobFolder(jobId), true);
        const info = await lstat(directory.path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        if (info) {
          if (!info.isDirectory() || info.isSymbolicLink()) invalid("任务目录无效，不能自动清理", 409);
          const allowed = new Map(payload.parts.map(part => [part.path.split("/").at(-1)!, part.path]));
          const finalName = finished ? payload.resultPath!.split("/").at(-1) : undefined;
          if (finished && payload.resultPath !== `${jobFolder(jobId)}/${finalName}`) invalid("最终视频路径无效", 409);
          const entries = await readdir(directory.path, { withFileTypes: true });
          if (entries.some(entry => entry.isSymbolicLink() || !(entry.isFile() && (allowed.has(entry.name) || entry.name === finalName)
            || finished && entry.isDirectory() && entry.name === "outputs"))) invalid("任务目录含有额外文件，不能自动清理", 409);
          const renew = async () => {
            await check();
            for (const held of mediaLeases) if (!await renewMediaLease(held)) invalid("媒体任务租约已失效", 409);
          };
          const outputNames = new Set(payload.parts.map(part => part.resultPath?.split("/").at(-1)).filter((name): name is string => !!name));
          for (const entry of entries) {
            active.throwIfAborted();
            await renew();
            if (entry.name === finalName) continue;
            if (entry.name === "outputs") {
              const outputs = await resolveWorkspacePath(cwd, `${jobFolder(jobId)}/outputs`);
              const children = await readdir(outputs.path, { withFileTypes: true });
              if (children.some(child => !child.isFile() || child.isSymbolicLink() || !outputNames.has(child.name))) invalid("任务输出含有额外文件，不能自动清理", 409);
              for (const child of children) {
                await renew();
                const target = await resolveWorkspacePath(cwd, `${jobFolder(jobId)}/outputs/${child.name}`);
                const file = await lstat(target.path);
                if (!file.isFile() || file.isSymbolicLink()) invalid("任务文件已变化，不能自动清理", 409);
                removedBytes += file.size;
                await unlink(target.path);
              }
              await rmdir(outputs.path);
            } else {
              const target = await resolveWorkspacePath(cwd, allowed.get(entry.name)!);
              const file = await lstat(target.path);
              if (!file.isFile() || file.isSymbolicLink()) invalid("任务文件已变化，不能自动清理", 409);
              removedBytes += file.size;
              await unlink(target.path);
            }
          }
          await check();
          if (!finished) await rmdir(directory.path);
        }
        payload.stage = "cleaned";
        await save();
      }
      await check();
      let remainingBytes = 0;
      if (payload.resultPath) {
        const final = await resolveWorkspacePath(cwd, payload.resultPath);
        const info = await lstat(final.path);
        if (!info.isFile() || info.isSymbolicLink()) invalid("最终视频不存在或已变化", 409);
        remainingBytes = info.size;
      }
      const reservations = await databaseAccess(() => listBackgroundReservations(database, lease));
      if (!reservations) invalid("资源预留状态已变化", 409);
      const previous = reservations.find(item => item.operationId === jobId);
      if (previous && remainingBytes > previous.bytes) invalid("最终视频超过预留空间，无法自动对账", 409);
      const released = previous ? await databaseAccess(() => reconcileBackgroundReservation(database, lease, jobId, remainingBytes)) : false;
      if (previous && !released) invalid("资源预留状态已变化", 409);
      await check();
      return { value: { cleaned: true, removedBytes, releasedBytes: released ? previous!.bytes - remainingBytes : 0, remainingBytes } };
      } finally { for (const held of mediaLeases) await releaseMediaLease(held).catch(() => {}); }
    });
  });
}
