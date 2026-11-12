import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { readOwnProviderKeyStatus, saveOwnProviderKey, unbindOwnProviderKey } from "@/utils/multiTenant/userProviderKeys";

export default Router()
  .get("/", async (req, res) => {
    res.set("Cache-Control", "no-store").json(success(await readOwnProviderKeyStatus(req)));
  })
  .put("/", validateFields({
    apiKey: z.string().trim().min(1).max(4096),
    expectedRevision: z.number().int().min(0).max(2147483647),
  }), async (req, res) => {
    res.set("Cache-Control", "no-store").json(success(await saveOwnProviderKey(req, req.body.apiKey, req.body.expectedRevision)));
  })
  .post("/unbind", validateFields({ expectedRevision: z.number().int().min(0).max(2147483646) }), async (req, res) => {
    res.set("Cache-Control", "no-store").json(success(await unbindOwnProviderKey(req, req.body.expectedRevision)));
  });
