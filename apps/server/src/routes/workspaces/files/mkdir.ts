import { lstat, mkdir } from "@toonflow/file";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();
const creatingDirectories = new Map<string, Promise<void>>();

export default router.post("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().max(4096) }), async (req, res) => {
  const { directory, path } = await u.workspaceFile.resolveWorkspaceFile(req, req.body.directory, req.body.path);
  u.workspaceFile.protectWorkspaceRoot(directory, path);
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const key = process.platform === "win32" ? path.toLowerCase() : path;
  const creation = creatingDirectories.get(key);
  if (creation) await creation;
  if (existing || creation) throw Object.assign(new Error("已存在同名文件或目录"), { code: "EEXIST", path });
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  const pending = mkdir(path);
  creatingDirectories.set(key, pending);
  try { await pending; }
  finally { creatingDirectories.delete(key); release(); }
  res.json(success());
});
