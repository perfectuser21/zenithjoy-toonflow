/// <reference path="../../types.d.ts" />

const rules = [
  { type: "input", field: "apiKey", title: "MiniMax 国内开放平台 API Key", value: "", props: { type: "password", showPassword: true } },
] as const;

export const minimaxH3ProviderId = "minimaxH3";
const modelId = "MiniMax-H3";
const apiOrigin = "https://api.minimax.cn";
const modelSpecifications = {
  "768P": { minSeconds: 4, maxSeconds: 15, yuanPerSecond: 0.50 },
  "2K": { minSeconds: 4, maxSeconds: 15, yuanPerSecond: 0.80 },
} as const;
const textRatios = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
const frameModes = ["endFrameOptional", "startFrameOptional", "startEndRequired"] as const;
const maxImageSize = 30_000_000;
const maxRequestSize = 64_000_000;
const pollingInterval = 10_000;

type Context = ProviderContext<ProviderConfig<typeof rules>>;
type TextRatio = typeof textRatios[number];
type FrameRole = "first_frame" | "last_frame";
type TextContent = { type: "text"; text: string };
type FrameContent = { type: "image_url"; role: FrameRole; image_url: { url: string } };
type VideoContent =
  | { ratio: TextRatio; content: [TextContent] }
  | { ratio: "adaptive"; content: [TextContent, FrameContent] | [TextContent, FrameContent, FrameContent] };
type VideoSpecification = Pick<VideoRequest, "model" | "duration" | "resolution" | "ratio" | "prompt" | "mode">;
type QueryResult =
  | { kind: "pending" }
  | { kind: "succeeded"; url: string; outputSeconds?: number }
  | { kind: "failed"; message: string };

function rejected(message: string, status = 400): never {
  throw Object.assign(new Error(message), { code: "MEDIA_TASK_FAILED", status });
}

function videoSpecification(request: VideoSpecification, frames: { first: boolean; last: boolean }) {
  if (request.model !== modelId) rejected("MiniMax 官方供应商仅支持 MiniMax-H3");
  const resolution = request.resolution?.toUpperCase();
  if (resolution !== "768P" && resolution !== "2K") rejected("MiniMax H3 的分辨率须为 768P 或 2K");
  const spec = modelSpecifications[resolution];
  const duration = request.duration;
  if (duration === undefined || !Number.isInteger(duration) || duration < spec.minSeconds || duration > spec.maxSeconds) {
    rejected("MiniMax H3 的时长须为 4 到 15 秒的整数");
  }
  const text = request.prompt.trim();
  if (!text || Array.from(text).length > 7000) rejected("MiniMax H3 的提示词须为 1 到 7000 个字符");
  const ratio = textRatios.find(value => value === request.ratio);
  const { mode } = request;
  const hasFrame = frames.first || frames.last;
  if (mode !== undefined && (hasFrame ? !frameModes.some(value => value === mode) : mode !== "text")
    || mode === "endFrameOptional" && !frames.first
    || mode === "startFrameOptional" && !frames.last
    || mode === "startEndRequired" && !(frames.first && frames.last)) {
    rejected("MiniMax H3 的生成模式与首尾帧不一致");
  }
  if (hasFrame) {
    if (request.ratio !== undefined && request.ratio !== "adaptive" && !ratio) rejected("MiniMax H3 的比例无效");
    return { ratio: "adaptive", resolution, duration, text } as const;
  }
  if (!ratio) rejected("MiniMax H3 文生视频须指定受支持的宽高比");
  return { ratio, resolution, duration, text } as const;
}

