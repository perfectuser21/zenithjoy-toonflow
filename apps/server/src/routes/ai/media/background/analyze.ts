import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { analyzeGuidedBackground } from "@/utils/media/backgroundJobs";
import u from "@/utils";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  videoPath: z.string().min(1).max(4096),
}), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  const actor = u.multiTenant.requestIdentity(req);
  if (!actor) throw Object.assign(new Error("请先登录 Toonflow"), { status: 401 });
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  try {
    const result = await analyzeGuidedBackground(cwd, req.body.videoPath, actor,
      AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]));
    res.set("Cache-Control", "no-store").json(success(result));
  } finally {
    res.off("close", close);
  }
});
