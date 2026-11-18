import { t, translateMessage } from "@/lib/i18n";
import { createReadStream, mkdir, open, readFile, readlink, realpath, stat, statfs, unlink } from "@toonflow/file";
import { join, relative } from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { mediaProviders, type Provider, type ProviderTaskData } from "@toonflow/providers";
import type { GeneratedMedia, MediaGenerationRequest, MediaModel, MediaReference } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";
import { getAccountProvider } from "@/utils/ai/provider";
import { getMediaProvider, listMediaProviders, loadMediaProviderSource } from "@/utils/media/provider";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { beginGeneration, getProviderPrice } from "@/utils/media/billing";
import { detectMimeType, readPriceReference } from "@/utils/media/priceReference";
import type { ModelActor } from "@toonflow/multi-tenant-gateway/types";
import { currentIdentity } from "@/utils/multiTenant/context";
import { modelGateway } from "@/utils/multiTenant/gateway";
import { downloadPublicFile } from "@/utils/workspace/download";
import { prepareWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { assertWanReferenceDuration, parseWanProbeDuration } from "@/utils/media/wanDuration";
import { assertActiveTrimOwner, listTrimRecoveries, withManagedTrim } from "@/utils/media/trimVideo";
import { assertReferenceHash, assertSingleManagedReference, assertVideoHashes, assertWanReferenceMeta, guardedTrimUploadFetch, useUploadedTrim } from "@/utils/media/uploadedTrim";
import { aliyunUploadSourceSha256 } from "@/utils/media/aliyunTrustedVersion";

const maxMediaSize = 100 * 1024 * 1024;
let activeVideoInspections = 0;
export type MediaGenerationCheckpoint = {
  providerData?: ProviderTaskData;
  assets?: Extract<MediaAsset, { type: "url" }>[];
  assetCount?: number;
  files?: (GeneratedMedia & { index: number; hash: string })[];
};

type MediaGenerationTask = {
  taskId: string;
  resume: boolean;
  checkpoint: MediaGenerationCheckpoint;
  modelRouteCipher?: string;
  actor?: ModelActor;
  legacyTaskOwnerId?: string;
  outputGeneration?: number;
  beforeSubmit?: () => Promise<void>;
  beforeNetwork?: () => Promise<void>;
  onWanSubmit?: () => void;
  onProviderResult?: () => void;
  save: (patch: Partial<MediaGenerationCheckpoint>) => Promise<void>;
};
const notSubmittedFailures = new WeakSet<object>();

export function isMediaNotSubmitted(cause: unknown) {
  return !!cause && typeof cause === "object" && notSubmittedFailures.has(cause);
}
const mediaExtensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm",
  "audio/flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a", "audio/opus": "opus", "audio/pcm": "pcm",
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

// 万相限制的是参考视频总时长，与输出时长参数无关。
export async function validateWanVideoReferences(cwd: string, request: MediaGenerationRequest,
  actor?: ModelActor, modelRouteCipher?: string, signal?: AbortSignal, legacyTaskOwnerId?: string) {
  if (!request.videos?.length) return;
  let providerId = request.providerId, modelId = request.modelId;
  if (modelRouteCipher) {
    if (!actor) invalid("缺少模型请求身份");
    const execution = await modelGateway.resolve("video", providerId, modelId, modelRouteCipher, request, { actor, legacyTaskOwnerId });
    if (execution.route.target !== "backend") return;
    providerId = execution.route.providerId;
    modelId = execution.upstream.upstreamModelId;
  }
  if (providerId !== "aliyun" || !["wan3.0-video", "wan3.0-video-prime"].includes(modelId)) return;
  // 仅限制耗内存的视频探测，等候空位；不限制已提交的生成任务。
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const checkDeadline = () => {
    if (deadline.aborted && !signal?.aborted) throw Object.assign(new Error("视频检查超时，请稍后重试"), { status: 503 });
    deadline.throwIfAborted();
  };
  while (activeVideoInspections >= 2) {
    checkDeadline();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  checkDeadline();
  activeVideoInspections++;
  try {
    const { ffprobe } = await prepareWorkspaceFfmpeg(deadline);
    cwd = await realpath(cwd);
    let total = 0;
    const hashes: string[] = [];
    for (const reference of request.videos) {
      // 私有裁剪素材不在工作区实体目录，读取后仅在有界探测期间保留字节。
      const managed = actor?.role === "user"
        ? await withManagedTrim(cwd, actor.id, reference.path, deadline, async bytes => bytes)
        : { managed: false as const };
      let bytes: Buffer;
      if (managed.managed) bytes = managed.value;
      else {
        const { path } = await resolveWorkspacePath(cwd, reference.path);
        const info = await stat(path);
        if (!info.isFile() || !info.size || info.size > maxMediaSize) invalid("参考视频须为不超过 100 MB 的文件");
        const buffer = Buffer.allocUnsafe(info.size + 1);
        let length = 0;
        const stream = createReadStream(path, { start: 0, end: info.size, signal: deadline });
        for await (const part of stream) {
          const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
          if (length + chunk.length > info.size) invalid("参考视频在检查时发生变化，请重新确认素材后重试");
          chunk.copy(buffer, length);
          length += chunk.length;
        }
        if (length !== info.size) invalid("参考视频在检查时发生变化，请重新确认素材后重试");
        bytes = buffer.subarray(0, length);
      }
      if (!bytes.length || bytes.length > maxMediaSize) invalid("参考视频须为不超过 100 MB 的文件");
      const hash = createHash("sha256").update(bytes).digest("hex");
      // 探测固定内存字节，避免创建磁盘快照，也避免文件替换竞态。
      const probe = Bun.spawn([ffprobe, "-v", "error", "-protocol_whitelist", "pipe", "-f", "mov", "-format_whitelist", "mov",
        "-enable_drefs", "0", "-use_absolute_path", "0", "-select_streams", "V:0", "-show_entries", "stream=duration:format=duration", "-of", "json", "pipe:0"],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true, signal: deadline,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "FFREPORT")) });
      let out: string, code: number;
      let ended = false;
      try {
        probe.stdin.write(bytes);
        // ffprobe 可在读到足够元数据后提前退出；等待写入结果以避免未处理的 EPIPE。
        const written = Promise.resolve(probe.stdin.end()).catch(() => undefined);
        ended = true;
        [out, code] = await Promise.all([probe.stdout.text(), probe.exited, written]);
      } catch (cause) {
        if (deadline.aborted) throw cause;
        return invalid("无法读取参考视频时长，请尝试将视频重新封装为 MP4 后重试");
      } finally {
        if (!ended) { try { void Promise.resolve(probe.stdin.end()).catch(() => {}); } catch {} }
        if (probe.exitCode === null) { try { probe.kill(); } catch {} }
        await probe.exited.catch(() => {});
      }
      const duration = parseWanProbeDuration(out, code);
      total += duration;
      hashes.push(hash);
      assertWanReferenceDuration(total);
    }
    assertWanReferenceDuration(total, request.duration);
    return hashes;
  } catch (cause) {
    checkDeadline();
    throw cause;
  } finally { activeVideoInspections--; }
}

