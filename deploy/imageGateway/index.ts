import { timingSafeEqual } from "node:crypto";

const modelId = "gpt-image-2.5-sunburst";
const upstreamOrigin = "https://api.openai.com";
const maxImageBytes = 20 * 1024 * 1024;
const generations = "/v1/images/generations";
const edits = "/v1/images/edits";
const validDimensions = new Set(["1024x1024", "1536x1024", "1024x1536", "1536x864", "864x1536",
  "1920x1920", "2016x1344", "1344x2016", "2048x1152", "1152x2048"]);

const token = process.env.OPENAI_IMAGE_GATEWAY_TOKEN?.trim();
const apiKey = process.env.OPENAI_API_KEY?.trim();
const port = Number(process.env.OPENAI_IMAGE_GATEWAY_PORT ?? "18875");
if (!token || token.length < 32 || !apiKey || token === apiKey || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("图片网关需要独立的访问令牌、OpenAI 凭据及有效的服务端口");
}
const expectedAuthorization = Buffer.from(`Bearer ${token}`);

function error(message: string, status: number, headers?: Headers) {
  return Response.json({ error: { message } }, { status, headers });
}

function authorized(header: string | null) {
  if (!header) return false;
  const supplied = Buffer.from(header);
  return supplied.length === expectedAuthorization.length && timingSafeEqual(supplied, expectedAuthorization);
}

function readImageUrl(value: unknown) {
  if (!value || typeof value !== "object" || !("image_url" in value) || typeof value.image_url !== "string"
    || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image_url)) throw new Error("参考图无效");
  return { image_url: value.image_url };
}

function parseImageRequest(value: unknown, edit: boolean) {
  if (!value || typeof value !== "object" || !("model" in value) || value.model !== modelId
    || !("prompt" in value) || typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 32000
    || !("size" in value) || typeof value.size !== "string" || !validDimensions.has(value.size)
    || !("quality" in value) || value.quality !== "medium" || !("output_format" in value) || value.output_format !== "png"
    || !("n" in value) || value.n !== 1) throw new Error("图片请求参数无效");
  let images: ReturnType<typeof readImageUrl>[] | undefined;
  if (edit) {
    if (!("images" in value) || !Array.isArray(value.images) || value.images.length < 1 || value.images.length > 4) {
      throw new Error("图片编辑需要一至四张参考图");
    }
    images = value.images.map(readImageUrl);
    if (images.reduce((size, input) => size + input.image_url.length, 0) > maxImageBytes) throw new Error("参考图编码后的总大小不得超过 20 MB");
  } else if ("images" in value) throw new Error("文生图请求不能包含参考图");
  return { model: modelId, prompt: value.prompt, size: value.size, quality: value.quality, output_format: value.output_format,
    n: value.n, ...(images ? { images } : {}) };
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  maxRequestBodySize: maxImageBytes + 256 * 1024,
  idleTimeout: 210,
  async fetch(request) {
    const { pathname, search } = new URL(request.url);
    if (search || (pathname !== generations && pathname !== edits)) return error("未找到图片接口", 404);
    if (request.method !== "POST") return error("图片接口仅接受 POST", 405);
    if (!authorized(request.headers.get("authorization"))) return error("图片网关访问令牌无效", 401);
    const requestId = request.headers.get("x-client-request-id");
    if (!requestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
      return error("图片请求缺少有效的请求编号", 400);
    }
    const headers = new Headers({ "x-toonflow-image-gateway": "openai", "x-client-request-id": requestId, "cache-control": "no-store" });
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return error("图片接口仅接受 JSON", 415, headers);
    }
    let body: ReturnType<typeof parseImageRequest>;
    try { body = parseImageRequest(await request.json(), pathname === edits); }
    catch (cause) { return error(cause instanceof SyntaxError ? "图片请求 JSON 无效" : cause instanceof Error ? cause.message : "图片请求无效", 400, headers); }
    const operation = pathname === edits ? "edit" : "generate";
    try {
      const upstream = await fetch(new URL(pathname, upstreamOrigin), {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Client-Request-Id": requestId },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(180000)]),
      });
      const requestHeader = upstream.headers.get("x-request-id");
      const upstreamRequestId = requestHeader && /^req_[a-zA-Z0-9_-]{1,120}$/.test(requestHeader) ? requestHeader : undefined;
      console.info(JSON.stringify({ event: "openaiImageGateway", requestId, upstreamRequestId, model: modelId, operation, status: upstream.status }));
      if (upstreamRequestId) headers.set("x-request-id", upstreamRequestId);
      if (!upstream.ok || !upstreamRequestId || !upstream.headers.get("content-type")?.startsWith("application/json")) {
        await upstream.body?.cancel().catch(() => {});
        return error(`OpenAI 图片接口响应失败 (${upstream.status})`, upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502, headers);
      }
      headers.set("content-type", "application/json");
      return new Response(upstream.body, { headers });
    } catch {
      console.info(JSON.stringify({ event: "openaiImageGateway", requestId, model: modelId, operation, status: "networkError" }));
      return error("OpenAI 图片接口暂时不可达", 502, headers);
    }
  },
});
