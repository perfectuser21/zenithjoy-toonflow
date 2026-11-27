import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rename, unlink, writeAtomic, writeFile } from "@toonflow/file";
import { resolve } from "node:path";

export const trustedNodeNames: Readonly<Record<string, string>> = {
  videoNode: "视频",
  frameAnalysisNode: "逐帧拉片",
  textNode: "文本",
  skillNode: "Skill",
  videoGenerationNode: "视频生成",
  imageNode: "图片",
  ipCardNode: "IP 卡片改版",
  ipWorkflowNode: "IP 五步工作流",
  imageGenerationNode: "图片生成",
  mashupNode: "批量混剪",
  qianchuanUploadNode: "千川素材上传",
  videoConcatNode: "合成成片",
};

export async function initializeTrustedNodes(targetDirectory: string, sourceDirectory: string) {
  const files = Object.keys(trustedNodeNames).map(name => `${name}.umd.js`);
  await syncBundledNodes(targetDirectory, sourceDirectory, files, "trustedNodesRevision");
}

export async function initializeHostedSharedCanvasNodes(targetDirectory: string, sourceDirectory: string) {
  await syncBundledNodes(targetDirectory, sourceDirectory, [
    "frameAnalysisNode.umd.js", "videoNode.umd.js", "ipCardNode.umd.js", "ipWorkflowNode.umd.js", "skillNode.umd.js", "videoGenerationNode.umd.js", "mashupNode.umd.js", "videoConcatNode.umd.js",
  ], "hostedSharedNodesRevision");
}

async function syncBundledNodes(targetDirectory: string, sourceDirectory: string, files: readonly string[], marker: string) {
  const revision = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(resolve(sourceDirectory, file));
    revision.update(file).update("\0").update(createHash("sha256").update(bytes).digest());
  }
  await initializePlugins(targetDirectory, sourceDirectory, files, revision.digest("hex"), marker);
}

export default async function initializePlugins(
  targetDirectory: string, sourceDirectory: string, fileFilter?: RegExp | readonly string[], revision?: string, markerName = "initialized",
) {
  const marker = resolve(targetDirectory, markerName);
  const initialized = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (initialized !== null && (revision === undefined || initialized === revision)) return;

  const entries = await readdir(sourceDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!entries) return;
  await mkdir(targetDirectory, { recursive: true });
  const files = entries.filter(file => fileFilter
    ? file.isFile() && (fileFilter instanceof RegExp ? fileFilter.test(file.name) : fileFilter.includes(file.name))
    : file.isDirectory());
  if (!files.length && revision === undefined) return;
  for (const file of files) {
    const source = resolve(sourceDirectory, file.name);
    const target = resolve(targetDirectory, file.name);
    if (revision === undefined) {
      await cp(source, target, { recursive: true, force: false });
      continue;
    }
    // ACT: 版本同步仅覆盖匹配的内置单文件；同目录 rename 保留失败时的旧文件。
    const temporary = resolve(targetDirectory, `.pluginSync${crypto.randomUUID()}`);
    try {
      await copyFile(source, temporary);
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
        if (cleanupError.code !== "ENOENT") console.warn(`插件同步临时文件清理失败：${temporary}`, cleanupError);
      });
      throw error;
    }
  }
  // 同一构建只同步一次；安装器移除标记以支持同版本重装，构建变化支持升级和降级。
  await (revision === undefined ? writeFile(marker, "", { flag: "wx" }) : writeAtomic(marker, revision, { mode: 0o666 })).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}
