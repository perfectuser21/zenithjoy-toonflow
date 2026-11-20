import { createHash } from "node:crypto";
import { join } from "node:path";
import { lstat, mkdir, readFile, writeAtomic } from "@toonflow/file";
import type { AuthIdentity } from "@toonflow/multi-tenant-auth";
import { z } from "zod";
import { isWithin, resolveWorkspacePath } from "@/utils/workspace/files";
import { uploadQianchuanVideo } from "./qianchuanProvider";

export const qianchuanJobRequest = { directory: z.string().min(1).max(4096), jobId: z.uuid() };
export const qianchuanAdvertiser = z.string().regex(/^\d{1,20}$/);
const itemSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(180)
    .regex(/^[^/\\\x00-\x1f]+$/),
  url: z.string().trim().min(1).max(4096),
  mimeType: z.literal("video/mp4"),
});
export const qianchuanBatchItems = z.array(itemSchema).min(1).max(100);
const itemState = z.enum(["pending", "uploading", "succeeded", "failed", "unknown"]);
const outcomeFields = { materialId: z.string().optional(), videoId: z.string().optional(), error: z.string().optional() };
const storedItem = itemSchema.extend({
  state: itemState,
  revision: z.string().nullable(),
  signature: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  retryApproved: z.boolean().optional(),
  ...outcomeFields,
});
const storedJob = z.strictObject({
  jobId: z.uuid(),
  advertiserId: qianchuanAdvertiser,
  items: z.array(storedItem).min(1).max(100),
});
const receiptSchema = z.strictObject({
  state: z.enum(["uploading", "unknown", "succeeded", "failed"]),
  ...outcomeFields,
});
type VideoItem = z.infer<typeof itemSchema>;
type Job = z.infer<typeof storedJob>;
type Item = Job["items"][number];
type Config = { advertiserId: string; token: string; store: string };
type Scope = { cwd: string; path: string; config: Config };

const active = new Set<string>();
let queue: Promise<void> = Promise.resolve();
const maxVideoBytes = 100 * 1024 * 1024;

function error(message: string, status: number): never {
  throw Object.assign(new Error(message), { status });
}

function configuration(actor: AuthIdentity): Config {
  const ownerId = process.env.TOONFLOW_QIANCHUAN_OWNER_ID?.trim();
  const token = process.env.TOONFLOW_QIANCHUAN_ACCESS_TOKEN?.trim();
  const advertiserId = qianchuanAdvertiser.safeParse(process.env.TOONFLOW_QIANCHUAN_ADVERTISER_ID?.trim());
  const directory = process.env.TOONFLOW_DATA_DIR;
  if (!ownerId || !token || !advertiserId.success || !directory) error("服务器尚未配置千川上传账户", 503);
  if (actor.id !== ownerId) error("该用户没有配置此千川账户的上传权限", 403);
  return { advertiserId: advertiserId.data, token, store: join(directory, "qianchuanUploads") };
}

async function scopeFor(cwd: string, jobId: string, actor: AuthIdentity): Promise<Scope> {
  const config = configuration(actor);
  const key = createHash("sha256")
    .update(JSON.stringify([cwd, actor.id]))
    .digest("hex");
  const directory = join(config.store, "jobs", key);
  await mkdir(directory, { recursive: true });
  return { cwd, config, path: join(directory, `${jobId}.json`) };
}