function requireGenerationMode(task?: MediaGenerationTask) {
  if (modelGateway.enabled()) {
    if (!task?.modelRouteCipher) invalid("多租户媒体生成必须通过持久任务提交");
  } else if (task?.modelRouteCipher) {
    throw Object.assign(new Error("多租户模型路由尚未开启"), { status: 403 });
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function imageOptions(value: unknown, pattern: RegExp) {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length <= 64 && item === item.trim() && pattern.test(item)))] : undefined;
}

export async function listMediaModels(): Promise<MediaModel[]> {
  if (modelGateway.enabled()) return modelGateway.catalog(["image", "video", "audio"], currentIdentity());
  const installedProviders = await listMediaProviders();
  installedProviders.sort((left, right) => Number(right.id === "toonflow") - Number(left.id === "toonflow"));
  return installedProviders.filter(provider => provider.id !== "toonflow" || !!getAccountProvider()).flatMap(provider => provider.models.flatMap(model => {
    if (model.type !== "image" && model.type !== "video" && model.type !== "audio") return [];
    const builtIn = (mediaProviders as readonly Provider[]).find(item => item.id === provider.id)?.models.find(item => item.id === model.id);
    return [{
      providerId: provider.id, providerLabel: provider.label, modelId: model.id, label: model.label, type: model.type,
      supportsPrice: "supportsPrice" in provider && provider.supportsPrice === true,
      rules: model.rules,
      mode: model.mode, durationResolutionMap: model.durationResolutionMap, audio: model.audio,
      ...(model.type === "audio" ? { voices: model.voices } : {}),
      ...(model.type === "image" ? {
        imageSizes: imageOptions(Array.isArray(model.imageSizes) ? model.imageSizes : builtIn?.imageSizes, /^[^\u0000-\u001f\u007f]+$/),
        imageRatios: imageOptions(Array.isArray(model.imageRatios) ? model.imageRatios : builtIn?.imageRatios, /^[1-9]\d{0,3}:[1-9]\d{0,3}$/),
      } : {}),
    } as MediaModel];
  }));
}

