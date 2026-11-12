import { $ } from "bun";
import { cp, mkdir, realpath, rm, readdir } from "@toonflow/file";
import { dirname, relative, resolve, sep } from "node:path";
import config from "../../../electrobun.config";
import copyDocumentPackages from "./copyDocumentPackages";
import copySandboxPackages from "./copySandboxPackages";
import { createHash } from "node:crypto";
import { readFile } from "@toonflow/file";

const projectDir = resolve(import.meta.dirname, "../../..");
if (process.env.TOONFLOW_RELEASE_PREREQUISITES !== "1") {
  // 所有直接构建入口也先重新生成节点和网页，避免把旧产物的摘要固化进新服务端。
  await $`${process.execPath} run build:server`.cwd(projectDir);
  process.exit(0);
}
const outputDirectory = resolve(projectDir, "build/server");
const trustedNodeNames = ["videoNode", "textNode", "videoGenerationNode"];
const trustedNodeHashes: Record<string, string> = {};
for (const name of trustedNodeNames) {
  const bytes = await readFile(resolve(projectDir, `build/nodes/${name}.umd.js`));
  if (!bytes.byteLength) throw new Error(`审计节点 ${name} 构建产物为空`);
  trustedNodeHashes[name] = createHash("sha256").update(bytes).digest("hex");
}
const webDirectory = resolve(projectDir, "build/web");
const trustedWebHashes: Record<string, string> = {};
async function hashWebDirectory(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await hashWebDirectory(path);
    else if (entry.isFile()) trustedWebHashes[relative(webDirectory, path).split(sep).join("/")] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
}
await hashWebDirectory(webDirectory);
if (!trustedWebHashes["index.html"]) throw new Error("缺少网页构建产物 index.html，请先构建网页");
const agentDirectory = dirname(await realpath(Bun.resolveSync("@earendil-works/pi-coding-agent", resolve(projectDir, "apps/server"))));
const photonDirectory = dirname(Bun.resolveSync("@silvia-odwyer/photon-node", agentDirectory));
// ACT: 团队暂不打包，恢复时取消注释。
// await $`${process.execPath} run build:teams`.cwd(projectDir);
await $`${process.execPath} run build`.cwd(resolve(projectDir, "packages/mcp"));
await mkdir(outputDirectory, { recursive: true });
// ACT: 移除旧版构建遗留的宿主 SDK，避免增量构建继续把它带入发布目录。
await rm(resolve(outputDirectory, "pluginSdk"), { recursive: true, force: true });
// ACT: Photon、anydoc 与沙盒依赖保留运行时目录，WASM/Worker 不依赖源码目录或启动位置。
await $`${process.execPath} build src/index.ts --target=bun --minify --external @silvia-odwyer/photon-node --external @firecrawl/anydoc --external @firecrawl/anydoc-wasm --external just-bash --define ${`process.env.appVersion:${JSON.stringify(config.app.version)}`} --define ${`__toonflowNodeHashes__:${JSON.stringify(trustedNodeHashes)}`} --define ${`__toonflowWebHashes__:${JSON.stringify(trustedWebHashes)}`} --outdir ${outputDirectory}`.cwd(resolve(projectDir, "apps/server"));
await $`${process.execPath} build packages/ffmpeg/src/ffmpegWorker.ts --target=bun --minify --outdir ${outputDirectory}`.cwd(projectDir);
await $`${process.execPath} build packages/multiTenant/models/migrateUserProviderKeys.ts --target=bun --minify --outdir ${outputDirectory}`.cwd(projectDir);
await $`${process.execPath} build packages/multiTenant/db/migrateBackgroundJobs.ts --target=bun --minify --outdir ${outputDirectory}`.cwd(projectDir);
await $`${process.execPath} build packages/multiTenant/db/reconcileOrphanPrepare.ts --target=bun --minify --outdir ${outputDirectory}`.cwd(projectDir);
await $`${process.execPath} build packages/tools/sandbox/src/sandboxProcess.ts --target=bun --minify --external just-bash --outdir ${outputDirectory}`.cwd(projectDir);
const photonOutput = resolve(projectDir, "build/server/node_modules/@silvia-odwyer/photon-node");
await rm(photonOutput, { recursive: true, force: true });
await cp(photonDirectory, photonOutput, { recursive: true });
await copyDocumentPackages(resolve(projectDir, "build/server/node_modules"));
await copySandboxPackages(resolve(projectDir, "build/server/node_modules"));
const skillsOutput = resolve(projectDir, "build/skills");
await rm(skillsOutput, { recursive: true, force: true });
await cp(resolve(projectDir, "packages/skills"), skillsOutput, { recursive: true });
const providersOutput = resolve(projectDir, "build/providers");
await rm(providersOutput, { recursive: true, force: true });
await cp(resolve(projectDir, "packages/providers/src"), providersOutput, { recursive: true });
