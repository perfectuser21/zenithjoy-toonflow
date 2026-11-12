import { Router } from "express";
import { z } from "zod";
import { lstat } from "@toonflow/file";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { createBackgroundFrame } from "@/utils/media/backgroundJobs";
import u from "@/utils";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096), videoPath: z.string().min(1).max(4096),
  timeSeconds: z.number().finite().min(0).max(86400),
}), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  const actor = u.multiTenant.requestIdentity(req);
  if (!actor) throw Object.assign(new Error("请先登录 Toonflow"), { status: 401 });
  const source = await u.workspaceFile.resolveWorkspacePath(cwd, req.body.videoPath);
  const info = await lstat(source.path);
  if (!info.isFile() || !info.size) throw Object.assign(new Error("视频须为非空的普通文件"), { status: 400 });
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  try {
    const frame = await createBackgroundFrame(cwd, req.body.videoPath, req.body.timeSeconds, actor, controller.signal);
    res.set("Cache-Control", "no-store").json(success(frame));
  } finally { res.off("close", close); }
});
