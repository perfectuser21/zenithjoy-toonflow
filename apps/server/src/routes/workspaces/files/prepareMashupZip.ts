import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { mashupZipActor, prepareMashupZip } from "@/utils/workspace/mashupZip";

const inputSchema = z.strictObject({
  directory: z.string().min(1).max(4096),
  items: z.array(z.strictObject({
    name: z.string().min(5).max(255).regex(/^[^<>:"/\\|?*\x00-\x1f\x7f]+\.mp4$/i),
    path: z.string().min(1).max(4096).regex(/\.mp4$/i),
  })).min(1).max(1000),
});

export default Router().post("/", validateFields(inputSchema.shape), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const actor = await mashupZipActor(req);
  const input = inputSchema.parse(req.body);
  const directory = await u.workspace.resolveWorkspace(req, input.directory);
  const ticket = await prepareMashupZip(actor, directory, input.items);
  res.set("Cache-Control", "no-store").json(success({ ticket }));
});
