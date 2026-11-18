import { Router } from "express";
import { z } from "zod";
import { errorFromCause, success } from "@/lib/responseFormat";
import { resolveWorkspace } from "@/utils/workspace";
import { requestIdentity } from "@/utils/multiTenant/runtime";
import { authenticateWeb } from "@/utils/multiTenant";
import { isEnabled } from "@/utils/multiTenant/mode";
import { listTrimRecoveries, releaseInterruptedTrimSpace, trimStatus, trimVideo } from "@/utils/media/trimVideo";
import { assertAppRequest } from "@/utils/mcp/control";
import { trimMode } from "@/utils/media/trimMode";
import { createTrimJobQueue } from "@/utils/media/trimJobQueue";

const requestSchema = z.strictObject({ directory: z.string().min(1).max(4096), operationId: z.uuidv4(), source: z.string().min(1).max(4096), start: z.number().finite().nonnegative(), end: z.number().finite().positive().max(120) });
const jobs = createTrimJobQueue();
function input(body: unknown) {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success || parsed.data.end <= parsed.data.start) throw Object.assign(new Error("裁剪参数无效"), { status: 400 });
  return parsed.data;
}

export default Router().get("/capabilities", async (req, res) => {
  assertAppRequest(req);
  if (!isEnabled() || !trimMode().read || process.env.TOONFLOW_SECURE_TRIM_SINGLE_INSTANCE !== "1") throw Object.assign(new Error("安全裁剪尚未开放"), { status: 503 });
  if (requestIdentity(req)?.role !== "user") throw Object.assign(new Error("请使用客户账号登录"), { status: 403 });
  res.set("Cache-Control", "no-store").json(success({ create: trimMode().create }));
}).post("/", async (req, res) => {
  assertAppRequest(req);
  if (!isEnabled() || !trimMode().read || process.env.TOONFLOW_SECURE_TRIM_SINGLE_INSTANCE !== "1") throw Object.assign(new Error("安全裁剪尚未开放"), { status: 503 });
  const actor = requestIdentity(req);
  if (actor?.role !== "user") throw Object.assign(new Error("请使用客户账号登录"), { status: 403 });
  const value = input(req.body);
  if (!trimMode().create) return res.status(503).set("Cache-Control", "no-store").json({ code: 503, message: "裁剪暂处于只读模式", data: { notSubmitted: true, operationId: value.operationId } });
  const cwd = await resolveWorkspace(req, value.directory);
  if (req.aborted || res.destroyed) return;
  const controller = new AbortController();
  const stream = req.accepts(["json", "text/event-stream"]) === "text/event-stream";
  const send = (data: unknown) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`); };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = () => { clearInterval(heartbeat); controller.abort(); };
  res.once("close", close);
  req.once("aborted", close);
  req.socket.once("close", close);
  try {
    if (await resolveWorkspace(req, value.directory) !== cwd) throw Object.assign(new Error("工作区已变化"), { status: 409 });
    const authorize = async () => {
      const current = await authenticateWeb(req);
      if (!current || current.role !== "user" || current.id !== actor.id || await resolveWorkspace(req, value.directory) !== cwd) throw Object.assign(new Error("账号或工作区权限已变化"), { status: 403 });
    };
    if (stream) {
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" }).flushHeaders();
      heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write(": waiting\n\n"); }, 10000);
    }
    const queueSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(360000)]);
    const result = await jobs.run({ ...value, cwd, ownerId: actor.id }, queueSignal, async () => {
      if (!trimMode().create) throw Object.assign(new Error("裁剪暂处于只读模式"), { status: 503 });
      return trimVideo(cwd, value.source, value.start, value.end, AbortSignal.any([controller.signal, AbortSignal.timeout(185000)]), actor.id, authorize, value.operationId);
    }, phase => { if (stream) send({ phase }); });
    if (stream) send({ result: success(result) });
    else if (!res.destroyed) res.set("Cache-Control", "no-store").json(success(result));
  } catch (cause) {
    if (!stream || !res.headersSent) throw cause;
    send({ result: errorFromCause(cause) });
  } finally {
    clearInterval(heartbeat);
    res.off("close", close);
    req.off("aborted", close);
    req.socket.off("close", close);
    if (stream && res.headersSent && !res.destroyed) res.end();
  }
}).post("/recoveries", async (req, res) => {
  assertAppRequest(req);
  if (!isEnabled() || !trimMode().read || process.env.TOONFLOW_SECURE_TRIM_SINGLE_INSTANCE !== "1") throw Object.assign(new Error("安全裁剪尚未开放"), { status: 503 });
  const actor = requestIdentity(req);
  if (actor?.role !== "user") throw Object.assign(new Error("请使用客户账号登录"), { status: 403 });
  const parsed = z.strictObject({ directory: z.string().min(1).max(4096) }).safeParse(req.body);
  if (!parsed.success) throw Object.assign(new Error("工作区参数无效"), { status: 400 });
  const cwd = await resolveWorkspace(req, parsed.data.directory);
  const result = await listTrimRecoveries(cwd, actor.id);
  const current = await authenticateWeb(req);
  if (!current || current.role !== "user" || current.id !== actor.id || await resolveWorkspace(req, parsed.data.directory) !== cwd) throw Object.assign(new Error("账号或工作区权限已变化"), { status: 403 });
  res.set("Cache-Control", "no-store").json(success(result));
}).post("/discard", async (req, res) => {
  assertAppRequest(req);
  if (!isEnabled() || !trimMode().create || process.env.TOONFLOW_SECURE_TRIM_SINGLE_INSTANCE !== "1") throw Object.assign(new Error("安全裁剪尚未开放"), { status: 503 });
  const actor = requestIdentity(req);
  if (actor?.role !== "user") throw Object.assign(new Error("请使用客户账号登录"), { status: 403 });
  const parsed = z.strictObject({ directory: z.string().min(1).max(4096), operationId: z.uuidv4(), confirm: z.literal(true) }).safeParse(req.body);
  if (!parsed.success) throw Object.assign(new Error("确认参数无效"), { status: 400 });
  const cwd = await resolveWorkspace(req, parsed.data.directory);
  const authorize = async () => {
    const current = await authenticateWeb(req);
    if (!current || current.role !== "user" || current.id !== actor.id || await resolveWorkspace(req, parsed.data.directory) !== cwd) throw Object.assign(new Error("账号或工作区权限已变化"), { status: 403 });
  };
  await authorize();
  await releaseInterruptedTrimSpace(cwd, actor.id, parsed.data.operationId, authorize);
  res.set("Cache-Control", "no-store").json(success({ released: true }));
}).post("/status", async (req, res) => {
  assertAppRequest(req);
  if (!isEnabled() || !trimMode().read || process.env.TOONFLOW_SECURE_TRIM_SINGLE_INSTANCE !== "1") throw Object.assign(new Error("安全裁剪尚未开放"), { status: 503 });
  const actor = requestIdentity(req);
  if (actor?.role !== "user") throw Object.assign(new Error("请使用客户账号登录"), { status: 403 });
  const value = input(req.body);
  const cwd = await resolveWorkspace(req, value.directory);
  const job = { ...value, cwd, ownerId: actor.id };
  const active = jobs.status(job);
  const result = active ? { status: "pending", phase: active } : await trimStatus(cwd, actor.id, value.operationId, value.source, value.start, value.end, trimMode().create);
  const current = await authenticateWeb(req);
  if (!current || current.role !== "user" || current.id !== actor.id || await resolveWorkspace(req, value.directory) !== cwd) throw Object.assign(new Error("账号或工作区权限已变化"), { status: 403 });
  res.set("Cache-Control", "no-store").json(success(result));
});