export async function readReference(cwd: string, reference: MediaReference, mediaType: string, signal?: AbortSignal): Promise<Extract<MediaInput, { type: "base64" }>> {
  signal?.throwIfAborted();
  const actor = currentIdentity();
  if (actor?.role === "user") await withManagedTrim(cwd, actor.id, reference.path, signal ?? AbortSignal.timeout(30000), async () => { throw Object.assign(new Error("托管裁剪素材的生成接入尚未开放"), { status: 503 }); });
  const { path } = await resolveWorkspacePath(cwd, reference.path);
  const info = await stat(path);
  if (!info.isFile() || info.size > maxMediaSize) invalid("参考媒体须为不超过 100 MB 的文件");
  const bytes = await readFile(path, { signal });
  if (!bytes.length || bytes.length > maxMediaSize) invalid("参考媒体为空或超过 100 MB");
  const mimeType = detectMimeType(bytes, reference.mimeType);
  if (!mimeType.startsWith(`${mediaType}/`)) invalid(t`参考媒体类型须为 ${mediaType}`);
  return { type: "base64", data: bytes.toString("base64"), mimeType, name: reference.path };
}

async function downloadAsset(url: string, signal?: AbortSignal) {
  let mimeType = "";
  const bytes = await downloadPublicFile(url, { signal: signal ?? AbortSignal.timeout(120000), maxBytes: maxMediaSize,
    label: "生成结果", classifyExpired: true, onContentType: value => { mimeType = value; } });
  return { bytes, mimeType };
}

async function assetBytes(asset: MediaAsset, mediaType: "image" | "video" | "audio", signal?: AbortSignal) {
  if (!asset || asset.mediaType !== mediaType) invalid("供应商返回的媒体类型不正确");
  let bytes: Uint8Array;
  let mimeType = asset.mimeType ?? "";
  if (asset.type === "url") {
    const result = await downloadAsset(asset.url, signal);
    bytes = result.bytes;
    const responseMimeType = result.mimeType.split(";")[0].trim().toLowerCase();
    mimeType = responseMimeType && responseMimeType !== "application/octet-stream" ? result.mimeType : mimeType;
  } else if (asset.type === "base64") {
    const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(asset.data);
    const content = (data?.[2] ?? asset.data).replace(/\s/g, "");
    if (content.length > Math.ceil(maxMediaSize / 3) * 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(content) || content.length % 4 === 1) invalid("生成结果的 base64 内容无效或超过 100 MB");
    bytes = Buffer.from(content, "base64");
    mimeType = data?.[1] ?? mimeType;
  } else if (asset.type === "binary" && ArrayBuffer.isView(asset.data) && asset.data.BYTES_PER_ELEMENT === 1) {
    bytes = asset.data;
  } else { return invalid("供应商返回了无效的媒体结果"); }
  if (!bytes.byteLength || bytes.byteLength > maxMediaSize) invalid("生成文件为空或超过 100 MB");
  mimeType = detectMimeType(bytes, mimeType);
  if (!mimeType.startsWith(`${mediaType}/`) || !mediaExtensions[mimeType]) invalid("生成结果不是支持的图片、视频或音频格式");
  return { bytes, mimeType };
}

function resumableAssets(assets: MediaAsset[], mediaType: "image" | "video" | "audio") {
  for (const asset of assets) {
    if (!asset || asset.mediaType !== mediaType || !["url", "base64", "binary"].includes(asset.type)) invalid("供应商返回的媒体类型不正确");
    if (asset.type === "url" && (typeof asset.url !== "string" || !/^https?:\/\//i.test(asset.url))) invalid("生成结果必须使用 HTTP 或 HTTPS 地址");
  }
  return assets.every(asset => asset.type === "url") ? assets.map(asset => {
    const value = asset as Extract<MediaAsset, { type: "url" }>;
    return { type: "url" as const, mediaType, url: value.url, ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}) };
  }) : undefined;
}

