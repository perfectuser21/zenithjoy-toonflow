import { isAbsolute, relative, sep } from "node:path";

export function workspaceTreesOverlap(a: string, b: string) {
  const within = (root: string, path: string) => {
    const offset = relative(root, path);
    return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
  };
  return within(a, b) || within(b, a);
}

export function sameTrimExportSnapshot(a: { operationId: string; state?: string }[], b: { operationId: string; state?: string }[]) {
  const stamp = (items: typeof a) => JSON.stringify(items.map(({ operationId, state }) => ({ operationId, state })).sort((x, y) => x.operationId.localeCompare(y.operationId)));
  return stamp(a) === stamp(b);
}

/** 将已确认的私有裁剪素材加入工作区导出；状态变化时拒绝导出不完整的项目。 */
export async function addManagedTrimToExport(
  files: Record<string, Uint8Array>, snapshot: { operationId: string; state?: string }[],
  limits: { entries: number; bytes: number; maxBytes: number },
  load: (path: string) => Promise<Uint8Array>,
  current: () => Promise<{ operationId: string; state?: string }[]>,
  authorize: () => Promise<boolean>,
  signal?: AbortSignal,
) {
  const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }); };
  if (snapshot.some(item => item.state !== "committed")) fail("项目中有尚未完成的裁剪，请完成或处理后再导出", 409);
  for (const record of snapshot) {
    signal?.throwIfAborted();
    const path = `assets/${record.operationId}/video.mp4`;
    if (files[path] || files[`${path}/`] || files.assets || files[`assets/${record.operationId}`]) fail("项目文件与裁剪素材路径冲突，不能安全导出", 409);
    if (++limits.entries > 10000) fail("项目导出最多包含 10000 个文件和目录", 413);
    const bytes = await load(path);
    signal?.throwIfAborted();
    limits.bytes += bytes.length;
    if (limits.bytes > limits.maxBytes) fail("项目文件总大小不能超过 1 GB", 413);
    files[path] = bytes;
  }
  signal?.throwIfAborted();
  if (!sameTrimExportSnapshot(await current(), snapshot) || !await authorize()) fail("项目在导出期间发生变化，请重试", 409);
}

/** 客户端先保存画布再请求裁剪；尚未入账的 pending 也不能作为完整项目导出。 */
export function assertCanvasTrimReady(path: string, bytes: Uint8Array): string[] {
  if (!path.toLowerCase().endsWith(".json")) return [];
  if (bytes.byteLength > 32 * 1024 * 1024) throw Object.assign(new Error("JSON 文件过大，无法安全检查画布，请处理后导出"), { status: 413 });
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8").replace(/^\uFEFF/, "");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return []; }
  const canvas = value as { toonflowCanvas?: unknown; nodes?: unknown } | null;
  if (canvas?.toonflowCanvas !== true) return [];
  if (!Array.isArray(canvas.nodes)) throw Object.assign(new Error("画布数据无法确认，请修复后导出"), { status: 409 });
  if (canvas.nodes.some(node => node && typeof node === "object" && node.data && typeof node.data === "object" && node.data.pendingTrim)) {
    throw Object.assign(new Error("画布中有尚未完成的裁剪，请处理后再导出"), { status: 409 });
  }
  const references = new Set<string>(), pending: unknown[] = [canvas.nodes];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string" && /^assets\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/video\.mp4$/.test(item)) references.add(item);
    else if (Array.isArray(item)) for (const value of item) pending.push(value);
    else if (item && typeof item === "object") for (const value of Object.values(item)) pending.push(value);
  }
  return [...references];
}
