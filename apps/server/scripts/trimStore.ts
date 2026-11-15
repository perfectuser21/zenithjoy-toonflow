// 独立 UID 的裁剪结果存储。仅可信应用可访问 socket；客户不能获得 socket 凭据。
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";
import { constants, lstat, mkdir, open, readdir, realpath, statfs } from "@toonflow/file";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { createConnection } from "node:net";
import { serveTrimSocket } from "./trimSocketServer";
import { acquireIngressRequestFence } from "./trimIngressFence";
import { startupAdmissionRequired } from "./trimStartupAdmission";

const socket = process.env.TOONFLOW_TRIM_STORE_SOCKET, token = process.env.TOONFLOW_TRIM_STORE_TOKEN;
const quotaRoot = process.env.TOONFLOW_PROJECT_QUOTA_ROOT, appGid = Number(process.env.TOONFLOW_TRIM_ACCESS_GID);
const quotaGid = Number(process.env.TOONFLOW_TRIM_STORE_GID);
if (!socket?.startsWith("/") || !quotaRoot?.startsWith("/") || !token || !/^[a-f0-9]{64}$/.test(token)
  || !Number.isSafeInteger(appGid) || appGid < 1 || typeof process.getuid !== "function" || !process.getuid() || !Number.isSafeInteger(quotaGid) || quotaGid < 1 || typeof process.getgid !== "function" || process.getgid() !== quotaGid || typeof process.getgroups !== "function" || !process.getgroups().includes(appGid)) throw new Error("裁剪存储配置不完整");