function frameInput(input: MediaInput, role: FrameRole): FrameContent {
  if (input.type === "url" || !/^image\/(?:jpeg|jpg|png|webp|heic|heif)$/.test(input.mimeType)) {
    rejected("MiniMax H3 的首尾帧须为工作区内的 JPG、PNG、WebP、HEIC 或 HEIF 图片");
  }
  const data = input.type === "base64" ? input.data : Buffer.from(input.data).toString("base64");
  if (!data || data.length > Math.ceil(maxImageSize / 3) * 4 || data.length % 4 !== 0
    || !/^[a-z0-9+/]+={0,2}$/i.test(data)) {
    rejected("MiniMax H3 的首尾帧须为不超过 30 MB 的有效图片");
  }
  const mimeType = input.mimeType === "image/jpg" ? "image/jpeg" : input.mimeType;
  return { type: "image_url", role, image_url: { url: `data:${mimeType};base64,${data}` } };
}

function videoContent(request: VideoRequest, ratio: TextRatio | "adaptive", text: string): VideoContent {
  const textContent: TextContent = { type: "text", text };
  if (ratio !== "adaptive") return { ratio, content: [textContent] };
  const first = request.firstFrame && frameInput(request.firstFrame, "first_frame");
  const last = request.lastFrame && frameInput(request.lastFrame, "last_frame");
  if (first && last) return { ratio, content: [textContent, first, last] };
  const frame = first ?? last;
  if (!frame) return rejected("MiniMax H3 图生视频须提供至少一张首帧或尾帧图片");
  return { ratio, content: [textContent, frame] };
}

function isTaskId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,64}$/.test(value);
}

export function minimaxH3VideoUrl(value: string | URL): URL {
  const url = typeof value === "string" ? URL.parse(value) : value;
  if (!url || url.protocol !== "https:" || url.port || url.username || url.password || url.hash
    || !["cdn.hailuoai.com", "filecdn.minimax.chat", "algeng-video-infer.oss-cn-shanghai.aliyuncs.com"].includes(url.hostname)) {
    throw new Error("MiniMax H3 未返回有效的官方 HTTPS 视频地址");
  }
  return url;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function parseQuery(value: unknown, id: string, context: Context): QueryResult {
  const task = object(object(value).task);
  if (task.id !== id || task.model !== modelId) throw new Error("MiniMax H3 返回的任务身份不匹配");
  switch (task.status) {
    case "queued":
    case "running":
      return { kind: "pending" };
    case "succeeded": {
      const url = object(task.content).url;
      if (typeof url !== "string") throw new Error("MiniMax H3 成功任务缺少视频地址");
      const usage = object(task.usage).output_seconds;
      const outputSeconds = [usage, task.duration].find((value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 15);
      return { kind: "succeeded", url: minimaxH3VideoUrl(url).href, outputSeconds };
    }
    case "failed":
    case "cancelled":
      return { kind: "failed", message: context.tool.errorMessage(task.error)
        || (task.status === "failed" ? "MiniMax H3 视频生成失败" : "MiniMax H3 任务已在供应商侧取消") };
    default:
      throw new Error("MiniMax H3 返回了未知任务状态");
  }
}

function authorizedKey(context: Context) {
  const apiKey = typeof context.config.apiKey === "string" && context.config.apiKey.trim();
  if (!apiKey) rejected("请填写 MiniMax 国内开放平台 API Key");
  return apiKey;
}

async function waitForVideo(context: Context, apiKey: string, taskId: string, requestedSeconds: number): Promise<MediaAsset[]> {
  const timeout = AbortSignal.timeout(30 * 60_000);
  const signal = context.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
  while (!signal.aborted) {
    const response = await context.tool.fetch(`${apiOrigin}/v2/query/video_generation/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` }, redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
    });
    if (!response.ok) throw new Error(`MiniMax H3 查询任务失败 HTTP ${response.status}`);
    const result = parseQuery(await response.json(), taskId, context);
    if (result.kind === "failed") rejected(result.message, 422);
    if (result.kind === "succeeded") {
      await context.saveTaskData?.({ kind: minimaxH3ProviderId, state: "accepted", taskId, requestedSeconds,
        outputSeconds: result.outputSeconds ?? requestedSeconds });
      return [{ type: "url", mediaType: "video", mimeType: "video/mp4", url: result.url }];
    }
    await new Promise(resolve => setTimeout(resolve, pollingInterval));
  }
  context.signal?.throwIfAborted();
  throw new Error("MiniMax H3 查询已到时限，可恢复原任务");
}

