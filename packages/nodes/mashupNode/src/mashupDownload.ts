import { makeZip } from "client-zip";
import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/runtime";
import type { MashupClip } from "./mashupBatch";

export async function downloadZip(files: WorkspaceFiles, results: MashupClip[]) {
  const filename = "混剪成片.zip";
  if (await files.downloadMashupZip?.(results.map(({ name, url }) => ({ name, path: url })))) return;

  async function* entries() {
    for (const result of results) {
      const input = await files.read(result.url).catch(() => {
        throw new Error(`无法读取成片「${result.name}」`);
      });
      if (!input.byteLength) throw new Error(`成片「${result.name}」为空`);
      yield { name: result.name, input };
    }
  }
  const blob = await new Response(makeZip(entries()), { headers: { "Content-Type": "application/zip" } }).blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
