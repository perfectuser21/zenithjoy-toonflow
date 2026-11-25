import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { analyzeGuidedBackground, checkBackgroundSource } from "@/utils/media/backgroundJobs";
import u from "@/utils";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  videoPath: z.string().min(1).max(4096),
  expectedSourceRevision: z.string().min(1).max(160).optional(),
}), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  const actor = u.multiTenant.requestIdentity(req);
  if (!actor) throw Object.assign(new Error("请先登录 Toonflow"), { status: 401 });
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  try {
    const { videoPath, expectedSourceRevision } = req.body;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]);
    const result = expectedSourceRevision === undefined
      ? await analyzeGuidedBackground(cwd, videoPath, actor, signal)
      : await checkBackgroundSource(cwd, videoPath, expectedSourceRevision, actor, signal);
    res.set("Cache-Control", "no-store").json(success(result));
  } finally {
    res.off("close", close);
  }
});
