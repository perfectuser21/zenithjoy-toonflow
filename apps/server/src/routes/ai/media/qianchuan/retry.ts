import { Router } from "express";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { qianchuanJobRequest, retryQianchuanJob } from "@/utils/media/qianchuanJobs";

export default Router().post("/", validateFields({ ...qianchuanJobRequest }), async (req, res) => {
  const actor = u.multiTenant.requestIdentity(req);
  if (!actor) throw Object.assign(new Error("请先登录 Toonflow"), { status: 401 });
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  const result = await retryQianchuanJob(cwd, actor, req.body.jobId);
  res.set("Cache-Control", "no-store").json(success(result));
});
