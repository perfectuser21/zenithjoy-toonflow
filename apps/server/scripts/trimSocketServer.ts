import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { Readable } from "node:stream";
import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";

// systemd 持有监听 socket；服务只接收 fd，不创建、删除或替换 socket 文件。
export async function serveTrimSocket(path: string, name: string, maxBytes: number, fetch: (request: Request) => Promise<Response>) {
  if (process.platform !== "linux" || process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== "1" || process.env.LISTEN_FDNAMES !== name) throw new Error("裁剪 socket 未由 systemd 提供");
  delete process.env.LISTEN_PID; delete process.env.LISTEN_FDS; delete process.env.LISTEN_FDNAMES;
  const socket = resolve(path), parent = dirname(socket), [directory, info] = await Promise.all([lstat(parent), lstat(socket)]);
  if (await realpath(parent) !== parent || !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o027)
    || !info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.gid !== directory.gid || (info.mode & 0o777) !== 0o660) throw new Error("裁剪 socket 权限无效");
  for (let ancestor = dirname(parent);;) {
    const entry = await lstat(ancestor);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022)) throw new Error("裁剪 socket 祖先不安全");
    const next = dirname(ancestor); if (next === ancestor) break; ancestor = next;
  }
  const libc = dlopen("libc.so.6", {
    getsockname: { args: [FFIType.int, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
    getsockopt: { args: [FFIType.int, FFIType.int, FFIType.int, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
  });
  const address = Buffer.alloc(110), length = Buffer.alloc(4), listening = Buffer.alloc(4), valueLength = Buffer.alloc(4);
  length.writeUInt32LE(address.length); valueLength.writeUInt32LE(4);
  if (libc.symbols.getsockname(3, ptr(address), ptr(length)) !== 0 || address.readUInt16LE(0) !== 1
    || address.subarray(2, length.readUInt32LE()).toString().replace(/\0+$/, "") !== socket
    || libc.symbols.getsockopt(3, 1, 30, ptr(listening), ptr(valueLength)) !== 0 || listening.readInt32LE() !== 1) throw new Error("裁剪监听描述符无效");

  let stopping = false;
  const http = createHttpServer(async (input, output) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.once("aborted", abort); output.once("close", () => { if (!output.writableFinished) abort(); });
    const timer = setTimeout(() => { abort(); output.destroy(); }, 240000);
    output.once("close", () => clearTimeout(timer));
    try {
      const contentLength = input.headers["content-length"];
      if (stopping || input.headers["transfer-encoding"] || Array.isArray(contentLength)
        || contentLength !== undefined && (!/^(0|[1-9][0-9]*)$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > maxBytes)) {
        output.writeHead(stopping ? 503 : 413, { connection: "close" }); output.end(); return;
      }
      const method = input.method ?? "GET", hasBody = method !== "GET" && method !== "HEAD";
      if (hasBody && contentLength === undefined) { output.writeHead(411, { connection: "close" }); output.end(); return; }
      const request = new Request(`http://localhost${input.url ?? "/"}`, {
        method, headers: input.headers as Record<string, string>, signal: controller.signal,
        ...(hasBody ? { body: Readable.toWeb(input) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
      } as RequestInit);
      const response = await fetch(request);
      output.writeHead(response.status, { ...Object.fromEntries(response.headers), connection: "close" });
      if (response.body) {
        const reader = response.body.getReader();
        const cancel = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener("abort", cancel, { once: true });
        try {
          if (controller.signal.aborted) cancel();
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            if (!output.write(value)) await new Promise<void>((ok, fail) => {
              const cleanup = () => { output.off("drain", drain); output.off("close", closed); output.off("error", closed); };
              const drain = () => { cleanup(); ok(); }, closed = () => { cleanup(); fail(new Error("响应已关闭")); };
              output.once("drain", drain); output.once("close", closed); output.once("error", closed);
              if (output.destroyed) closed();
            });
          }
        } finally { controller.signal.removeEventListener("abort", cancel); if (controller.signal.aborted) await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      output.end();
    } catch { if (!output.headersSent) { output.writeHead(503, { connection: "close" }); output.end(); } else output.destroy(); }
  });
  const server = createNetServer(connection => http.emit("connection", connection));
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen({ fd: 3 }, () => { server.off("error", fail); ok(); }); });
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    // 等在途 HTTP 流结束；超时则保留持久作业状态供核查，绝不释放未知任务锁。
    const timeout = setTimeout(() => process.exit(1), 245000);
    server.close(() => { clearTimeout(timeout); process.exit(0); });
  };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}
