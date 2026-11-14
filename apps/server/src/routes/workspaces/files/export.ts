import { lstat, open, readdir, realpath } from "@toonflow/file";
import { Router } from "express";
import { zip } from "fflate";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import u from "@/utils";
import conf from "@/utils/conf";
import { getRuntimePlatform } from "@/lib/platform";
import { validateFields } from "@/lib/middleware";
import { currentIdentity } from "@/utils/multiTenant/context";
import { trimMode } from "@/utils/media/trimMode";
import { lockWorkspaceFiles } from "@/utils/workspace/files";
import { authenticateWeb } from "@/utils/multiTenant";
import { listTrimRecoveries, withManagedTrim } from "@/utils/media/trimVideo";
import { addManagedTrimToExport, assertCanvasTrimReady, sameTrimExportSnapshot, workspaceTreesOverlap } from "@/utils/media/managedTrimExport";

const router = Router();
// ACT: 当前在内存中打包，与桌面和移动端保存入口统一限制为 1 GB；更大项目需改为流式打包和保存。
const maxBytes = 1024 * 1024 * 1024;

export default router.get("/", validateFields({ directory: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  const releaseWorkspace = lockWorkspaceFiles([directory]);
  try {
  const controller = new AbortController();
  res.once("close", () => controller.abort());
  const quotaRoot = process.env.TOONFLOW_PROJECT_QUOTA_ROOT;
  if (quotaRoot) {
    const info = await lstat(resolve(quotaRoot, "privateTrim")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info && (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0)) throw Object.assign(new Error("裁剪存储状态异常，不能安全导出"), { status: 503 });
  }
  const actor = currentIdentity();
  if (!quotaRoot && actor?.role === "user" && req.res?.locals.multiTenantWeb === true) {
    throw Object.assign(new Error("用户存储配置缺失，无法安全导出"), { status: 503 });
  }
  if (!quotaRoot && actor?.role === "admin" && conf.get("settings", {}).multiTenantEnabled === true
    && process.env.NODE_ENV !== "dev" && !getRuntimePlatform().desktop) {
    throw Object.assign(new Error("用户存储配置缺失，无法安全导出"), { status: 503 });
  }
  if (!trimMode().read && actor?.role === "user" && quotaRoot) throw Object.assign(new Error("裁剪功能暂未开放，无法安全导出项目"), { status: 503 });
  if (actor?.role !== "user" && quotaRoot) {
    const workspaces = resolve(quotaRoot, "quotaWorkspaces");
    if (workspaceTreesOverlap(workspaces, directory)) throw Object.assign(new Error("请使用项目所属账号导出，避免遗漏裁剪素材"), { status: 403 });
  }
  const managedOwner = trimMode().read && actor?.role === "user" ? actor.id : undefined;
  const stillAuthorized = async () => {
    if (!managedOwner) return true;
    const current = await authenticateWeb(req);
    return !!current && current.role === "user" && current.id === managedOwner
      && await u.workspace.resolveWorkspace(req, req.query.directory as string) === directory;
  };
  if (!await stillAuthorized()) throw Object.assign(new Error("账号或工作区权限已变化"), { status: 403 });
  const snapshot = managedOwner ? await listTrimRecoveries(directory, managedOwner) : [];
  if (snapshot.some(item => item.state !== "committed")) throw Object.assign(new Error("项目中有尚未完成的裁剪，请完成或处理后再导出"), { status: 409 });
  const files: Record<string, Uint8Array> = Object.create(null);
  const canvasTrimReferences = new Set<string>();
  let entries = 0;
  let totalBytes = 0;

  async function collectFiles(path: string, prefix = "") {
    for (const child of await readdir(path, { withFileTypes: true })) {
      if (res.destroyed) throw new Error("项目导出已取消");
      if (++entries > 10000) throw Object.assign(new Error("项目导出最多包含 10000 个文件和目录"), { status: 413 });
      if (/[\\:]/.test(child.name)) throw Object.assign(new Error("项目包含无法安全导出为 ZIP 的文件名"), { status: 400 });
      const filePath = join(path, child.name);
      const archivePath = prefix ? `${prefix}/${child.name}` : child.name;
      const info = await lstat(filePath);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
        throw Object.assign(new Error("项目不能包含符号链接或特殊文件"), { status: 400 });
      }
      const actualPath = await realpath(filePath);
      if (!u.workspaceFile.isWithin(directory, actualPath)) throw Object.assign(new Error("项目文件超出工作区范围"), { status: 403 });
      if (info.isDirectory()) {
        files[`${archivePath}/`] = new Uint8Array();
        await collectFiles(actualPath, archivePath);
        continue;
      }
      if (totalBytes + info.size > maxBytes) throw Object.assign(new Error("项目文件总大小不能超过 1 GB"), { status: 413 });
      const file = await open(actualPath, "r");
      try {
        const current = await file.stat();
        if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size
          || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) {
          throw Object.assign(new Error("项目文件在导出期间发生变化，请重试"), { status: 409 });
        }
        const chunks: Buffer[] = [];
        for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
          if (res.destroyed) throw new Error("项目导出已取消");
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) throw Object.assign(new Error("项目文件总大小不能超过 1 GB"), { status: 413 });
          chunks.push(chunk);
        }
        const after = await file.stat();
        if (!after.isFile() || after.dev !== current.dev || after.ino !== current.ino || after.size !== current.size
          || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs
          || chunks.reduce((size, chunk) => size + chunk.length, 0) !== current.size) {
          throw Object.assign(new Error("项目文件在导出期间发生变化，请重试"), { status: 409 });
        }
        files[archivePath] = Buffer.concat(chunks);
        if (managedOwner) for (const reference of assertCanvasTrimReady(archivePath, files[archivePath])) canvasTrimReferences.add(reference);
      } finally { await file.close(); }
    }
  }

  await collectFiles(directory);
  if (managedOwner) {
    await addManagedTrimToExport(files, snapshot, { entries, bytes: totalBytes, maxBytes }, async path => {
      controller.signal.throwIfAborted();
      const result = await withManagedTrim(directory, managedOwner, path, AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]), async bytes => bytes);
      if (!result.managed) throw Object.assign(new Error("裁剪素材已变化，请重试导出"), { status: 409 });
      return result.value;
    }, () => listTrimRecoveries(directory, managedOwner), stillAuthorized, controller.signal);
  }
  for (const reference of canvasTrimReferences) {
    if (!files[reference]?.length) throw Object.assign(new Error("画布引用的视频素材缺失或为空，无法安全导出"), { status: 409 });
  }
  if (res.destroyed) return;
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    let cancel: (() => void) | undefined;
    function handleClose() {
      cancel?.();
      reject(new Error("项目导出已取消"));
    }
    res.once("close", handleClose);
    cancel = zip(files, { level: 1 }, (error, data) => {
      res.off("close", handleClose);
      if (error) reject(error);
      else resolve(data);
    });
  });
  if (managedOwner && (!sameTrimExportSnapshot(await listTrimRecoveries(directory, managedOwner), snapshot)
    || !await stillAuthorized())) {
    throw Object.assign(new Error("项目在导出期间发生变化，请重试"), { status: 409 });
  }
  if (bytes.byteLength > maxBytes) throw Object.assign(new Error("项目 ZIP 文件不能超过 1 GB"), { status: 413 });
  res.set("Cache-Control", "no-store").attachment(`${basename(directory) || "项目"}.zip`).send(Buffer.from(bytes));
  } finally { releaseWorkspace(); }
});
