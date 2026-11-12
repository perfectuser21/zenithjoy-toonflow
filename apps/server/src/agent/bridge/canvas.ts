import { canvasOperations, canvasSchemas } from "@toonflow/tool-canvas/runtime";
import { pluginDevelopmentSchema } from "@/lib/pluginDevelopment";
import type { CanvasInfo, CanvasContext, CanvasToolCall } from "@toonflow/tools-scaffold/runtime";
import { asrRequestSchema } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent } from "@/agent/runtime/types";
import { currentIdentity } from "@/utils/multiTenant/context";
import { verifyAgentCall } from "@/agent/runtime/sessions";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { readTrustedNode } from "@/utils/plugins/nodes";
import { readFile, stat } from "@toonflow/file";

type CanvasResult = { result?: unknown; error?: string; cancelled?: boolean; unavailable?: boolean };
type CallBinding = { ownerId: string; runId: string; sessionFile: string; canvasId: string };
type PendingCall = { cwd: string; binding?: CallBinding; finish(response: CanvasResult): void };

// ACT: 回传仅在当前 Server 进程存活期间有效；多进程部署需共享请求通道。
const pendingCalls = new Map<string, PendingCall>();

// 仅允许固定节点及已保存画布中符合端口规则的连接；客户端仍须检查当前画布。
export async function validateCandidateCanvasOperation(cwd: string, canvasId: string, request: { name: "addNode" | "connectNodes"; args: unknown }) {
  const names: Record<string, string> = { "remote-videoNode": "videoNode", "remote-textNode": "textNode", "remote-videoGenerationNode": "videoGenerationNode" };
  if (request.name === "addNode") {
    const args = canvasSchemas.addNode.parse(request.args);
    if (!Object.hasOwn(names, args.type) || !await readTrustedNode(names[args.type]!)) throw new Error("节点类型未通过可信校验");
    return {};
  }
  const { connections } = canvasSchemas.connectNodes.parse(request.args);
  const { path } = await resolveWorkspacePath(cwd, canvasId);
  const before = await stat(path);
  if (!before.isFile() || before.size > 256 * 1024 * 1024) throw new Error("画布文件无效或过大");
  const canvas: unknown = JSON.parse(await readFile(path, "utf8"));
  const after = await stat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Object.assign(new Error("画布正在保存，请重试"), { status: 409 });
  if (!canvas || typeof canvas !== "object" || !("toonflowCanvas" in canvas) || canvas.toonflowCanvas !== true || !("nodes" in canvas) || !Array.isArray(canvas.nodes)) throw new Error("画布文件无效");
  const nodes = new Map<string, string>();
  for (const node of canvas.nodes) {
    if (!node || typeof node !== "object" || typeof node.id !== "string" || typeof node.type !== "string" || nodes.has(node.id)) throw new Error("画布节点无效");
    nodes.set(node.id, node.type);
  }
  for (const connection of connections) {
    const source = nodes.get(connection.source);
    const target = nodes.get(connection.target);
    const allowed = source === "remote-videoNode" && connection.sourceHandle === "video" && ["remote-textNode", "remote-videoGenerationNode"].includes(target ?? "")
      || source === "remote-textNode" && connection.sourceHandle === "text" && target === "remote-videoGenerationNode";
    if (!allowed || connection.targetHandle !== "in" || !source || !target || !await readTrustedNode(names[source]!) || !await readTrustedNode(names[target]!)) throw new Error("节点连接未通过可信校验");
  }
  return Object.fromEntries(connections.flatMap(connection => [[connection.source, nodes.get(connection.source)!], [connection.target, nodes.get(connection.target)!]]));
}

