import { makeZip } from "client-zip";
import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/runtime";
import type { MashupClip } from "./mashupBatch";

type SavePicker = (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;

export async function downloadZip(files: WorkspaceFiles, results: MashupClip[]) {
  const filename = "混剪成片.zip";
  async function* entries() {
    for (const result of results) yield { name: result.name, input: await files.read(result.url) };
  }
  const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker) {
    let handle: FileSystemFileHandle;
    try { handle = await picker.call(window, { suggestedName: filename }); }
    catch (error) { if (error instanceof DOMException && error.name === "AbortError") return; throw error; }
    await makeZip(entries()).pipeTo(await handle.createWritable());
    return;
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
