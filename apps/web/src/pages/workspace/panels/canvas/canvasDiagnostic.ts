import axios from "axios";

const diagnosticIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export async function describeCanvasFailure(stage: "load" | "render" | "save", cause: unknown, fallback: string) {
  const response = axios.isAxiosError<{ message?: string }>(cause) ? cause.response : undefined;
  const description = response?.data?.message || (cause instanceof Error ? cause.message : fallback);
  let diagnosticId: unknown = response?.headers["x-toonflow-diagnostic-id"];
  if (typeof diagnosticId !== "string" || !diagnosticIdPattern.test(diagnosticId)) {
    try {
      const { data } = await axios.post<{ data: { diagnosticId: string } }>("/api/workspaces/canvasDiagnostic", { stage }, {
        headers: { "x-toonflow-workspace": "1" }, timeout: 2500,
      });
      diagnosticId = data.data.diagnosticId;
    } catch {
      return description;
    }
  }
  return typeof diagnosticId === "string" && diagnosticIdPattern.test(diagnosticId)
    ? `${description}\n诊断编号 ${diagnosticId}`
    : description;
}
