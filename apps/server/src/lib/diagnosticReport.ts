import { randomUUID } from "node:crypto";
import { z } from "zod";

const workspaceOperations = new Set(["list", "read", "write", "mkdir"]);
const workspaceReasons = new Set(["WORKSPACE_NOT_FOUND", "ENOENT", "ENOTDIR", "ENOSPC", "EDQUOT", "ESTALE"]);
const upstreamCodePattern = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const upstreamRequestIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export const browserCanvasDiagnosticSchema = z.strictObject({ stage: z.enum(["load", "render", "save"]) });

export function workspaceErrorDiagnostic(path: string, status: number, cause: unknown) {
  const prefix = "/api/workspaces/files/";
  if (!path.startsWith(prefix) || status < 400 || status === 401 || status === 403) return;
  const operation = path.slice(prefix.length).replace(/\/$/, "");
  if (!workspaceOperations.has(operation)) return;
  const code = (cause as { code?: unknown } | null)?.code;
  if (status === 409 && code === "EEXIST") return;
  const reason = typeof code === "string" && workspaceReasons.has(code) ? code : undefined;
  return { event: "canvasWorkspaceError", operation, status, reason };
}

export function reportDiagnostic(event: { event: string }) {
  const diagnosticId = randomUUID();
  console.info(JSON.stringify({ ...event, diagnosticId }));
  return diagnosticId;
}

export function aliyunImageFailure(value: unknown) {
  const data = value as { request_id?: unknown; output?: { task_status?: unknown; code?: unknown } } | null;
  const upstreamStatus = data?.output?.task_status;
  if (upstreamStatus !== "FAILED" && upstreamStatus !== "CANCELED") return;
  const code = data?.output?.code;
  const requestId = data?.request_id;
  return {
    upstreamStatus,
    ...(typeof code === "string" && upstreamCodePattern.test(code) ? { upstreamCode: code } : {}),
    ...(typeof requestId === "string" && upstreamRequestIdPattern.test(requestId) ? { upstreamRequestId: requestId } : {}),
  };
}
