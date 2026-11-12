import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { confirmBackgroundJob } from "@/utils/media/backgroundJobs";
import u from "@/utils";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), jobId: z.uuid(), confirmed: z.literal(true),
  image: z.strictObject({ path: z.string().min(1).max(4096), mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/i) }),
  modelId: z.string().min(1).max(256), prompt: z.string().trim().min(1).max(100000) }), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  const actor = u.multiTenant.requestIdentity(req);
  if (!actor) throw Object.assign(new Error("请先登录 Toonflow"), { status: 401 });
  res.set("Cache-Control", "no-store").json(success(await confirmBackgroundJob(cwd, req.body.jobId, actor,
    { image: req.body.image, modelId: req.body.modelId, prompt: req.body.prompt })));
});
