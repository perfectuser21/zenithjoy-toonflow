const rules = [
  { type: "input", field: "apiKey" as const, title: "阿里云百炼 API Key", value: "", props: { type: "password", showPassword: true, autocomplete: "off" } },
  { type: "input", field: "baseUrl" as const, title: "服务地址", value: "https://dashscope.aliyuncs.com", props: { placeholder: "https://dashscope.aliyuncs.com" } },
] as const;

type Context = ProviderContext<ProviderConfig<typeof rules>>;
type ReferencedRequest = VideoRequest & {
  referenceOrder?: ({ type: "image" | "video" | "audio"; index: number } | { type: "firstFrame" | "lastFrame" | "text" })[];
};
type TaskResponse = { code?: string; message?: string; output?: { task_id?: string; task_status?: string; video_url?: string; code?: string; message?: string } };
const modelIds = ["wan3.0-video", "wan3.0-video-prime"];
const imageModelIds = ["qwen-image-3.0-pro", "qwen-image-3.0", "qwen-image-2.1-pro", "qwen-image-2.1-turbo"];
const ratios = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const imageDimensions = {
  "1K": { "16:9": "1024*576", "9:16": "576*1024", "1:1": "1024*1024", "4:3": "1024*768", "3:4": "768*1024", "3:2": "1008*672", "2:3": "672*1008" },
  "2K": { "16:9": "2048*1152", "9:16": "1152*2048", "1:1": "2048*2048", "4:3": "2048*1536", "3:4": "1536*2048", "3:2": "2016*1344", "2:3": "1344*2016" },
};

function dashScopeImageSize(size?: string, ratio = "1:1") {
  if (size === undefined) return undefined;
  if (size === "1K" || size === "2K") {
    const dimensions = Object.entries(imageDimensions[size]).find(([key]) => key === ratio)?.[1];
    if (!dimensions) throw new Error("当前阿里云图片模型不支持所选比例");
    return dimensions;
  }
  const pixels = /^([1-9]\d{0,3})[x*]([1-9]\d{0,3})$/i.exec(size.trim());
  if (!pixels) throw new Error("图片尺寸请选择 1K、2K 或指定具体像素宽高");
  const width = Number(pixels[1]);
  const height = Number(pixels[2]);
  const area = width * height;
  if (area < 512 ** 2 || area > 2048 ** 2 || Math.max(width, height) > 8 * Math.min(width, height)) {
    throw new Error("阿里云图片总像素须在 512×512 到 2048×2048 之间，宽高比须在 1:8 到 8:1 之间");
  }
  return `${width}*${height}`;
}

function configuration(context: Context) {
  const apiKey = context.config.apiKey.trim();
  if (!apiKey) throw new Error("请先配置阿里云百炼 API Key");
  let url: URL;
  try { url = new URL(context.config.baseUrl.trim()); } catch { throw new Error("阿里云服务地址无效"); }
  const legacy = ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"];
  const workspace = /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|ap-northeast-1|eu-central-1|us-east-1|cn-hongkong)\.maas\.aliyuncs\.com$/;
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || !["/", "/api/v1", "/api/v1/"].includes(url.pathname)
    || (!legacy.includes(url.hostname) && !workspace.test(url.hostname))) {
    throw new Error("服务地址须为阿里云官方 HTTPS 地址，并与密钥所属地域一致");
  }
  return { apiKey, baseUrl: url.origin };
}

function signalFor(context: ProviderContext, milliseconds: number) {
  return AbortSignal.any([AbortSignal.timeout(milliseconds), ...(context.signal ? [context.signal] : [])]);
}

async function requestJson(context: Context, url: string, init: RequestInit): Promise<Record<string, any>> {
  try {
    const response = await context.tool.fetch(url, { ...init, redirect: "error" });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || typeof data !== "object" || data.code) {
      throw new Error(`阿里云请求失败（HTTP ${response.status}）：${context.tool.errorMessage(data)}`);
    }
    return data;
  } catch (error) {
    if (context.signal?.aborted) throw new Error("已停止等待，已提交的远端任务可能仍在运行");
    throw new Error(context.tool.errorMessage(error));
  }
}

