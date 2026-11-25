import { open } from "@toonflow/file";
import { Router } from "express";
import { z } from "zod";
import { assertAppRequest } from "@/utils/mcp/control";
import { normalizeConcatVideo } from "@/utils/media/preview";
import { withManagedTrim } from "@/utils/media/trimVideo";
import { authenticateWeb } from "@/utils/multiTenant";
import { requestIdentity } from "@/utils/multiTenant/runtime";
import { resolveWorkspace } from "@/utils/workspace";
import { resolveWorkspacePath } from "@/utils/workspace/files";

const inputSchema = z.strictObject({ directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096) });
const maxBytes = 100 * 1024 * 1024;

export default Router().post("/", async (req, res) => {
  assertAppRequest(req);
  const input = inputSchema.safeParse(req.body);
  if (!input.success) throw Object.assign(new Error("视频素材参数无效"), { status: 400 });
  const { directory, path } = input.data;
  const cwd = await resolveWorkspace(req, directory);
  const actor = requestIdentity(req);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once("close", cancel);
  if (req.aborted || res.destroyed) cancel();
  async function checkAccess() {
    const current = actor?.role === "user" ? await authenticateWeb(req) : actor;
    if (current?.id !== actor?.id || current?.role !== actor?.role || await resolveWorkspace(req, directory) !== cwd) {
      throw Object.assign(new Error("账号或工作区权限已变化"), { status: 403 });
    }
  }
  try {
    const output = await normalizeConcatVideo(async signal => {
      await checkAccess();
      signal.throwIfAborted();
      if (actor?.role === "user") {
        const managed = await withManagedTrim(cwd, actor.id, path, signal, async bytes => bytes);
        if (managed.managed) return managed.value;
      }
      const source = await resolveWorkspacePath(cwd, path);
      const file = await open(source.path, "r");
      try {
        const info = await file.stat();
        if (!info.isFile() || !info.size || info.size > maxBytes) {
          throw Object.assign(new Error("视频素材须为不超过 100 MB 的非空文件"), { status: 413 });
        }
        const bytes = Buffer.allocUnsafe(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          signal.throwIfAborted();
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw Object.assign(new Error("原素材已变化，请重新读取"), { status: 409 });
          offset += bytesRead;
        }
        const current = await file.stat();
        if (info.size !== current.size || info.mtimeMs !== current.mtimeMs || info.ctimeMs !== current.ctimeMs) {
          throw Object.assign(new Error("原素材已变化，请重新读取"), { status: 409 });
        }
        return bytes;
      } finally { await file.close(); }
    }, controller.signal);
    await checkAccess();
    if (!res.destroyed) res.set({ "Content-Type": output.mimeType, "Cache-Control": "no-store" }).send(output.data);
  } finally { res.off("close", cancel); }
});