const knownRejections = new Map<number, string>([
  [400, "bad_request_error"], [401, "authorized_error"], [402, "insufficient_balance_error"],
  [422, "unprocessable_entity_error"], [429, "rate_limit_error"],
]);

export default {
  id: "minimaxH3",
  label: "MiniMax H3 官方国内",
  version: "1.0.0",
  readme: "使用 MiniMax 国内开放平台 API Key。支持文生视频、首帧、尾帧及首尾帧生成，首尾帧模式根据图片适配比例。",
  rules,
  models: [{
    id: "MiniMax-H3", label: "MiniMax H3", type: "video", mode: ["text", "endFrameOptional", "startFrameOptional"], audio: "optional",
    durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768P", "2K"] }],
  }],
  async getPrice(request) {
    if (request.type !== "video" || request.images?.length || request.videos?.length || request.audios?.length) return null;
    try {
      const { resolution, duration } = videoSpecification(request, { first: !!request.firstFrame, last: !!request.lastFrame });
      return { price: `¥${(duration * modelSpecifications[resolution].yuanPerSecond).toFixed(2)}`, tips: "按 MiniMax 官方标准价格估算" };
    } catch { return null; }
  },
  async generateVideo(request) {
    if (request.images?.length || request.videos?.length || request.audios?.length) rejected("MiniMax H3 仅支持提示词与首尾帧素材");
    const apiKey = authorizedKey(this);
    const { ratio, resolution, duration, text } = videoSpecification(request, { first: !!request.firstFrame, last: !!request.lastFrame });
    const body = JSON.stringify({
      model: modelId, ...videoContent(request, ratio, text), resolution, duration, response_format: "task",
      ...(request.generateAudio !== undefined ? { generate_audio: request.generateAudio } : {}),
    });
    if (Buffer.byteLength(body) > maxRequestSize) rejected("MiniMax H3 的请求体不能超过 64 MB，请缩小首尾帧图片");
    if (!this.saveTaskData) rejected("MiniMax H3 需要支持持久化的媒体任务", 409);
    // 在付费提交前记录意图。供应商响应未知时，原任务只保留待核查状态。
    await this.saveTaskData({ kind: minimaxH3ProviderId, state: "submitting" });
    const timeout = AbortSignal.timeout(45_000);
    const response = await this.tool.fetch(`${apiOrigin}/v2/video_generation`, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body, redirect: "error", signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const value: unknown = await response.json().catch(() => undefined);
      const detail = object(object(value).error);
      const message = this.tool.errorMessage(detail) || `MiniMax H3 提交失败 HTTP ${response.status}`;
      if (object(value).type === "error" && detail.http_code === String(response.status) && detail.type === knownRejections.get(response.status)
        && knownRejections.has(response.status)) rejected(message, response.status);
      throw new Error(`MiniMax H3 提交结果未知：${message}`);
    }
    const taskId = object(await response.json()).task_id;
    if (!isTaskId(taskId)) throw new Error("MiniMax H3 提交结果缺少有效任务 ID，请核对供应商任务");
    await this.saveTaskData({ kind: minimaxH3ProviderId, state: "accepted", taskId, requestedSeconds: duration });
    return waitForVideo(this, apiKey, taskId, duration);
  },
  async resumeTask(data) {
    const { taskId, requestedSeconds } = data;
    if (data.kind !== minimaxH3ProviderId || data.state !== "accepted" || !isTaskId(taskId)
      || typeof requestedSeconds !== "number" || !Number.isInteger(requestedSeconds) || requestedSeconds < 4 || requestedSeconds > 15) {
      throw new Error("MiniMax H3 缺少已接单的任务 ID，请核对供应商任务");
    }
    return waitForVideo(this, authorizedKey(this), taskId, requestedSeconds);
  },
} satisfies ProviderDefinition<typeof rules>;