function promptFor(request: ReferencedRequest) {
  return request.prompt.replace(/\{\{ref (\d+)\}\}/g, (marker, number: string) => {
    const reference = request.referenceOrder?.[Number(number) - 1];
    if (!reference) throw new Error(`引用 ${marker} 缺少素材，请重新选择引用`);
    if (reference.type === "text") return `参考${number}`;
    if (reference.type === "firstFrame" || reference.type === "lastFrame") {
      if (!request[reference.type]) throw new Error(`引用 ${marker} 对应的首尾帧未提交`);
      return reference.type === "firstFrame" ? "首帧" : "尾帧";
    }
    if (!("index" in reference)) throw new Error(`引用 ${marker} 的素材类型无效`);
    const media = { image: request.images, video: request.videos, audio: request.audios };
    if (!Number.isSafeInteger(reference.index) || reference.index < 0 || !media[reference.type]?.[reference.index]) {
      throw new Error(`引用 ${marker} 对应的素材未提交`);
    }
    return `${{ image: "图", video: "视频", audio: "音频" }[reference.type]}${reference.index + 1}`;
  });
}

function validateRequest(request: VideoRequest) {
  if (!modelIds.includes(request.model)) throw new Error("请选择万相 3.0 标准版或高速版");
  if (typeof request.prompt !== "string" || request.prompt.length > 20000) throw new Error("提示词长度不能超过 20000 字");
  const images = request.images ?? [];
  const videos = request.videos ?? [];
  const audios = request.audios ?? [];
  const hasFrames = !!(request.firstFrame || request.lastFrame);
  const count = images.length + videos.length + audios.length;
  if (!request.prompt.trim() && !hasFrames && !count) throw new Error("请填写视频要求或添加素材");
  if (images.length > 10 || videos.length > 5 || audios.length > 5 || count > 20) throw new Error("最多使用 10 张参考图、5 段视频、5 段音频，合计不超过 20 个素材");
  if (hasFrames && count) throw new Error("首尾帧不能和参考图片、视频或音频混用，请选择一种生成方式");
  if (request.lastFrame && !request.firstFrame) throw new Error("尾帧需要与首帧一起使用");
  if (request.mode === "singleImage") throw new Error("请使用首帧模式或参考素材模式");
  if (request.mode === "text" && (count || hasFrames)) throw new Error("文生视频模式不能同时提交参考素材");
  if (Array.isArray(request.mode) && (hasFrames || !count)) throw new Error("参考模式需要参考素材，不能使用首尾帧");
  if (["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(request.mode))) {
    if (!request.firstFrame || count || (request.mode === "startEndRequired" && !request.lastFrame)) throw new Error("请提供该模式需要的首尾帧，并移除参考素材");
  }
  if (request.mode !== undefined && !Array.isArray(request.mode) && !["text", "startEndRequired", "endFrameOptional", "startFrameOptional"].includes(request.mode)) throw new Error("万相不支持该生成模式");
  if (request.duration !== undefined && request.duration !== -1 && (!Number.isInteger(request.duration) || request.duration < 2 || request.duration > 30)) throw new Error("视频时长请选择 2～30 秒，或智能时长");
  if (request.ratio !== undefined && !ratios.includes(request.ratio)) throw new Error("请选择支持的画面比例");
  if (request.resolution !== undefined && !["480P", "720P", "1080P"].includes(request.resolution.toUpperCase())) throw new Error("清晰度支持 480P、720P、1080P");
  for (const value of [request.generateAudio, request.watermark]) if (value !== undefined && typeof value !== "boolean") throw new Error("声音或水印设置无效");
  if (request.other && Object.keys(request.other).length) throw new Error("万相不支持当前额外参数，请清空后重试");
}

async function mediaUrl(context: Context, input: MediaInput, kind: "image" | "video" | "audio", model: string, signal: AbortSignal) {
  if (input.type === "url" && !input.url.startsWith("data:")) {
    let url: URL;
    try { url = new URL(input.url); } catch { throw new Error("素材地址无效，请重新上传"); }
    if (url.username || url.password || (!["http:", "https:"].includes(url.protocol) && !(url.protocol === "oss:" && url.hostname === "dashscope-instant"))) throw new Error("素材需要公开 HTTP(S) 地址或阿里云临时 OSS 地址");
    return input.url;
  }
  const raw = input.type === "url" ? input.url : input.type === "base64" ? input.data : "";
  const match = raw.match(/^data:([^;,]+);base64,([\s\S]*)$/);
  const mimeType = (match?.[1] ?? input.mimeType ?? "").toLowerCase();
  const allowed = { image: ["image/jpeg", "image/jpg", "image/png", "image/bmp", "image/webp"], video: ["video/mp4", "video/quicktime"], audio: ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"] };
  if (!allowed[kind].includes(mimeType)) throw new Error(`素材格式不支持：${kind === "image" ? "图片使用 JPG、PNG、BMP、WEBP" : kind === "video" ? "视频使用 MP4、MOV" : "音频使用 WAV、MP3"}`);
  const base64 = (match?.[2] ?? raw).replace(/\s/g, "");
  if (input.type !== "binary" && (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1)) throw new Error("素材编码无效，请重新上传");
  const bytes = input.type === "binary" ? input.data : Buffer.from(base64, "base64");
  const maxBytes = { image: 20, video: 100, audio: 15 }[kind] * 1024 * 1024;
  if (!bytes.byteLength || bytes.byteLength > maxBytes) throw new Error(`素材为空或过大，${kind === "image" ? "图片最多 20MB" : kind === "video" ? "视频最多 100MB" : "音频最多 15MB"}`);
  if (kind === "image") {
    const info = await context.tool.media.inspectImage({ type: "binary", data: bytes, mimeType });
    if (Math.min(info.width, info.height) < 240 || Math.max(info.width, info.height) > 8000 || Math.max(info.width, info.height) / Math.min(info.width, info.height) > 8) throw new Error("图片单边需为 240～8000 像素，长宽比不超过 8:1");
    return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  }
  const { apiKey, baseUrl } = configuration(context);
  const hostname = new URL(baseUrl).hostname;
  const uploadBase = hostname === "dashscope.aliyuncs.com" || hostname.includes(".cn-beijing.maas.") ? "https://dashscope.aliyuncs.com"
    : hostname === "dashscope-intl.aliyuncs.com" || hostname.includes(".ap-southeast-1.maas.") ? "https://dashscope-intl.aliyuncs.com" : "";
  if (!uploadBase) throw new Error("当前地域暂不支持临时上传，请提供公开的视频或音频地址，或使用北京/新加坡服务");
  // 官方临时上传绑定当前模型，有效期 48 小时；不删除远端素材。
  const result = await requestJson(context, `${uploadBase}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, signal });
  const policy = result.data;
  const fields = { OSSAccessKeyId: "oss_access_key_id", Signature: "signature", policy: "policy", "x-oss-object-acl": "x_oss_object_acl", "x-oss-forbid-overwrite": "x_oss_forbid_overwrite" };
  if (!policy || typeof policy.upload_dir !== "string" || !/^dashscope-instant\/[A-Za-z0-9_./-]+$/.test(policy.upload_dir) || policy.upload_dir.includes("..") || Object.values(fields).some((key) => typeof policy[key] !== "string" || !policy[key])) throw new Error("阿里云未返回有效上传凭证");
  let host: URL;
  try { host = new URL(policy.upload_host); } catch { throw new Error("阿里云上传地址无效"); }
  if (host.protocol !== "https:" || host.username || host.password || host.port || host.search || host.hash || !/^[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(host.hostname)) throw new Error("阿里云上传地址不在官方 OSS 服务范围内");
  const extension = kind === "video" ? mimeType === "video/mp4" ? "mp4" : "mov" : mimeType.includes("wav") ? "wav" : "mp3";
  const nonce = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const name = `${nonce}.${extension}`;
  const key = `${policy.upload_dir.replace(/\/$/, "")}/${name}`;
  // 宿主供应商 VM 提供 Blob，但没有 FormData/crypto；沿用现有上传适配器的 multipart 写法。
  const boundary = `----toonflow${nonce}`;
  const values = [...Object.entries(fields).map(([field, source]) => [field, policy[source]]), ["key", key], ["success_action_status", "200"]];
  const body = new Blob([
    ...values.map(([field, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${value}\r\n`),
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    new Uint8Array(bytes),
    `\r\n--${boundary}--\r\n`,
  ]);
  // OSS 仅接收签名表单，绝不发送百炼 API Key，禁止跟随重定向。
  const uploaded = await context.tool.fetch(host.href, { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body, signal, redirect: "error" });
  if (!uploaded.ok) throw new Error(`素材上传失败（HTTP ${uploaded.status}），请重新尝试上传`);
  return `oss://${key}`;
}