async function prepareRequest<T>(directory: string | undefined, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest,
  read: (cwd: string, reference: MediaReference, type: string, signal?: AbortSignal) => Promise<T>, signal?: AbortSignal) {
  // ACT: 仅向已适配引用映射的内置供应商传递，其他第三方适配器仍接收原有公共参数。
  const referenceOrder = mediaType === "video" && ["toonflow", "apiMart", "metaso", "compshare", "aliyun"].includes(request.providerId) ? request.referenceOrder : undefined;
  if (referenceOrder) {
    const media = { image: request.images, video: request.videos, audio: request.audios };
    for (const [index, reference] of referenceOrder.entries()) {
      const available = reference.type === "text" || ("index" in reference
        ? Number.isSafeInteger(reference.index) && reference.index >= 0 && !!media[reference.type]?.[reference.index]
        : !!request[reference.type]);
      if (!available) invalid(`参考 ${index + 1} 指向的素材不存在，请重新选择引用`);
    }
    for (const match of request.prompt.matchAll(/\{\{ref (\d+)\}\}/g)) {
      if (!referenceOrder[Number(match[1]) - 1]) invalid(`引用标记 ${match[0]} 没有对应素材，请重新选择引用`);
    }
  }
  const references = async (items: MediaReference[] | undefined, type: string) => {
    if (!items?.length) return items ? [] : undefined;
    if (!directory) invalid("参考媒体需要工作目录");
    // ACT: 单次请求顺序处理引用，避免数十个参考媒体同时启动探测进程。
    const result: T[] = [];
    for (const item of items) result.push(await read(directory, item, type, signal));
    return result;
  };
  const images = await references(request.images, "image");
  if (mediaType === "audio") return {
    type: "audio" as const, model: request.modelId, text: request.prompt, images, audios: await references(request.audios, "audio"), other: request.other,
    voice: request.voice, speed: request.speed, volume: request.volume, pitch: request.pitch, language: request.language, format: request.format, sampleRate: request.sampleRate,
  };
  if (mediaType === "image") return { type: "image" as const, model: request.modelId, prompt: request.prompt, images, ratio: request.ratio, size: request.size, other: request.other };
  return {
    type: "video" as const, model: request.modelId, prompt: request.prompt, images, other: request.other,
    ...(referenceOrder ? { referenceOrder } : {}),
    videos: await references(request.videos, "video"), audios: await references(request.audios, "audio"),
    firstFrame: (await references(request.firstFrame ? [request.firstFrame] : undefined, "image"))?.[0],
    lastFrame: (await references(request.lastFrame ? [request.lastFrame] : undefined, "image"))?.[0],
    ratio: request.ratio, resolution: request.resolution, duration: request.duration, generateAudio: request.generateAudio, mode: request.mode,
  };
}

async function configuredProvider(request: MediaGenerationRequest, mediaType: "image" | "video" | "audio", signal?: AbortSignal, directory?: string,
  saveTaskData?: (data: ProviderTaskData) => Promise<void>, resume = false, modelRouteCipher?: string, actor?: ModelActor, legacyTaskOwnerId?: string,
  beforeNetwork?: () => Promise<void>, onWanSubmit?: () => void, taskId?: string) {
  const checkedFetch: typeof fetch | undefined = beforeNetwork || onWanSubmit ? Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    await beforeNetwork?.();
    if (onWanSubmit) {
      try {
        const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        const officialHost = ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"].includes(url.hostname)
          || /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|ap-northeast-1|eu-central-1|us-east-1|cn-hongkong)\.maas\.aliyuncs\.com$/.test(url.hostname);
        if (url.protocol === "https:" && officialHost && method.toUpperCase() === "POST"
          && url.pathname === "/api/v1/services/aigc/video-generation/video-synthesis") onWanSubmit();
      } catch { /* 日志不能影响模型请求 */ }
    }
    return fetch(input, init);
  }, { preconnect: fetch.preconnect }) : undefined;
  if (modelGateway.enabled() || modelRouteCipher) {
    if (!actor) throw Object.assign(new Error("请先登录 Toonflow"), { status: 401 });
    const { upstream } = await modelGateway.resolve(mediaType, request.providerId, request.modelId, modelRouteCipher, request, { actor, legacyTaskOwnerId });
    const provider = await loadMediaProviderSource(upstream.source, upstream.config, signal, checkedFetch, directory, saveTaskData, upstream.cloud, taskId);
    return { provider, request: { ...request, providerId: provider.id, modelId: upstream.upstreamModelId } };
  }
  const info = await getMediaProvider(request.providerId);
  if (!resume && !info.models.some(model => model.id === request.modelId && model.type === mediaType)) invalid("所选媒体模型不存在或类型不匹配，请重新选择");
  const configurations = record(conf.get("settings", {}).mediaProviderConfigs);
  const gatewayUrl = process.env.TOONFLOW_OPENAI_IMAGE_GATEWAY_URL;
  const gatewayToken = process.env.TOONFLOW_OPENAI_IMAGE_GATEWAY_TOKEN;
  const providerConfig = info.id === "openaiImage" && (gatewayUrl || gatewayToken)
    ? { gatewayUrl, apiKey: gatewayToken }
    : record(configurations[info.id]);
  const provider = await loadMediaProviderSource(info.source, providerConfig, signal, checkedFetch, directory, saveTaskData, false, taskId);
  return { provider, request };
}

async function preparePriceRequest(directory: string | undefined, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(5000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const prepared = await prepareRequest(directory, mediaType, request, readPriceReference, combined);
    if (prepared.type === "video") delete prepared.referenceOrder;
    return prepared;
  }
  catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) throw new Error("读取参考媒体信息超时，请稍后重试");
    throw error;
  }
}

