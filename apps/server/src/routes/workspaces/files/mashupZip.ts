import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import u from "@/utils";
import { assertMashupZipNavigation, mashupZipActor, releaseMashupZip, streamMashupZip, takeMashupZip } from "@/utils/workspace/mashupZip";

const querySchema = z.object({ ticket: z.uuid() });

export default Router().get("/", validateFields(querySchema.shape, "query"), async (req, res) => {
  if (req.method !== "GET") return res.sendStatus(405);
  assertMashupZipNavigation(req);
  const actor = await mashupZipActor(req);
  const batch = takeMashupZip(querySchema.parse(req.query).ticket, actor);
  try {
    const directory = await u.workspace.resolveWorkspace(req, batch.directory);
    await streamMashupZip(batch, directory, res);
  } finally {
    releaseMashupZip(batch);
  }
});
