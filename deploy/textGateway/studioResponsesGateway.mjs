import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const upstreamKey = process.env.TOONFLOW_OPENAI_UPSTREAM_KEY;
const gatewayKey = process.env.TOONFLOW_TEXT_GATEWAY_KEY;
const port = Number(process.env.TOONFLOW_TEXT_GATEWAY_PORT ?? 18877);
if (!upstreamKey || !gatewayKey || !/^[a-f0-9]{64}$/.test(gatewayKey) || !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("Text gateway configuration is incomplete");
}

const models = new Set(["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6.1-terra"]);
const maxRequestBytes = 48 * 1024 * 1024;
const maxConcurrentRequests = 8;
const digest = value => createHash("sha256").update(value).digest();
const expected = digest("Bearer " + gatewayKey);
let activeRequests = 0;

function reject(response, status, message) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: { message } }));
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    reject(response, 404, "Route unavailable");
    return;
  }
  if (!timingSafeEqual(digest(request.headers.authorization ?? ""), expected)) {
    reject(response, 401, "Authentication required");
    return;
  }
  if (activeRequests >= maxConcurrentRequests) {
    reject(response, 429, "Text gateway is busy");
    return;
  }
  const upstreamController = new AbortController();
  response.once("close", () => {
    if (!response.writableFinished) upstreamController.abort();
  });
  activeRequests++;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > maxRequestBytes) {
        reject(response, 413, "Request is too large");
        request.resume();
        return;
      }
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch {
      reject(response, 400, "Invalid request JSON");
      return;
    }
    if (!models.has(body?.model)) {
      reject(response, 400, "Model is unavailable");
      return;
    }
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", redirect: "error",
      headers: { authorization: "Bearer " + upstreamKey, "content-type": "application/json" },
      body: JSON.stringify({ ...body, store: false }),
      signal: AbortSignal.any([upstreamController.signal, AbortSignal.timeout(300_000)]),
    });
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    });
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
    else response.end();
  } catch {
    if (response.headersSent) response.destroy();
    else reject(response, 502, "Text generation gateway could not complete the request");
  } finally {
    activeRequests--;
  }
});

server.requestTimeout = 60_000;
server.listen(port, "127.0.0.1");
