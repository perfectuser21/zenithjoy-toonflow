import { lstat, readFile } from "@toonflow/file";
import { createHash } from "node:crypto";
import { sendFile } from "@/utils/fileHttp";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { requestIdentity } from "@/utils/multiTenant/runtime";
import { authenticateWeb } from "@/utils/multiTenant";
import { withManagedTrim } from "@/utils/media/trimVideo";

const router = Router();

export default router.get("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().max(4096), snapshot: z.enum(["true"]).optional(), maxBytes: z.coerce.number().int().positive().max(20 * 1024 * 1024).optional() }, "query"), async (req, res, next) => {
  const actor = requestIdentity(req);
  if (actor?.role === "user") {
    const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once("close", cancel);
    if (res.destroyed) cancel();
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
      const managed = await withManagedTrim(directory, actor.id, req.query.path as string, signal, async bytes => {
        const current = await authenticateWeb(req);
        if (!current || current.id !== actor.id || current.role !== "user" || await u.workspace.resolveWorkspace(req, req.query.directory as string) !== directory) throw Object.assign(new Error("账号或工作区权限已变化"), { status: 403 });
        if (req.query.snapshot === "true") throw Object.assign(new Error("视频不是文本文件"), { status: 415 });
        if (res.destroyed) return;
        res.set({ "Cache-Control": "no-store", "Accept-Ranges": "bytes" }).type("video/mp4");
        const acceptsRange = req.get("Range")?.startsWith("bytes=") && !req.get("If-Range");
        const range = acceptsRange ? req.range(bytes.length, { combine: true }) : undefined;
        if (range === -1) {
          res.set("Content-Range", `bytes */${bytes.length}`).status(416).end();
          return;
        }
        const single = Array.isArray(range) && range.type === "bytes" && range.length === 1 ? range[0] : undefined;
        const body = single ? bytes.subarray(single.start, single.end + 1) : bytes;
        if (single) res.set("Content-Range", `bytes ${single.start}-${single.end}/${bytes.length}`).status(206);
        await new Promise<void>(done => {
          const timer = setTimeout(() => { res.destroy(); finish(); }, 30000);
          const finish = () => {
            clearTimeout(timer);
            res.off("finish", finish);
            res.off("close", finish);
            done();
          };
          res.once("finish", finish);
          res.once("close", finish);
          if (single) res.set("Content-Length", String(body.length)).end(req.method === "HEAD" ? undefined : body);
          else res.send(body);
        });
      });
      if (managed.managed || res.destroyed) return;
    } catch (error) {
      if (!res.destroyed) throw error;
      return;
    } finally { res.off("close", cancel); }
  }
  const { path } = await u.workspaceFile.resolveWorkspaceFile(req, req.query.directory as string, req.query.path as string);
  const file = await lstat(path);
  if (!file.isFile()) throw Object.assign(new Error("只能读取文件"), { status: 400 });
  res.set("Cache-Control", "no-store");
  if (req.query.snapshot === "true") {
    const maxBytes = req.query.maxBytes === undefined ? undefined : Number(req.query.maxBytes);
    if (maxBytes !== undefined && file.size > maxBytes) throw Object.assign(new Error("文件超过本次文本读取的大小限制"), { status: 413 });
    const bytes = await readFile(path);
    if (maxBytes !== undefined && bytes.length > maxBytes) throw Object.assign(new Error("文件超过本次文本读取的大小限制"), { status: 413 });
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be"
        : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8-bom" : "utf-8";
    let text: string;
    try {
      text = new TextDecoder(encoding === "utf-8-bom" ? "utf-8" : encoding, { fatal: true }).decode(bytes);
      if (text.includes("\0")) throw new Error("binary");
    } catch {
      throw Object.assign(new Error("文件不是受支持的 UTF-8 或带 BOM 的 UTF-16 文本，请先用原编辑器转换编码后再打开，原文件未修改"), { status: 415 });
    }
    res.json(success({ text, encoding, revision: createHash("sha256").update(bytes).digest("hex") }));
    return;
  }
  await sendFile(res, path, { dotfiles: "allow" }, err => { if (err) next(err); });
});
