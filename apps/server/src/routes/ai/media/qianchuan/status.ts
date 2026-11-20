import { z } from "zod";
import { Router } from "express";
import { validateFields } from "@/lib/middleware";
import { assertAppRequest } from "@/utils/mcp/control";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { qianchuanJobRequest, readQianchuanJob } from "@/utils/media/qianchuanJobs";

const request = z.strictObject(qianchuanJobRequest);

export default Router().post("/", validateFields({ ...qianchuanJobRequest }), async (req, res) => {
  assertAppRequest(req);
  const actor = u.multiTenant.requestIdentity(req);
  if (actor?.role !== "user") throw Object.assign(new Error("请先登录 Toonflow"), { status: 401 });
  const { directory, jobId, organizationId, accountId } = request.parse(req.body);
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const result = await readQianchuanJob(cwd, actor, jobId, { organizationId, accountId });
  res.set("Cache-Control", "no-store").json(success(result));
});