const storeUid = process.getuid();
const attestedIngress = startupAdmissionRequired(process.argv.slice(2), process.env.TOONFLOW_TRIM_STARTUP_ADMISSION);
if (attestedIngress) {
  const startupFence = await acquireIngressRequestFence();
  await startupFence.close();
}
const maxBytes = 128 * 1024 * 1024;
const libc = dlopen("libc.so.6", {
  ioctl: { args: [FFIType.int, FFIType.u64, FFIType.ptr], returns: FFIType.int },
  flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int },
  fcntl: { args: [FFIType.int, FFIType.int, FFIType.int], returns: FFIType.int },
});
// 与数据根目录绑定的 root 文件锁，避免两个存储进程同时读写同一批结果。
const quotaInfo = await lstat(quotaRoot);
if (!quotaInfo.isDirectory() || quotaInfo.isSymbolicLink() || quotaInfo.uid !== 0 || quotaInfo.mode & 0o022 || await realpath(quotaRoot) !== resolve(quotaRoot)) throw new Error("配额根目录不安全");
const processLock = await open(resolve(quotaRoot, ".trimStore.lock"), constants.O_RDONLY | constants.O_NOFOLLOW);
const lockInfo = await processLock.stat();
if (!lockInfo.isFile() || lockInfo.uid !== 0 || lockInfo.nlink !== 1 || lockInfo.mode & 0o022 || libc.symbols.fcntl(processLock.fd, 2, 1) !== 0 || libc.symbols.flock(processLock.fd, 6) !== 0) throw new Error("裁剪存储已有实例或锁不安全");
let busy = false;
const deny = (status: number) => new Response(null, { status });
async function projectIdentity(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const attributes = Buffer.alloc(28);
    if (libc.symbols.ioctl(directory.fd, 0x801c581f, ptr(attributes)) !== 0) throw new Error("无法验证项目配额");
    const flags = attributes.readUInt32LE(0), projectId = attributes.readUInt32LE(12);
    if (!(flags & 0x200) || !projectId) throw new Error("项目配额未继承");
    return projectId;
  } finally { await directory.close(); }
}
async function quotaProject(owner: string, seal: boolean) {
  const endpoint = resolve(quotaRoot!, "quotaTrimRead.sock"), info = await lstat(endpoint);
  if (!info.isSocket() || info.uid !== 0 || info.gid !== quotaGid || (info.mode & 0o777) !== 0o660) throw new Error("配额服务不可用");
  return new Promise<number>((accept, reject) => {
    const conn = createConnection(endpoint); let data = "";
    const fail = () => { conn.destroy(); reject(new Error("配额服务不可用")); };
    conn.setTimeout(5000, fail); conn.once("error", fail);
    conn.once("connect", () => conn.write(`${JSON.stringify({ userId: owner, operation: seal ? "trimSealCheck" : "trimCheck" })}\n`));
    conn.on("data", chunk => {
      data += chunk.toString("utf8"); if (data.length > 1024) return fail(); if (!data.endsWith("\n")) return;
      try { const value = JSON.parse(data); if (value.ready !== true || !Number.isSafeInteger(value.projectId) || value.projectId < 1) return fail(); conn.destroy(); accept(value.projectId); } catch { fail(); }
    });
    conn.once("end", fail);
  });
}
async function rootFor(owner: string, seal: boolean) {
  const parent = resolve(quotaRoot!, "privateTrim", owner), root = resolve(parent, "results");
  const [p, r, actualParent, actualRoot] = await Promise.all([lstat(parent), lstat(root), realpath(parent), realpath(root)]);
  if (actualParent !== parent || actualRoot !== root || !p.isDirectory() || p.isSymbolicLink() || p.uid !== 0 || (p.mode & 0o022)
    || !r.isDirectory() || r.isSymbolicLink() || r.uid !== storeUid || r.gid !== appGid || (r.mode & 0o777) !== 0o750 || p.dev !== r.dev) throw new Error("裁剪存储目录不安全");
  const project = await quotaProject(owner, seal);
  if (await projectIdentity(root) !== project) throw new Error("裁剪存储项目配额不一致");
  for (let path = dirname(parent);;) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw new Error("裁剪存储祖先不安全");
    const next = dirname(path); if (next === path) break; path = next;
  }
  return { root, project };
}
await serveTrimSocket(socket, "trimStore", maxBytes, async request => {
  if (processLock.fd < 0) return deny(503);
  const currentLock = await lstat(resolve(quotaRoot!, ".trimStore.lock")).catch(() => null);
  if (!currentLock?.isFile() || currentLock.isSymbolicLink() || currentLock.uid !== 0 || currentLock.nlink !== 1 || currentLock.mode & 0o022 || currentLock.dev !== lockInfo.dev || currentLock.ino !== lockInfo.ino) return deny(503);
  const auth = Buffer.from(request.headers.get("authorization") ?? ""), expected = Buffer.from(`Bearer ${token}`);
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return deny(403);
  const url = new URL(request.url), owner = request.headers.get("x-trim-owner") ?? "", workspace = request.headers.get("x-trim-workspace") ?? "", operation = request.headers.get("x-trim-operation") ?? "";
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner)
    || !/^[a-f0-9]{64}$/.test(workspace) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operation)) return deny(400);
  const seal = url.pathname === "/seal" && request.method === "POST";
  const verify = url.pathname === "/verify" && request.method === "POST";
  if (!seal && !verify && (url.pathname !== "/result" || !["GET", "POST"].includes(request.method))) return deny(404);
  if (busy) return deny(429);
  busy = true;
  let streaming = false;
  try {
    const { root, project } = await rootFor(owner, seal || verify), folder = resolve(root, workspace);
    if (request.method === "POST" && !verify) {
      const length = Number(request.headers.get("content-length"));
      if (!Number.isSafeInteger(length) || (seal ? length !== 0 : !request.body || length < 1 || length > maxBytes)) return deny(400);
      const disk = await statfs(root, { bigint: true });
      if (disk.bavail * disk.bsize < BigInt(2 * 1024 * 1024 * 1024 + length)) return deny(507);
      let created = false;
      try { await mkdir(folder, { mode: 0o750 }); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const info = await lstat(folder);
      if (info.isDirectory() && !info.isSymbolicLink() && info.uid === storeUid && (info.gid === quotaGid || info.gid === appGid && (info.mode & 0o777) !== 0o750)
        && (created || (await readdir(folder)).length === 0)) {
        const directory = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.chown(storeUid, appGid); await directory.chmod(0o750); await directory.sync(); }
        finally { await directory.close(); }
      }
      // workspace 子目录可能是首次创建；先持久化其父目录项。
      const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    }
    const folderInfo = await lstat(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT" && (request.method === "GET" || verify)) return null; throw error; });
    if (!folderInfo) return deny(404);
    if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink() || folderInfo.uid !== storeUid || folderInfo.gid !== appGid || (folderInfo.mode & 0o777) !== 0o750 || await realpath(folder) !== folder || await projectIdentity(folder) !== project) return deny(503);
    const dir = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const filePath = `/proc/self/fd/${dir.fd}/${operation}.mp4`;
      const tombstone = `/proc/self/fd/${dir.fd}/${operation}.cancel`;
      const existingTombstone = await lstat(tombstone).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (verify) {
        const expectedDigest = request.headers.get("x-trim-digest") ?? "", expectedLength = Number(request.headers.get("x-trim-bytes"));
        if (request.headers.get("content-length") !== "0" || !/^[a-f0-9]{64}$/.test(expectedDigest) || !Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > maxBytes) return deny(400);
        if (existingTombstone) return deny(409);
        const input = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        if (!input) return deny(404);
        try {
          const info = await input.stat();
          if (!info.isFile() || info.nlink !== 1 || info.uid !== storeUid || (info.mode & 0o077) || info.size !== expectedLength) return deny(409);
          await input.sync(); await dir.sync();
          const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { await parent.sync(); } finally { await parent.close(); }
          const digest = createHash("sha256").update(await input.readFile()).digest("hex");
          return deny(digest === expectedDigest ? 204 : 409);
        } finally { await input.close(); }
      }
      if (seal) {
        const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        if (existing) return deny(409);
        if (existingTombstone && (!existingTombstone.isFile() || existingTombstone.isSymbolicLink() || existingTombstone.uid !== storeUid || existingTombstone.nlink !== 1 || existingTombstone.size !== 0 || (existingTombstone.mode & 0o077))) return deny(503);
        const marker = await open(tombstone, existingTombstone ? constants.O_RDONLY | constants.O_NOFOLLOW : constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
        try { await marker.sync(); } finally { await marker.close(); }
        await dir.sync();
        const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await parent.sync(); } finally { await parent.close(); }
        return deny(204);
      }
      if (existingTombstone) {
        if (request.method !== "GET" || !existingTombstone.isFile() || existingTombstone.isSymbolicLink() || existingTombstone.uid !== storeUid || existingTombstone.nlink !== 1 || existingTombstone.size !== 0 || (existingTombstone.mode & 0o077)) return deny(409);
        const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        return deny(existing ? 409 : 410);
      }
      if (request.method === "POST") {
        const reader = request.body!.getReader(), chunks: Uint8Array[] = []; let total = 0, timedOut = false;
        const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 30000);
        try {
          for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.length; if (total > maxBytes) { await reader.cancel(); return deny(413); } chunks.push(value); }
        } finally { clearTimeout(timer); reader.releaseLock(); }
        if (timedOut) return deny(408);
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== Number(request.headers.get("content-length")) || bytes.length > maxBytes) return deny(400);
        const out = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
        try { await out.writeFile(bytes); await out.sync(); } finally { await out.close(); }
        await dir.sync();
        return new Response(null, { status: 201 });
      }
      const input = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (!input) return deny(404);
      try {
        const info = await input.stat();
        if (!info.isFile() || info.nlink !== 1 || info.uid !== storeUid || (info.mode & 0o077) || info.size < 1 || info.size > maxBytes) return deny(409);
        // 重启后文件可能仅存在于页缓存；恢复读取先补齐所有目录层级持久化。
        await input.sync();
        await dir.sync();
        const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await parent.sync(); } finally { await parent.close(); }
        const bytes = await input.readFile();
        let position = 0, released = false, timer: ReturnType<typeof setTimeout>;
        const release = () => { if (released) return; released = true; clearTimeout(timer); busy = false; };
        const body = new ReadableStream<Uint8Array>({
          start(controller) { timer = setTimeout(() => { controller.error(new Error("响应超时")); release(); }, 30000); },
          pull(controller) { if (position >= bytes.length) { controller.close(); release(); return; } const end = Math.min(position + 65536, bytes.length); controller.enqueue(bytes.subarray(position, end)); position = end; },
          cancel() { release(); },
        });
        streaming = true;
        return new Response(body, { headers: { "content-type": "video/mp4", "cache-control": "no-store" } });
      } finally { await input.close(); }
    } finally { await dir.close(); }
  } catch (error) { return deny(["EDQUOT", "ENOSPC"].includes((error as NodeJS.ErrnoException)?.code ?? "") ? 507 : 503); }
  finally { if (!streaming) busy = false; }
}, attestedIngress ? acquireIngressRequestFence : undefined);
console.log("裁剪私有存储已启动");
