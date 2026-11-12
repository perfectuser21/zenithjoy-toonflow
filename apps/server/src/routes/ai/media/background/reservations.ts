import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { listOwnBackgroundReservations } from "@/utils/media/backgroundJobs";
import u from "@/utils";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096) }), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  const actor = u.multiTenant.requestIdentity(req);
  if (!actor) throw Object.assign(new Error("请先登录 Toonflow"), { status: 401 });
  res.set("Cache-Control", "no-store").json(success(await listOwnBackgroundReservations(cwd, actor, AbortSignal.timeout(30000))));
});
