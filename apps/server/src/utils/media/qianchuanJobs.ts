import { createHash } from "node:crypto";
import { join } from "node:path";
import { lstat, mkdir, readFile, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import { qianchuanUserIdSchema, resolveQianchuanAccount } from "@/utils/multiTenant/qianchuanOrganizations";
import { isWithin, resolveWorkspacePath } from "@/utils/workspace/files";
import { uploadQianchuanVideo } from "./qianchuanProvider";

export const qianchuanJobRequest = {
  directory: z.string().min(1).max(4096),
  jobId: z.uuid(),
  organizationId: z.uuid(),
  accountId: z.uuid(),
};
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
  organizationId: z.uuid(),
  accountId: z.uuid(),
  teamId: z.uuid().nullable(),
  userId: qianchuanUserIdSchema,
  createdAt: z.iso.datetime(),
  items: z.array(storedItem).min(1).max(100),
});
const receiptSchema = z.strictObject({
  state: z.enum(["uploading", "unknown", "succeeded", "failed"]),
  ...outcomeFields,
});
type VideoItem = z.infer<typeof itemSchema>;
type Job = z.infer<typeof storedJob>;
type Item = Job["items"][number];
type Actor = { id: string };
type Selection = { organizationId: string; accountId: string };
type Scope = {
  cwd: string;
  path: string;
  receiptDirectory: string;
  advertiserId: string;
  teamId: string | null;
  userId: string;
  selection: Selection;
};

const active = new Set<string>();
let queue: Promise<void> = Promise.resolve();
const maxVideoBytes = 100 * 1024 * 1024;

function error(message: string, status: number): never {
  throw Object.assign(new Error(message), { status });
}

async function scopeFor(cwd: string, jobId: string, actor: Actor, selection: Selection): Promise<Scope> {
  const root = process.env.TOONFLOW_DATA_DIR;
  if (!root) error("服务器尚未配置任务存储", 503);
  const { advertiserId, teamId } = await resolveQianchuanAccount(actor.id, selection.organizationId, selection.accountId);
  const store = join(root, "qianchuanUploads");
  const key = createHash("sha256")
    .update(JSON.stringify([cwd, actor.id, selection.organizationId, selection.accountId]))
    .digest("hex");
  const directory = join(store, "jobs", key);
  await mkdir(directory, { recursive: true });
  return {
    cwd,
    userId: actor.id,
    selection,
    advertiserId,
    teamId,
    path: join(directory, `${jobId}.json`),
    receiptDirectory: join(store, "receipts", selection.organizationId, advertiserId),
  };
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
  if (job.advertiserId !== scope.advertiserId) error("此任务的千川账户配置已变更", 409);
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
  const { jobId, advertiserId, items } = job;
  return { jobId, advertiserId, items: items.map(({ revision: _revision, signature: _signature, retryApproved: _retryApproved, ...item }) => item) };
}

function receiptPath(scope: Scope, signature: string) {
  return join(scope.receiptDirectory, `${signature}.json`);
}

async function uploadOne(scope: Scope, token: string, item: Item, video: Awaited<ReturnType<typeof getVideo>>) {
  await mkdir(scope.receiptDirectory, { recursive: true });
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
  const result = await uploadQianchuanVideo({ token, advertiserId: scope.advertiserId, name: item.name, ...video });
  await save(path, result);
  return result;
}

async function run(scope: Scope) {
  const job = await getJob(scope);
  for (const item of job.items) {
    if (item.state === "uploading") {
      const raw = item.signature ? await readOptional(receiptPath(scope, item.signature)) : undefined;
      const receipt = raw ? receiptSchema.parse(raw) : undefined;
      if (receipt && receipt.state !== "uploading") Object.assign(item, receipt);
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
    let authorization: Awaited<ReturnType<typeof resolveQianchuanAccount>>;
    try {
      authorization = await resolveQianchuanAccount(scope.userId, scope.selection.organizationId, scope.selection.accountId);
      if (authorization.advertiserId !== scope.advertiserId) error("千川账户已变更", 409);
    } catch (cause) {
      const status = cause && typeof cause === "object" && "status" in cause ? cause.status : undefined;
      if (status !== 403 && status !== 404 && status !== 409) throw cause;
      Object.assign(item, { state: "failed", error: "上传授权已撤销或账户已变更" });
      await save(scope.path, job);
      continue;
    }
    item.state = "uploading";
    item.signature = video.signature;
    await save(scope.path, job);
    try {
      Object.assign(item, await uploadOne(scope, authorization.token, item, video));
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

export async function startQianchuanJob(cwd: string, actor: Actor, jobId: string, selection: Selection, items: VideoItem[]) {
  const scope = await scopeFor(cwd, jobId, actor, selection);
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
  const job: Job = {
    jobId,
    advertiserId: scope.advertiserId,
    ...selection,
    teamId: scope.teamId,
    userId: actor.id,
    createdAt: new Date().toISOString(),
    items: snapshot,
  };
  try {
    await save(scope.path, job, true);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    return reopen();
  }
  enqueue(scope, job);
  return visible(job);
}

export async function readQianchuanJob(cwd: string, actor: Actor, jobId: string, selection: Selection) {
  const scope = await scopeFor(cwd, jobId, actor, selection);
  const job = await getJob(scope);
  enqueue(scope, job);
  return visible(job);
}

export async function retryQianchuanJob(cwd: string, actor: Actor, jobId: string, selection: Selection) {
  const scope = await scopeFor(cwd, jobId, actor, selection);
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
