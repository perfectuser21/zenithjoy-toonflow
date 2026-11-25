import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { requestIdentity } from "@/utils/multiTenant/runtime";
import { isLocalWorkspaceRequest, resolveWorkspace } from "@/utils/workspace";
import { ipCardPreset, renderIpCard } from "@/utils/ipCard/render";

const input = z.strictObject({ directory: z.string().min(1).max(4096), preset: ipCardPreset });

export default Router().post("/", validateFields(input.shape), async (req, res) => {
  if (!requestIdentity(req) && !isLocalWorkspaceRequest(req)) {
    throw Object.assign(new Error("请从已登录的画布工作区操作"), { status: 403 });
  }
  const { directory, preset } = input.parse(req.body);
  await resolveWorkspace(req, directory);
  const png = await renderIpCard(preset);
  res.set("Cache-Control", "no-store").type("png").send(png);
});
