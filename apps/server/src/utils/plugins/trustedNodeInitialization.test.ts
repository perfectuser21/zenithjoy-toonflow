import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "@toonflow/file";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeTrustedNodes } from "./initialize";

test("existing workspaces receive trusted nodes from each release", async () => {
  const root = await mkdtemp(join(tmpdir(), "toonflowTrustedNodes"));
  try {
    const source = join(root, "build");
    const target = join(root, "nodes");
    await mkdir(source);
    await mkdir(target);
    const nodeFiles = ["videoNode.umd.js", "textNode.umd.js", "videoGenerationNode.umd.js"];
    for (const file of nodeFiles) {
      await writeFile(join(source, file), `candidate:${file}`);
      await writeFile(join(target, file), `old:${file}`);
    }
    await writeFile(join(target, "initialized"), "existing workspace");
    await writeFile(join(target, "textNode.disabled"), "");
    await writeFile(join(source, "customNode.umd.js"), "bundled");
    await writeFile(join(target, "customNode.umd.js"), "customized");
    await initializeTrustedNodes(target, source);
    for (const file of nodeFiles) {
      expect(await readFile(join(target, file), "utf8")).toBe(`candidate:${file}`);
    }
    await writeFile(join(source, "videoNode.umd.js"), "next release");
    await initializeTrustedNodes(target, source);
    expect(await readFile(join(target, "videoNode.umd.js"), "utf8")).toBe("next release");
    expect(await readFile(join(target, "customNode.umd.js"), "utf8")).toBe("customized");
    expect(await readFile(join(target, "initialized"), "utf8")).toBe("existing workspace");
    expect(await readFile(join(target, "textNode.disabled"), "utf8")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