export function createCanvasContext(cwd: string, canvas: CanvasInfo, send: (event: Extract<AgentEvent, { type: "canvasCall" }>) => void, onCancel: (reason: Error) => void, binding?: () => CallBinding) {
  const activeCalls = new Set<string>();
  let queue = Promise.resolve();
  let disposed = false;
  const context: CanvasContext = {
    ...canvas,
    async call(request, signal) {
      // 前端顺序执行画布变更；轮到当前调用再发送和计时，避免排队消耗执行超时。
      const pending = queue.then(async () => {
        if (disposed) throw new Error("画布调用所属对话已结束");
        signal?.throwIfAborted();
        let guard: CanvasToolCall["guard"];
        if (binding) {
          const reads = ["getCanvas", "findCanvasNodes", "getCanvasNodes", "getCanvasEdges"];
          if (![...reads, "addNode", "connectNodes"].includes(request.name)) throw new Error("当前账号不能执行此画布操作");
          if (binding().canvasId !== canvas.id || reads.includes(request.name) && (!("canvasId" in request.args) || request.args.canvasId !== canvas.id)) throw new Error("画布调用与本次会话不匹配");
          const nodeTypes = request.name === "addNode" || request.name === "connectNodes"
            ? await validateCandidateCanvasOperation(cwd, canvas.id, { name: request.name, args: request.args }) : undefined;
          guard = { canvasId: canvas.id, nodeTypes };
          if (disposed) throw new Error("画布调用所属对话已结束");
          signal?.throwIfAborted();
        }
        const schema = request.name === "developPlugin" ? pluginDevelopmentSchema
          : request.name === "transcribeAudio" ? asrRequestSchema : canvasOperations.find(item => item.name === request.name)?.parameters;
        if (!schema) throw new Error("画布操作不存在");
        const args = schema.parse(request.args);
        const callId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
          const finish = ({ result, error, cancelled, unavailable }: CanvasResult) => {
            if (!pendingCalls.delete(callId)) return;
            activeCalls.delete(callId);
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            if (error === undefined && !cancelled && !unavailable) { resolve(result); return; }
            const reason = new Error(error || (cancelled ? "画布调用已取消" : unavailable ? "画布不可用" : "画布调用失败"));
            reject(reason);
            if (cancelled || unavailable) {
              disposed = true;
              onCancel(reason);
            }
          };
          const abort = () => finish({ error: signal?.reason instanceof Error ? signal.reason.message : "画布调用已取消" });
          // ACT: 音频按实际时长播放，转写由浏览器检测停滞与收尾超时，仍接受本轮取消。
          const timer = request.name === "transcribeAudio" ? undefined : setTimeout(() => finish({ error: "画布调用超时，请确认画布仍然打开", unavailable: true }), request.name === "developPlugin" ? 360000 : 120000);
          pendingCalls.set(callId, { cwd, binding: binding?.(), finish });
          activeCalls.add(callId);
          signal?.addEventListener("abort", abort, { once: true });
          try { send({ type: "canvasCall", callId, name: request.name, args, ...(guard ? { guard } : {}) }); }
          catch (error) { finish({ error: (error instanceof Error ? error.message : "") || "发送画布调用失败", unavailable: true }); }
        });
      });
      queue = pending.then(() => {}, () => {});
      return pending;
    },
  };
  return {
    context,
    dispose() {
      disposed = true;
      for (const callId of activeCalls) pendingCalls.get(callId)?.finish({ error: "画布调用所属对话已结束" });
    },
  };
}

export function finishCanvasCall(cwd: string, callId: string, response: CanvasResult) {
  const pending = pendingCalls.get(callId);
  // 超时、取消或完成后仍可能收到回传，幂等忽略，避免中断整轮对话。
  if (!pending) {
    if (currentIdentity()?.role === "user") throw Object.assign(new Error("画布调用不存在或已结束"), { status: 404 });
    return;
  }
  if (pending.cwd !== cwd) throw Object.assign(new Error("画布调用不存在或已结束"), { status: 404 });
  if (currentIdentity()?.role === "user" && (!pending.binding || !verifyAgentCall(cwd, pending.binding))) throw Object.assign(new Error("画布调用不存在或已结束"), { status: 404 });
  if (currentIdentity()?.role === "user" && Buffer.byteLength(JSON.stringify(response), "utf8") > 65536) throw Object.assign(new Error("画布回执过大"), { status: 400 });
  pending.finish(response);
}
