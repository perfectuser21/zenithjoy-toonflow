import { z } from "zod";
import { Router } from "express";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { qianchuanJobRequest, readQianchuanJob } from "@/utils/media/qianchuanJobs";
import { requireQianchuanActor } from "@/utils/multiTenant/qianchuanOrganizations";

const request = z.strictObject(qianchuanJobRequest);

export default Router().post("/", validateFields({ ...qianchuanJobRequest }), async (req, res) => {
  const actor = await requireQianchuanActor(req);
  const { directory, jobId, organizationId, accountId } = request.parse(req.body);
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const result = await readQianchuanJob(cwd, actor, jobId, { organizationId, accountId });
  res.set("Cache-Control", "no-store").json(success(result));
});
