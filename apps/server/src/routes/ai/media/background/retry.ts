import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { retryGuidedBackgroundPart } from "@/utils/media/backgroundJobs";
import u from "@/utils";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  jobId: z.uuid(),
  partIndex: z.number().int().min(0).max(23),
  requestId: z.uuid(),
}), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  const actor = u.multiTenant.requestIdentity(req);
  if (!actor) throw Object.assign(new Error("请先登录 Toonflow"), { status: 401 });
  const result = await retryGuidedBackgroundPart(cwd, req.body.jobId, actor, req.body.partIndex, req.body.requestId);
  res.set("Cache-Control", "no-store").json(success(result));
});
