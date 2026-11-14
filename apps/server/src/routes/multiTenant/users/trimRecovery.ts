import { Router } from "express";
import { z } from "zod";
import { dirname } from "node:path";
import { listDisabledUnknownTrims, openDatabase } from "@toonflow/multi-tenant-db";
import { success } from "@/lib/responseFormat";
import conf from "@/utils/conf";
import { authenticateHost, authorize } from "@/utils/multiTenant";
import { recoverDisabledUnknownTrim } from "@/utils/media/trimVideo";

const inputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list"), userId: z.uuid() }),
  z.strictObject({ action: z.literal("release"), userId: z.uuid(), workspaceHash: z.string().regex(/^[a-f0-9]{64}$/), operationId: z.uuidv4(), reason: z.string().trim().min(16).max(500), confirm: z.literal(true) }),
]);

// 管理端与创作端隔离；只处理指定停用账号，绝不以该账号身份登录。
export default Router().post("/", async (req, res) => {
  await authorize(req);
  const actor = authenticateHost(req) ? "host" as const : "admin:1" as const;
  const authorizeAgain = async () => {
    await authorize(req);
    if ((authenticateHost(req) ? "host" : "admin:1") !== actor) throw Object.assign(new Error("管理身份已变化"), { status: 403 });
  };
  const input = inputSchema.parse(req.body);
  if (input.action === "release") {
    const result = await recoverDisabledUnknownTrim(input.userId, input.workspaceHash, input.operationId, input.reason, actor, authorizeAgain);
    await authorizeAgain();
    return res.status(result.status === "cancelling" ? 202 : 200).set("Cache-Control", "no-store").json(success(result));
  }
  const db = await openDatabase(dirname(conf.path), false).catch(() => undefined);
  if (!db) throw Object.assign(new Error("裁剪资源存储不可用"), { status: 503 });
  try {
    const items = await listDisabledUnknownTrims(db, input.userId).catch((error: { status?: number }) => {
      if (error.status === 409) throw error;
      throw Object.assign(new Error("裁剪资源存储不可用"), { status: 503 });
    });
    await authorizeAgain();
    return res.set("Cache-Control", "no-store").json(success({ items }));
  } finally { await db.close(); }
});
