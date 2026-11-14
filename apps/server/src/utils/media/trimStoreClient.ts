import { lstat, realpath } from "@toonflow/file";
import { request as httpRequest } from "node:http";
import { dirname, resolve } from "node:path";
import { ensureTrimSingleton } from "@/utils/media/trimSingleton";
import { readTrimSecret } from "@/utils/media/trimSecret";

const maxBytes = 128 * 1024 * 1024;
let busy = false;
function unavailable(): never { throw Object.assign(new Error("裁剪私有存储不可用"), { status: 503 }); }

async function config() {
  await ensureTrimSingleton();
  const socket = process.env.TOONFLOW_TRIM_STORE_SOCKET, rawUid = process.env.TOONFLOW_TRIM_STORE_UID;
  if (!socket?.startsWith("/") || process.env.TOONFLOW_TRIM_STORE_TOKEN || !rawUid || !/^[0-9]+$/.test(rawUid) || Number(rawUid) < 1) return unavailable();
  const token = await readTrimSecret(process.env.TOONFLOW_TRIM_STORE_TOKEN_FILE).catch(() => unavailable());
  const parent = dirname(resolve(socket)), info = await lstat(parent), endpoint = await lstat(socket);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent || info.uid !== 0 || (info.mode & 0o027)
    || !endpoint.isSocket() || endpoint.isSymbolicLink() || endpoint.uid !== Number(rawUid) || endpoint.gid !== info.gid || (endpoint.mode & 0o007)
    || typeof process.getuid !== "function" || process.getuid() === info.uid || typeof process.getgroups !== "function" || typeof process.getgid !== "function" || process.getgid() !== info.gid && !process.getgroups().includes(info.gid)) return unavailable();
  for (let ancestor = dirname(parent);;) {
    const entry = await lstat(ancestor);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022)) return unavailable();
    const next = dirname(ancestor); if (next === ancestor) break; ancestor = next;
  }
  return { socket, token };
}

export async function trimStoreRequest(method: "GET" | "POST" | "SEAL", ownerId: string, workspaceHash: string, operationId: string, signal: AbortSignal, data?: Buffer) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(ownerId)
    || !/^[a-f0-9]{64}$/.test(workspaceHash) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId)
    || method === "POST" && (!data?.length || data.length > maxBytes)) return unavailable();
  if (busy) throw Object.assign(new Error("裁剪私有存储繁忙"), { status: 429 });
  busy = true;
  try {
  const { socket, token } = await config();
  const response = await new Promise<import("node:http").IncomingMessage>((done, reject) => {
    const req = httpRequest({ socketPath: socket, path: method === "SEAL" ? "/seal" : "/result", method: method === "SEAL" ? "POST" : method, signal: AbortSignal.any([signal, AbortSignal.timeout(240000)]), headers: { authorization: `Bearer ${token}`, "x-trim-owner": ownerId, "x-trim-workspace": workspaceHash, "x-trim-operation": operationId, ...(data ? { "content-length": String(data.length) } : method === "SEAL" ? { "content-length": "0" } : {}) } }, done);
    req.once("error", reject);
    req.end(data);
  });
  if (response.statusCode !== (method === "POST" ? 201 : method === "SEAL" ? 204 : 200)) {
    response.resume();
    if (response.statusCode === 507) throw Object.assign(new Error("账户存储空间不足，无法保存裁剪结果"), { status: 507 });
    if (method === "GET" && response.statusCode === 404) throw Object.assign(new Error("裁剪结果不存在"), { status: 404, code: "ETRIMNOTFOUND" });
    if (method === "GET" && response.statusCode === 410) throw Object.assign(new Error("裁剪结果已封禁"), { status: 410, code: "ETRIMSEALED" });
    return unavailable();
  }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response) { size += chunk.length; if (size > maxBytes) return unavailable(); chunks.push(Buffer.from(chunk)); }
  if (method !== "GET") return undefined;
  if (!size) return unavailable();
  return Buffer.concat(chunks);
  } finally { busy = false; }
}
