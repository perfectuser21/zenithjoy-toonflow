import { Router } from "express";
import { browserCanvasDiagnosticSchema, reportDiagnostic } from "@/lib/diagnosticReport";
import { error, success } from "@/lib/responseFormat";
import { assertAppRequest } from "@/utils/mcp/control";

let windowStarted = 0;
let reports = 0;

export default Router().post("/", (req, res) => {
  assertAppRequest(req);
  const parsed = browserCanvasDiagnosticSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(error("画布诊断参数无效", null, 400));
  const now = Date.now();
  if (now - windowStarted >= 60_000) {
    windowStarted = now;
    reports = 0;
  }
  // ACT: 每进程总量上限，避免浏览器异常循环淹没服务日志。
  if (reports >= 120) return res.status(429).json(error("画布诊断提交过于频繁", null, 429));
  reports++;
  const diagnosticId = reportDiagnostic({ ...parsed.data, event: "canvasBrowserError" });
  return res.set("Cache-Control", "no-store").json(success({ diagnosticId }));
});