function wait(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 15000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function pollTask(context: Context, taskId: string) : Promise<MediaAsset[]> {
  const { apiKey, baseUrl } = configuration(context);
  const signal = signalFor(context, 30 * 60 * 1000);
  while (true) {
    const data = await requestJson(context, `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal }) as TaskResponse;
    const output = data.output;
    if (output?.task_status === "SUCCEEDED") {
      let url: URL;
      try { url = new URL(output.video_url ?? ""); } catch { throw new Error("任务已完成，但未返回视频地址"); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("任务返回的视频地址无效");
      return [{ mediaType: "video", type: "url", url: url.href, mimeType: "video/mp4" }];
    }
    if (["FAILED", "CANCELED", "UNKNOWN"].includes(output?.task_status ?? "")) throw Object.assign(new Error(`万相任务${output?.task_status === "CANCELED" ? "已取消" : output?.task_status === "UNKNOWN" ? "不存在或已过期" : `失败：${context.tool.errorMessage(output)}`}`), { code: "MEDIA_TASK_FAILED" });
    if (!output?.task_status) throw new Error("阿里云未返回任务状态，请保留原任务稍后恢复查询");
    await wait(signal);
  }
}

async function pollImageTask(context: Context, taskId: string): Promise<MediaAsset[]> {
  const { apiKey, baseUrl } = configuration(context);
  const signal = signalFor(context, 30 * 60 * 1000);
  while (true) {
    const data = await requestJson(context, `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    const output = data.output;
    if (output?.task_status === "SUCCEEDED") {
      const images = Array.isArray(output.choices) ? output.choices.flatMap((choice: any) => Array.isArray(choice?.message?.content)
        ? choice.message.content.flatMap((item: any) => typeof item?.image === "string" ? [item.image] : []) : []) : [];
      if (!images.length || images.length > 6) throw new Error("任务已完成，但未返回有效图片");
      return images.map((value: string) => {
        let url: URL;
        try { url = new URL(value); } catch { throw new Error("任务返回的图片地址无效"); }
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("任务返回的图片地址无效");
        return { mediaType: "image" as const, type: "url" as const, url: url.href, mimeType: "image/png" };
      });
    }
    if (output?.task_status === "FAILED" || output?.task_status === "CANCELED") {
      const message = output.task_status === "CANCELED" ? "阿里云图片任务已取消"
        : output.code === "InvalidParameter" ? "阿里云图片参数无效，请核对尺寸、比例或参考图"
        : "阿里云图片任务执行失败";
      throw Object.assign(new Error(message), { code: "MEDIA_TASK_FAILED" });
    }
    if (output?.task_status === "UNKNOWN") throw new Error("图片任务状态未知或已过期，请核对阿里云记录，不能自动重新提交");
    if (!output?.task_status) throw new Error("阿里云未返回图片任务状态，请保留原任务稍后恢复查询");
    await wait(signal);
  }
}

export default {
  id: "aliyun",
  label: "阿里云万相 3.0",
  version: "1.0.0",
  rules,
  readme: "支持文生视频、首尾帧和多素材参考，也可用提示词编辑参考视频。参考视频总长不超过 15 秒；参考音频总长不超过 15 秒。输入视频加输出视频总长不超过 30 秒。图片/视频/音频分别最多 20MB/100MB/15MB；视频使用 MP4/MOV，音频使用 WAV/MP3。上传素材自动使用阿里云临时存储（北京/新加坡，48 小时有效），其他地域使用公开素材地址。视频时长、帧率等由阿里云校验；长视频需先分镜切段。任务暂停或断线后恢复会继续查询原任务。",
  models: [
    { id: "qwen-image-3.0-pro", label: "千问图像 3.0 专业版", type: "image", mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["2K", "1K"], imageRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"] },
    { id: "qwen-image-3.0", label: "千问图像 3.0", type: "image", mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["2K", "1K"], imageRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"] },
    { id: "qwen-image-2.1-pro", label: "千问图像 2.1 专业版", type: "image", mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["2K", "1K"], imageRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"] },
    { id: "qwen-image-2.1-turbo", label: "千问图像 2.1 极速版", type: "image", mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["2K", "1K"], imageRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"] },
    {
      id: "wan3.0-video", label: "万相 3.0 标准版", type: "video",
      mode: ["text", "endFrameOptional", ["imageReference:10", "videoReference:5", "audioReference:5"]],
      audio: "optional", imageRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480P", "720P", "1080P"] }],
    },
    {
      id: "wan3.0-video-prime", label: "万相 3.0 高速版", type: "video",
      mode: ["text", "endFrameOptional", ["imageReference:10", "videoReference:5", "audioReference:5"]],
      audio: "optional", imageRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], resolution: ["480P", "720P", "1080P"] }],
    },
  ],
  validateVideoRequest(request: ReferencedRequest) {
    this.signal?.throwIfAborted();
    validateRequest(request);
    promptFor(request);
  },
  async prepareVideoReference(request: { model: string; input: Extract<MediaInput, { type: "binary" }>; signal?: AbortSignal }) {
    this.signal?.throwIfAborted();
    if (!modelIds.includes(request.model) || request.input.type !== "binary") throw new Error("视频素材配置无效");
    return mediaUrl(this, request.input, "video", request.model, AbortSignal.any([signalFor(this, 10 * 60 * 1000), ...(request.signal ? [request.signal] : [])]));
  },
  async generateImage(request: ImageRequest) {
    if (!imageModelIds.includes(request.model) || !request.prompt.trim() || request.prompt.length > 20000) throw new Error("请选择千问图像模型并填写图片要求");
    if (request.images && request.images.length > (request.model.startsWith("qwen-image-3.0") ? 3 : 10)) throw new Error("参考图片数量超过模型限制");
    if (request.mask || request.other && Object.keys(request.other).length || request.n !== undefined && request.n !== 1) throw new Error("当前图片任务仅支持生成一张图片");
    const size = dashScopeImageSize(request.size, request.ratio);
    const { apiKey, baseUrl } = configuration(this);
    const signal = signalFor(this, 10 * 60 * 1000);
    const images = [];
    for (const input of request.images ?? []) {
      const image = await mediaUrl(this, input, "image", request.model, signal);
      if (image.startsWith("data:") && image.length > 14000000) throw new Error("参考图片不能超过 10 MB");
      images.push({ image });
    }
    const data = await requestJson(this, `${baseUrl}/api/v1/services/aigc/image-generation/generation`, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-DashScope-Async": "enable" },
      body: JSON.stringify({ model: request.model, input: { messages: [{ role: "user", content: [...images, { text: request.prompt }] }] }, parameters: { n: 1, size } }), signal,
    });
    const taskId = data.output?.task_id;
    if (typeof taskId !== "string" || !/^[a-zA-Z0-9-]+$/.test(taskId)) throw new Error("阿里云未返回任务编号，请核对平台记录后再操作，避免重复提交");
    await this.saveTaskData?.({ kind: "aliyunQwenImage", taskId, model: request.model, baseUrlHash: String(this.tool.hash(baseUrl)), accountHash: String(this.tool.hash(apiKey)), expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    return pollImageTask(this, taskId);
  },
  async generateVideo(request: ReferencedRequest) {
    this.signal?.throwIfAborted();
    validateRequest(request);
    const prompt = promptFor(request);
    const { apiKey, baseUrl } = configuration(this);
    const signal = signalFor(this, 10 * 60 * 1000);
    const media: { type: string; url: string }[] = [];
    for (const [field, kind, type] of [["images", "image", "reference_image"], ["videos", "video", "reference_video"], ["audios", "audio", "reference_audio"]] as const) {
      for (const input of request[field] ?? []) media.push({ type, url: await mediaUrl(this, input, kind, request.model, signal) });
    }
    for (const [field, type] of [["firstFrame", "first_frame"], ["lastFrame", "last_frame"]] as const) {
      if (request[field]) media.push({ type, url: await mediaUrl(this, request[field], "image", request.model, signal) });
    }
    signal.throwIfAborted();
    const parameters = { duration: request.duration ?? 5, resolution: request.resolution?.toUpperCase() ?? "1080P", ratio: request.ratio ?? "adaptive", audio: request.generateAudio ?? true, watermark: request.watermark ?? false };
    // 只提交一次；接单后只轮询原 ID，网络异常不自动重提收费任务。
    const data = await requestJson(this, `${baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-DashScope-Async": "enable", ...(media.some((item) => item.url.startsWith("oss://")) ? { "X-DashScope-OssResourceResolve": "enable" } : {}) }, body: JSON.stringify({ model: request.model, input: { prompt, ...(media.length ? { media } : {}) }, parameters }), signal }) as TaskResponse;
    const taskId = data.output?.task_id;
    if (!taskId || !/^[a-zA-Z0-9-]+$/.test(taskId)) throw new Error("阿里云未返回任务编号，请核对平台记录后再操作，避免重复提交");
    await this.saveTaskData?.({ kind: "aliyunWanVideo", taskId, model: request.model, baseUrlHash: String(this.tool.hash(baseUrl)), accountHash: String(this.tool.hash(apiKey)), expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    return pollTask(this, taskId);
  },
  async resumeTask(data) {
    const { apiKey, baseUrl } = configuration(this);
    if (data.kind === "aliyunQwenImage") {
      if (typeof data.taskId !== "string" || !/^[a-zA-Z0-9-]+$/.test(data.taskId) || typeof data.model !== "string" || !imageModelIds.includes(data.model) || data.baseUrlHash !== String(this.tool.hash(baseUrl)) || data.accountHash !== String(this.tool.hash(apiKey))) throw new Error("任务恢复数据或服务配置已变化，请使用原账号和服务地址查询原任务");
      if (typeof data.expiresAt !== "number" || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) throw new Error("原任务已超过 24 小时查询有效期，未自动重新提交");
      return pollImageTask(this, data.taskId);
    }
    if (data.kind !== "aliyunWanVideo" || typeof data.taskId !== "string" || !/^[a-zA-Z0-9-]+$/.test(data.taskId) || typeof data.model !== "string" || !modelIds.includes(data.model) || data.baseUrlHash !== String(this.tool.hash(baseUrl)) || data.accountHash !== String(this.tool.hash(apiKey))) throw new Error("任务恢复数据或服务配置已变化，请使用原账号和服务地址查询原任务");
    if (typeof data.expiresAt !== "number" || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) throw new Error("原任务已超过 24 小时查询有效期，未自动重新提交");
    return pollTask(this, data.taskId);
  },
} satisfies ProviderDefinition<typeof rules>;