export async function getMediaPrice(directory: string | undefined, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (modelGateway.enabled()) {
    const actor = currentIdentity();
    if (!actor) throw Object.assign(new Error("请先登录 Toonflow"), { status: 401 });
    const quote = await modelGateway.quoteRequest(mediaType, request.providerId, request.modelId, request, { actor: { id: actor.id, role: actor.role } });
    if (quote.billingMode === "userProvider") return { price: "模型费用由您的阿里云账号收取，具体以阿里云账单为准。", tips: "模型费用由您的阿里云账号收取，具体以阿里云账单为准。" };
    return { ...quote, price: `${quote.amount} ${quote.currency}`, tips: translateMessage("平台售价，按实际用量结算") };
  }
  const { provider } = await configuredProvider(request, mediaType, signal, directory);
  if (!provider.getPrice) return null;
  const prepared = await preparePriceRequest(directory, mediaType, request, signal);
  signal?.throwIfAborted();
  return getProviderPrice(provider, prepared);
}

export async function generateMedia(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  signal?: AbortSignal,
  task?: MediaGenerationTask,
): Promise<GeneratedMedia[]> {
  requireGenerationMode(task);
  const checkpoint = task?.checkpoint;
  let submitted = task?.resume === true || !!checkpoint?.providerData || checkpoint?.assetCount !== undefined || !!checkpoint?.files?.length;
  try {
    const videoHashes = !submitted && mediaType === "video" ? await validateWanVideoReferences(cwd, request, task?.actor ?? currentIdentity(), task?.modelRouteCipher, signal, task?.legacyTaskOwnerId) : undefined;
    return await executeMedia(cwd, mediaType, request, signal, task, () => { submitted = true; }, videoHashes);
  } catch (cause) {
    // ACT: 仅宿主确认尚未调用供应商的异常证明未提交；供应商错误码不能伪造此证据。
    if (!task?.modelRouteCipher || submitted) throw cause;
    const failure = cause instanceof Error ? cause : new Error(String(cause));
    notSubmittedFailures.add(failure);
    throw failure;
  }
}

