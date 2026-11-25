import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { prepareBackgroundJob } from "@/utils/media/backgroundJobs";
import u from "@/utils";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), videoPath: z.string().min(1).max(4096), jobId: z.uuid(), cuts: z.array(z.number().finite().positive().max(120)).max(23).optional(), sourceRevision: z.string().min(1).max(160).optional() }), async (req, res) => {
  const { cuts, sourceRevision } = req.body;
  if ((cuts === undefined) !== (sourceRevision === undefined)) throw Object.assign(new Error("分镜切点与原片版本必须一同提交"), { status: 400 });
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  const actor = u.multiTenant.requestIdentity(req);
  if (!actor) throw Object.assign(new Error("请先登录 Toonflow"), { status: 401 });
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  try {
    const result = await prepareBackgroundJob(cwd, req.body.videoPath, actor, AbortSignal.any([controller.signal, AbortSignal.timeout(1800000)]), req.body.jobId, cuts && sourceRevision ? { cuts, sourceRevision } : undefined);
    res.set("Cache-Control", "no-store").json(success(result));
  } finally { res.off("close", close); }
});
