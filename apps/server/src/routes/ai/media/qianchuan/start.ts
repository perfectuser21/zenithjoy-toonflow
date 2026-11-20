import { z } from "zod";
import { Router } from "express";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { qianchuanBatchItems, qianchuanJobRequest, startQianchuanJob } from "@/utils/media/qianchuanJobs";
import { requireQianchuanActor } from "@/utils/multiTenant/qianchuanOrganizations";

const request = z.strictObject({ ...qianchuanJobRequest, items: qianchuanBatchItems });

export default Router().post("/", validateFields({ ...qianchuanJobRequest, items: qianchuanBatchItems }), async (req, res) => {
  const actor = requireQianchuanActor(req);
  const { directory, jobId, organizationId, accountId, items } = request.parse(req.body);
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const result = await startQianchuanJob(cwd, actor, jobId, { organizationId, accountId }, items);
  res.set("Cache-Control", "no-store").json(success(result));
});
