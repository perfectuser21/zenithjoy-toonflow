import { expect, test } from "bun:test";
import { aliyunImageFailure, browserCanvasDiagnosticSchema, workspaceErrorDiagnostic } from "./diagnosticReport";

test("workspace errors identify the route and reason without retaining paths or error messages", () => {
  const failure = Object.assign(new Error("user-project.txt"), { code: "WORKSPACE_NOT_FOUND" });
  expect(workspaceErrorDiagnostic("/api/workspaces/files/list", 404, failure)).toEqual({
    event: "canvasWorkspaceError", operation: "list", status: 404, reason: "WORKSPACE_NOT_FOUND",
  });
  expect(workspaceErrorDiagnostic("/api/workspaces/files/read", 404, { code: "ENOENT" })?.reason).toBe("ENOENT");
  expect(workspaceErrorDiagnostic("/api/workspaces/files/write", 507, { code: "ENOSPC" })?.reason).toBe("ENOSPC");
  expect(workspaceErrorDiagnostic("/api/workspaces/files/read", 403, failure)).toBeUndefined();
  expect(workspaceErrorDiagnostic("/api/workspaces/files/mkdir", 409, { code: "EEXIST" })).toBeUndefined();
  expect(workspaceErrorDiagnostic("/api/workspaces/files/private-project.txt", 500, failure)).toBeUndefined();
});

test("browser reports accept only a predefined canvas failure stage", () => {
  for (const stage of ["load", "render", "save"]) {
    expect(browserCanvasDiagnosticSchema.safeParse({ stage }).success).toBe(true);
  }
  expect(browserCanvasDiagnosticSchema.safeParse({ stage: "render", message: "project contents" }).success).toBe(false);
  expect(browserCanvasDiagnosticSchema.safeParse({ stage: "private-path" }).success).toBe(false);
});

test("Aliyun terminal image failures retain only the status, safe code and a valid request ID", () => {
  const requestId = "9526edbf-b95f-4dea-bc9c-129c349eaef1";
  expect(aliyunImageFailure({
    request_id: requestId, output: { task_status: "FAILED", code: "DataInspectionFailed", message: "private prompt" },
  })).toEqual({ upstreamStatus: "FAILED", upstreamCode: "DataInspectionFailed", upstreamRequestId: requestId });
  expect(aliyunImageFailure({
    request_id: "Bearer secret", output: { task_status: "CANCELED", code: "invalid token", message: "private prompt" },
  })).toEqual({ upstreamStatus: "CANCELED" });
  expect(aliyunImageFailure({ output: { task_status: "RUNNING" } })).toBeUndefined();
});