async function readOptional(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function getJob(scope: Scope) {
  const raw = await readOptional(scope.path);
  if (!raw) error("千川上传任务不存在", 404);
  const job = storedJob.parse(raw);
  if (job.advertiserId !== scope.config.advertiserId) error("此任务的千川账户配置已变更", 409);
  return job;
}

function save(path: string, value: unknown, exclusive = false) {
  return writeAtomic(path, JSON.stringify(value), { exclusive, mode: 0o600 });
}

async function locateVideo(scope: Scope, item: VideoItem) {
  const path = (await resolveWorkspacePath(scope.cwd, item.url)).path;
  const assets = join(scope.cwd, "assets");
  if (!isWithin(assets, path) || path === assets || !path.endsWith(".mp4")) error("只能上传当前工作区内的 MP4 成片", 400);
  const info = await lstat(path);
  if (!info.isFile() || !info.size || info.size > maxVideoBytes) error("请选择不超过 100 MB 的非空 MP4 成片", 400);
  return { path, revision: `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` };
}

async function getVideo(scope: Scope, item: Item) {
  const expected = await locateVideo(scope, item);
  if (expected.revision !== item.revision) error("成片已更改，请重新提交整批清单", 409);
  const bytes = await readFile(expected.path);
  const actual = await locateVideo(scope, item);
  if (actual.path !== expected.path || actual.revision !== expected.revision) error("读取时成片已发生变化", 409);
  if (!bytes.length || bytes.length > maxVideoBytes || bytes.toString("ascii", 4, 8) !== "ftyp") error("成片不是有效的 MP4 文件", 400);
  const signature = createHash("md5").update(bytes).digest("hex");
  return { file: new Blob([new Uint8Array(bytes)], { type: "video/mp4" }), signature };
}

function visible(job: Job) {
  return { ...job, items: job.items.map(({ revision: _revision, signature: _signature, retryApproved: _retryApproved, ...item }) => item) };
}

function receiptPath(scope: Scope, signature: string) {
  return join(scope.config.store, "receipts", scope.config.advertiserId, `${signature}.json`);
}

async function uploadOne(scope: Scope, item: Item, video: Awaited<ReturnType<typeof getVideo>>) {
  const directory = join(scope.config.store, "receipts", scope.config.advertiserId);
  await mkdir(directory, { recursive: true });
  const path = receiptPath(scope, video.signature);
  const previous = await readOptional(path);
  if (previous) {
    const receipt = receiptSchema.parse(previous);
    if (receipt.state === "succeeded" || receipt.state === "unknown" || (receipt.state === "failed" && !item.retryApproved)) return receipt;
    if (receipt.state === "uploading") return { state: "unknown" as const, error: "相同素材已有未确认的上传，请先核对千川素材库" };
  }
  try {
    await save(path, { state: "uploading" }, previous === undefined);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    return { state: "unknown" as const, error: "相同素材正在上传，请先核对千川素材库" };
  }
  const result = await uploadQianchuanVideo({ token: scope.config.token, advertiserId: scope.config.advertiserId, name: item.name, ...video });
  await save(path, result);
  return result;
}

async function run(scope: Scope) {
  const job = await getJob(scope);
  for (const item of job.items) {
    if (item.state === "uploading") {
      const raw = item.signature ? await readOptional(receiptPath(scope, item.signature)) : undefined;
      const receipt = raw ? receiptSchema.parse(raw) : undefined;
      if (receipt?.state === "succeeded") Object.assign(item, receipt);
      else Object.assign(item, { state: "unknown", error: "服务中断前已开始上传，请先核对千川素材库" });
      await save(scope.path, job);
      continue;
    }
    if (item.state !== "pending") continue;
    let video: Awaited<ReturnType<typeof getVideo>>;
    try {
      video = await getVideo(scope, item);
    } catch (cause) {
      const reason =
        cause instanceof Error && ["成片已更改，请重新提交整批清单", "读取时成片已发生变化"].includes(cause.message)
          ? cause.message
          : "工作区成片不可读或不符合 MP4 上传要求";
      Object.assign(item, { state: "failed", error: reason });
      await save(scope.path, job);
      continue;
    }
    item.state = "uploading";
    item.signature = video.signature;
    await save(scope.path, job);
    try {
      Object.assign(item, await uploadOne(scope, item, video));
    } catch {
      Object.assign(item, { state: "unknown", error: "上传结果未确认，请先核对千川素材库" });
    }
    delete item.retryApproved;
    await save(scope.path, job);
  }
}

function enqueue(scope: Scope, job: Job) {
  if (active.has(scope.path) || !job.items.some((item) => item.state === "pending" || item.state === "uploading")) return;
  active.add(scope.path);
  queue = queue
    .then(() => run(scope))
    .catch(() => {
      console.warn("千川后台上传任务推进失败，保留已保存状态");
    })
    .finally(() => {
      active.delete(scope.path);
    });
}

export async function startQianchuanJob(cwd: string, actor: AuthIdentity, jobId: string, advertiserId: string, items: VideoItem[]) {
  const scope = await scopeFor(cwd, jobId, actor);
  if (advertiserId !== scope.config.advertiserId) error("所选账户和服务器配置的千川账户不一致", 403);
  if (new Set(items.map((x) => x.url)).size !== items.length) error("成片清单中有重复路径", 400);
  async function reopen() {
    const existing = await getJob(scope);
    const files = existing.items.map(({ name, url, mimeType }) => ({ name, url, mimeType }));
    if (JSON.stringify(files) !== JSON.stringify(items)) error("同一任务编号对应了不同成片清单", 409);
    enqueue(scope, existing);
    return visible(existing);
  }
  if (await readOptional(scope.path)) return reopen();
  const snapshot: Item[] = [];
  for (const item of items) {
    const location = await locateVideo(scope, item).catch(() => undefined);
    snapshot.push({ ...item, revision: location?.revision ?? null, state: "pending" });
  }
  const job: Job = { jobId, advertiserId, items: snapshot };
  try {
    await save(scope.path, job, true);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    return reopen();
  }
  enqueue(scope, job);
  return visible(job);
}

export async function readQianchuanJob(cwd: string, actor: AuthIdentity, jobId: string) {
  const scope = await scopeFor(cwd, jobId, actor);
  const job = await getJob(scope);
  enqueue(scope, job);
  return visible(job);
}

export async function retryQianchuanJob(cwd: string, actor: AuthIdentity, jobId: string) {
  const scope = await scopeFor(cwd, jobId, actor);
  if (active.has(scope.path)) error("上传任务仍在进行", 409);
  active.add(scope.path);
  let job: Job;
  try {
    job = await getJob(scope);
    for (const item of job.items) {
      if (item.state !== "failed") continue;
      item.state = "pending";
      item.retryApproved = true;
      delete item.error;
    }
    await save(scope.path, job);
  } finally {
    active.delete(scope.path);
  }
  enqueue(scope, job);
  return visible(job);
}
