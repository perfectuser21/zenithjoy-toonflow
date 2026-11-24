/// <reference path="../../types.d.ts" />

const rules = [
  { type: "input", field: "gatewayUrl", title: "图片网关 URL", value: "" as string },
  { type: "input", field: "apiKey", title: "图片网关访问令牌", value: "" as string, props: { type: "password", showPassword: true } },
] as const;

const modelId = "gpt-image-2.5-sunburst";
const maxReferenceImages = 16;
const maxEncodedImageBytes = 20 * 1024 * 1024;
const imageDimensions = {
  "1K": { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536", "16:9": "1536x864", "9:16": "864x1536" },
  "2K": { "1:1": "1920x1920", "3:2": "2016x1344", "2:3": "1344x2016", "16:9": "2048x1152", "9:16": "1152x2048" },
};

function referenceImage(input: MediaInput) {
  if (input.type === "url" || !/^image\/(?:png|jpeg|webp)$/.test(input.mimeType)) {
    throw new Error("参考图须为工作区内的 PNG、JPEG 或 WebP 图片");
  }
  const data = input.type === "base64" ? input.data : Buffer.from(input.data).toString("base64");
  if (!data.length) throw new Error("参考图不能为空");
  if (data.length > maxEncodedImageBytes) throw new Error("参考图编码后的总大小不得超过 20 MiB");
  return { image_url: `data:${input.mimeType};base64,${data}` };
}

export default {
  id: "openaiImage",
  label: "OpenAI 图片网关",
  version: "1.1.0",
  readme: "连接平台配置的 OpenAI 图片网关。支持文生图和工作区图片编辑。请填写网关颁发的访问令牌。",
  rules,
  models: [{
    id: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst", type: "image", mode: ["text", "singleImage", "multiReference"],
    maxReferenceImages: 16,
    imageSizes: ["1K", "2K"], imageRatios: ["1:1", "3:2", "2:3", "16:9", "9:16"],
  }],
  async generateImage(request) {
    if (request.model !== modelId) throw new Error("图片网关不支持所选模型");
    const gateway = URL.parse(this.config.gatewayUrl);
    if (!gateway || gateway.protocol !== "https:" || gateway.username || gateway.password || gateway.pathname !== "/"
      || gateway.search || gateway.hash || gateway.hostname.replace(/\.$/, "") === "api.openai.com") throw new Error("请配置图片网关的 HTTPS 地址");
    const token = typeof this.config.apiKey === "string" && this.config.apiKey.trim();
    if (!token) throw new Error("请配置图片网关访问令牌");
    if (request.mask || (request.n !== undefined && request.n !== 1)) throw new Error("图片网关每次生成一张图片，暂不支持蒙版");
    const resolution = request.size ?? "1K";
    const ratio = request.ratio ?? "1:1";
    const dimensions = resolution === "1K" ? imageDimensions["1K"] : resolution === "2K" ? imageDimensions["2K"] : undefined;
    const size = dimensions && Object.entries(dimensions).find(([key]) => key === ratio)?.[1];
    if (!size) throw new Error("图片尺寸或比例不可用");
    const referenceImages = request.images ?? [];
    if (referenceImages.length > maxReferenceImages) {
      throw new Error(`最多使用 ${maxReferenceImages} 张参考图，已收到 ${referenceImages.length} 张`);
    }
    const images = referenceImages.map(referenceImage);
    if (images.reduce((size, input) => size + input.image_url.length, 0) > maxEncodedImageBytes) {
      throw new Error("参考图编码后的总大小不得超过 20 MiB");
    }
    const response = await this.tool.fetch(new URL(images.length ? "/v1/images/edits" : "/v1/images/generations", gateway), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, prompt: request.prompt, size, quality: "medium", output_format: "png", n: 1,
        ...(images.length ? { images } : {}) }),
      redirect: "error",
      signal: this.signal,
    });
    if (!response.ok) throw Object.assign(new Error(`图片网关请求失败 HTTP ${response.status}`), { status: response.status });
    if (response.headers.get("x-toonflow-image-gateway") !== "openai") throw new Error("图片网关响应身份无效");
    const output: unknown = await response.json();
    if (!output || typeof output !== "object" || !("data" in output) || !Array.isArray(output.data) || output.data.length !== 1) {
      throw new Error("图片网关结果无效");
    }
    const asset: unknown = output.data[0];
    if (!asset || typeof asset !== "object" || !("b64_json" in asset) || typeof asset.b64_json !== "string"
      || asset.b64_json.length < 16 || asset.b64_json.length > 32 * 1024 * 1024 || !asset.b64_json.startsWith("iVBORw0KGgo")) {
      throw new Error("图片网关没有返回有效的 PNG 图片");
    }
    return [{ type: "base64", data: asset.b64_json, mimeType: "image/png", mediaType: "image" }];
  },
} satisfies ProviderDefinition<typeof rules>;