async function executeMedia(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  signal: AbortSignal | undefined,
  task: MediaGenerationTask | undefined,
  markSubmitted: () => void,
  videoHashes?: string[],
): Promise<GeneratedMedia[]> {
  signal?.throwIfAborted();
  if (!request.prompt.trim()) invalid("请输入生成提示词");
  const modelRouteCipher = task?.modelRouteCipher;
  const directory = await realpath(cwd);
  const outputDirectory = request.outputDirectory ?? "assets/generated";
  await resolveWorkspacePath(directory, outputDirectory, true);
  const checkpoint = task?.checkpoint;
  const saved = new Map<number, GeneratedMedia>();
  for (const file of checkpoint?.files ?? []) {
    const prefix = `${mediaType}${task!.taskId.replaceAll("-", "")}${file.index}`;
    const expected = join(outputDirectory, `${prefix}.${mediaExtensions[file.mimeType]}`).replace(/\\/g, "/");
    const fenced = join(outputDirectory, `${prefix}g`).replace(/\\/g, "/");
    if (file.mediaType !== mediaType || file.path !== expected && !(task!.outputGeneration && file.path.startsWith(fenced)
      && new RegExp(`^\\d+\\.${mediaExtensions[file.mimeType]}$`).test(file.path.slice(fenced.length)))) invalid("任务结果文件记录与原生成请求不匹配");
    const { path } = await resolveWorkspacePath(directory, file.path);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > maxMediaSize) invalid("任务结果文件已被修改，不能覆盖");
      const bytes = await readFile(path, { signal });
      if (createHash("sha256").update(bytes).digest("hex") !== file.hash) invalid("任务结果文件已被修改，不能覆盖");
      saved.set(file.index, { path: file.path, mimeType: file.mimeType, mediaType });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (checkpoint?.assetCount && saved.size === checkpoint.assetCount && [...saved.keys()].every(index => index >= 0 && index < checkpoint.assetCount!)) {
    return Array.from({ length: checkpoint.assetCount }, (_, index) => saved.get(index)!);
  }
  let finish = () => {};
  const resumeAssets = async () => {
    const resumeActor = task?.actor ?? currentIdentity();
    const needsOwnerCheck = mediaType === "video" && resumeActor?.role === "user" && request.videos?.some(item => /^assets\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/video\.mp4$/.test(item.path));
    const beforeResumeNetwork = async () => {
      await task?.beforeNetwork?.();
      if (needsOwnerCheck && resumeActor?.role === "user") await assertActiveTrimOwner(resumeActor.id);
    };
    const { provider } = await configuredProvider(request, mediaType, signal, directory, data => task!.save({ providerData: data }), true, modelRouteCipher, task?.actor, task?.legacyTaskOwnerId, beforeResumeNetwork);
    if (!checkpoint?.providerData || !provider.resumeTask) invalid("该任务没有可恢复的供应商凭据，不能重新提交生成");
    requireGenerationMode(task);
    finish();
    if (!modelRouteCipher) finish = beginGeneration(provider);
    // 恢复只使用已保存的凭据，不重新读取参考文件、预处理或提交生成。
    const assets = await provider.resumeTask(checkpoint.providerData);
    if (mediaType === "video" && provider.id === "aliyun") task?.onProviderResult?.();
    return assets;
  };
  const written: string[] = [];
  const result: GeneratedMedia[] = [];
  try {
    signal?.throwIfAborted();
    let assets: MediaAsset[] | undefined;
    if (task?.resume) {
      assets = checkpoint?.assets ?? await resumeAssets();
    } else {
      let beforeManagedNetwork: (() => Promise<void>) | undefined;
      const { provider, request: upstreamRequest } = await configuredProvider(request, mediaType, signal, directory,
        task ? data => task.save({ providerData: data }) : undefined, false, modelRouteCipher, task?.actor, task?.legacyTaskOwnerId,
        async () => { await task?.beforeNetwork?.(); await beforeManagedNetwork?.(); }, task?.onWanSubmit, task?.taskId);
      const generate = mediaType === "image" ? provider.generateImage : mediaType === "video" ? provider.generateVideo : provider.generateAudio;
      if (typeof generate !== "function") invalid(t`此供应商不支持${translateMessage({ image: "图片", video: "视频", audio: "音频" }[mediaType])}生成`);
      const rules = Array.isArray(provider.rules) ? provider.rules : [];
      if (provider.id !== "toonflow" && rules.some(rule => rule.field === "apiKey")
        && (typeof provider.config.apiKey !== "string" || !provider.config.apiKey.trim())) invalid("请先在媒体模型设置中配置供应商 API Key");
      const uploadedVideoHashes = new Map<string, string>();
      const submit = async (reader: (cwd: string, reference: MediaReference, type: string, signal?: AbortSignal) => Promise<MediaInput>, afterPrepare?: () => void) => {
        let prepared: Awaited<ReturnType<typeof prepareRequest<MediaInput>>>;
        try {
          prepared = await prepareRequest(directory, mediaType, upstreamRequest, reader, signal);
          if (videoHashes) assertVideoHashes("videos" in prepared ? prepared.videos : undefined, videoHashes, uploadedVideoHashes);
        } finally { afterPrepare?.(); }
        const { type, ...parameters } = prepared;
        signal?.throwIfAborted();
        requireGenerationMode(task);
        if (!modelRouteCipher) finish = beginGeneration(provider);
        await task?.beforeSubmit?.();
        markSubmitted();
        const assets = type === "audio" ? await provider.generateAudio!(parameters as AudioRequest)
          : type === "image" ? await provider.generateImage!(parameters as ImageRequest) : await provider.generateVideo!(parameters as VideoRequest);
        if (mediaType === "video" && provider.id === "aliyun") task?.onProviderResult?.();
        return assets;
      };
      const actor = task?.actor ?? currentIdentity();
      const references = [...(upstreamRequest.images ?? []), ...(upstreamRequest.videos ?? []), ...(upstreamRequest.audios ?? []), ...(upstreamRequest.firstFrame ? [upstreamRequest.firstFrame] : []), ...(upstreamRequest.lastFrame ? [upstreamRequest.lastFrame] : [])];
      let handled = false;
      if (actor?.role === "user" && directory) for (const reference of references) {
        // 只信任通过源码摘要验证的阿里云适配器；上传结束后再释放大素材内存，轮询不占读取锁。
        if (mediaType === "video" && provider.id === "aliyun" && provider.sourceRevision === aliyunUploadSourceSha256 && provider.prepareVideoReference && provider.validateVideoRequest) {
          let releaseInputs: (() => void) | undefined;
          const otherReferenceHashes = new Map<string, string>();
          try {
          const managed = await useUploadedTrim(
            consume => withManagedTrim(directory, actor.id, reference.path, signal ?? AbortSignal.timeout(120000), consume),
            async bytes => {
              if (references.filter(item => item.path === reference.path).length !== 1) invalid("托管裁剪素材不能重复作为参考");
              const existingTrims = await listTrimRecoveries(directory, actor.id);
              const managedPaths = new Set(existingTrims.map(item => `assets/${item.operationId}/video.mp4`));
              assertSingleManagedReference(references, managedPaths);
              const ordinaryPaths = await Promise.all(references.filter(item => item.path !== reference.path).map(async item => (await resolveWorkspacePath(directory, item.path)).path));
              releaseInputs = lockWorkspaceFiles([...new Set(ordinaryPaths)]);
              let totalAudioDuration = 0;
              const { type: previewType, ...preview } = await prepareRequest(directory, mediaType, upstreamRequest, async (cwd, item, type, active) => {
                active?.throwIfAborted();
                if (item.path !== reference.path) {
                  const source = await resolveWorkspacePath(cwd, item.path);
                  const file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
                  try {
                    const before = await file.stat();
                    if (!before.isFile() || !before.size || before.size > maxMediaSize) invalid("参考媒体须为不超过 100 MB 的非空文件");
                    if (process.platform === "linux" && await readlink(`/proc/self/fd/${file.fd}`) !== source.path) invalid("参考媒体位置已变化，请重新选择");
                    const header = Buffer.alloc(16), read = await file.read(header, 0, header.length, 0);
                    const after = await file.stat();
                    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
                      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) invalid("参考媒体已变化，请重新选择");
                    const mime = detectMimeType(header.subarray(0, read.bytesRead), item.mimeType);
                    let dimensions: { width?: number; height?: number } | undefined;
                    if (type === "image") {
                      try { dimensions = await new Bun.Image(process.platform === "linux" ? `/proc/self/fd/${file.fd}` : source.path).metadata(); }
                      catch { invalid("无法读取参考图片尺寸，请重新选择"); }
                    }
                    assertWanReferenceMeta(type, mime, before.size, dimensions);
                    if (type === "audio") {
                      const metadata = await readPriceReference(cwd, item, type, active);
                      if (!metadata.duration || !Number.isFinite(metadata.duration) || metadata.duration <= 0) invalid("无法确认参考音频时长，请重新选择素材");
                      totalAudioDuration += metadata.duration;
                    }
                    const digest = createHash("sha256"); let size = 0;
                    for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) {
                      active?.throwIfAborted(); size += chunk.length;
                      if (size > before.size) invalid("参考媒体已变化，请重新选择");
                      digest.update(chunk);
                    }
                    if (size !== before.size) invalid("参考媒体已变化，请重新选择");
                    otherReferenceHashes.set(`${type}\0${item.path}`, digest.digest("hex"));
                    if (process.platform === "linux" && await readlink(`/proc/self/fd/${file.fd}`) !== source.path) invalid("参考媒体位置已变化，请重新选择");
                    const named = await stat(source.path);
                    if (named.dev !== before.dev || named.ino !== before.ino || named.size !== before.size
                      || named.mtimeMs !== before.mtimeMs || named.ctimeMs !== before.ctimeMs) invalid("参考媒体已变化，请重新选择");
                  } finally { await file.close(); }
                }
                active?.throwIfAborted();
                return { type: "url" as const, url: "https://example.invalid/placeholder" };
              }, signal);
              if (previewType !== "video") invalid("裁剪视频只能用于视频生成");
              if (totalAudioDuration > 15) invalid("万相参考音频总时长不能超过 15 秒");
              provider.validateVideoRequest!(preview as VideoRequest);
              await assertActiveTrimOwner(actor.id);
              await task?.beforeNetwork?.();
              const videoIndex = upstreamRequest.videos?.findIndex(item => item.path === reference.path) ?? -1;
              if (videoIndex < 0) invalid("裁剪视频只能用作视频参考");
              const digest = createHash("sha256").update(bytes).digest("hex");
              if (!videoHashes) invalid("无法确认参考视频时长，请重新选择素材");
              if (videoHashes[videoIndex] !== digest) invalid("参考视频在校验后发生变化，请重新确认素材再生成");
              if (bytes.length > maxMediaSize) invalid("参考媒体须为不超过 100 MB 的文件");
              const mimeType = detectMimeType(bytes, reference.mimeType);
              assertWanReferenceMeta("video", mimeType, bytes.length);
              signal?.throwIfAborted();
              let url: string;
              const scopedProvider = { ...provider, tool: { ...provider.tool, fetch: guardedTrimUploadFetch(provider.tool.fetch, () => assertActiveTrimOwner(actor.id), signal) } };
              try { url = await provider.prepareVideoReference!.call(scopedProvider, { model: upstreamRequest.modelId, input: { type: "binary", data: bytes, mimeType, name: reference.path }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5 * 60 * 1000)]) }); }
              catch { signal?.throwIfAborted(); throw new Error("参考视频上传失败，请检查阿里云配置后重试"); }
              if (!/^oss:\/\/dashscope-instant\/[A-Za-z0-9_./-]+$/.test(url) || url.includes("..")) invalid("参考视频上传结果无效");
              uploadedVideoHashes.set(url, digest);
              // 此后每一次供应商网络请求（包括最终提交）都重新确认账号。
              beforeManagedNetwork = () => assertActiveTrimOwner(actor.id);
              return url;
            },
            async url => {
              await assertActiveTrimOwner(actor.id);
              signal?.throwIfAborted();
              return submit(async (cwd, item, type, active) => {
                if (item.path === reference.path) return { type: "url", url, mimeType: "video/mp4", name: item.path };
                const value = await readReference(cwd, item, type, active);
                const expected = otherReferenceHashes.get(`${type}\0${item.path}`);
                assertReferenceHash(expected, value.data);
                return value;
              }, () => { releaseInputs?.(); releaseInputs = undefined; });
            },
          );
          if (managed.managed) { assets = managed.value; handled = true; break; }
          } finally { releaseInputs?.(); }
          continue;
        }
        const managed = await withManagedTrim(directory, actor.id, reference.path, signal ?? AbortSignal.timeout(120000), bytes => {
          if (references.filter(item => item.path === reference.path).length !== 1) invalid("托管裁剪素材不能重复作为参考");
          return submit(async (cwd, item, type, active) => {
          if (item.path !== reference.path) {
            try { return await readReference(cwd, item, type, active); }
            catch (error) { if ((error as { status?: number })?.status === 429) invalid("每次生成目前最多使用一个托管裁剪素材"); throw error; }
          }
          if (bytes.length > maxMediaSize) invalid("参考媒体须为不超过 100 MB 的文件");
          const mimeType = detectMimeType(bytes, item.mimeType);
          if (!mimeType.startsWith(`${type}/`)) invalid(t`参考媒体类型须为 ${type}`);
          return { type: "base64", data: bytes.toString("base64"), mimeType, name: item.path };
          });
        });
        if (managed.managed) { assets = managed.value; handled = true; break; }
      }
      if (!handled) assets = await submit(readReference);
    }
    if (!Array.isArray(assets) || !assets.length) invalid("供应商未返回生成结果");
    if (checkpoint?.assetCount !== undefined && checkpoint.assetCount !== assets.length) invalid("恢复任务的结果数量发生变化");
    // ACT: 只持久化下载地址；二进制直接落盘，避免把大媒体复制进任务 JSON。未落盘部分由 resumeTask 重新取回。
    await task?.save({ assetCount: assets.length, assets: resumableAssets(assets, mediaType) });
    let refreshed = false;
    for (let index = 0; index < assets.length; index++) {
      signal?.throwIfAborted();
      const existing = saved.get(index);
      if (existing) { result.push(existing); continue; }
      let content: Awaited<ReturnType<typeof assetBytes>>;
      try { content = await assetBytes(assets[index]!, mediaType, signal); }
      catch (cause) {
        if (refreshed || !checkpoint?.providerData || (cause as { code?: string } | null)?.code !== "MEDIA_ASSET_URL_EXPIRED") throw cause;
        // 下载地址过期时只重新查询原任务一次，不重提生成，也不无限重试同一失效地址。
        assets = await resumeAssets();
        refreshed = true;
        if (!Array.isArray(assets) || assets.length !== checkpoint.assetCount) invalid("恢复任务的结果数量发生变化");
        await task!.save({ assets: resumableAssets(assets, mediaType) });
        content = await assetBytes(assets[index]!, mediaType, signal);
      }
      const { bytes, mimeType } = content;
      signal?.throwIfAborted();
      const output = await resolveWorkspacePath(directory, outputDirectory, true);
      const release = lockWorkspaceFiles([output.path]);
      try {
        await mkdir(output.path, { recursive: true });
        if (task?.outputGeneration) {
          const disk = await statfs(output.path);
          if (disk.bavail * disk.bsize < 2 * 1024 * 1024 * 1024) throw Object.assign(new Error("可用磁盘空间不足，请联系管理员"), { status: 507 });
        }
        const suffix = task ? `${task.taskId.replaceAll("-", "")}${index}${task.outputGeneration ? `g${task.outputGeneration}` : ""}` : crypto.randomUUID();
        const file = join(outputDirectory, `${mediaType}${suffix}.${mediaExtensions[mimeType]}`);
        const { path } = await resolveWorkspacePath(directory, file);
        const outputFile = { path: relative(directory, path).replace(/\\/g, "/"), mimeType, mediaType };
        if (task) {
          const fileRecord = { ...outputFile, index, hash: createHash("sha256").update(bytes).digest("hex") };
          await task.save({ files: [...(checkpoint?.files ?? []).filter(item => item.index !== index), fileRecord] });
        }
        signal?.throwIfAborted();
        await writeWorkspaceFile(path, bytes, true);
        written.push(path);
        result.push(outputFile);
      } finally { release(); }
    }
    signal?.throwIfAborted();
    return result;
  } catch (err) {
    // ACT: 只回滚本次创建的文件，保留目录中已有的节点资源。
    if (!task && !modelRouteCipher) await Promise.all(written.map(path => unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; })));
    throw err;
  } finally { finish(); }
}
