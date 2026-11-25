import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { assertAppRequest } from "@/utils/mcp/control";
import { resolveWorkspace } from "@/utils/workspace";
import { ipCardPreset } from "@toonflow/node-ip-card/preset";
import { renderIpCard } from "@toonflow/node-ip-card/render";

const input = z.strictObject({ directory: z.string().min(1).max(4096), preset: ipCardPreset });

export default Router().post("/", validateFields(input.shape), async (req, res) => {
  assertAppRequest(req);
  const { directory, preset } = input.parse(req.body);
  await resolveWorkspace(req, directory);
  const png = await renderIpCard(preset);
  res.set("Cache-Control", "no-store").type("png").send(png);
});
