// 只读确认离线恢复使用的 SQLite 与 root 登记的部署、容器和卷一致；不代表其他恢复屏障已通过。
import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { inspectRecoveryDaemons, recoveryDockerEndpoint, trustedAppManagement, requireManualEndpoint } from "./recoveryDeploymentPolicy";

const bindingPath = "/etc/toonflow-trim/recoveryBinding.json";
const num = z.string().regex(/^(0|[1-9][0-9]*)$/);
const bindingSchema = z.strictObject({
  version: z.literal(1), dataPath: z.string().startsWith("/"), dataDev: num, dataIno: num, appUid: num,
  sqlitePath: z.string().startsWith("/"), sqliteDev: num, sqliteIno: num,
  appDocker: z.enum(["host", "maintenance"]).optional(),
  maintenanceRetainedContainers: z.array(z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/), image: z.string().regex(/^sha256:[a-f0-9]{64}$/) })).max(31).optional(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), appContainerId: z.string().regex(/^[a-f0-9]{64}$/),
  appImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), appUnit: z.string().regex(/^[A-Za-z0-9_.@-]+\.service$/).optional(), appManagement: z.enum(['unit', 'manual']).optional(),
});
async function trustedRootFile(path: string) {
  for (let parent = dirname(path);;) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022 || await realpath(parent) !== parent) throw new Error("部署清单祖先不安全");
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.nlink !== 1 || info.mode & 0o077 || info.size > 8192) throw new Error("部署清单不安全");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.uid !== 0 || opened.nlink !== 1 || opened.mode & 0o077 || opened.size !== info.size) throw new Error("部署清单已变化");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
async function run(bin: string, args: string[]) {
  const child = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin", HOME: "/root", DOCKER_CONFIG: "/run/toonflow-trim-maintenance/docker-config" } });
  const timeout = setTimeout(() => child.kill(), 15000);
  try { const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]); if (code !== 0 || out.length > 1000000) throw new Error("部署身份查询失败"); return out.trim(); }
  finally { clearTimeout(timeout); }
}
const docker = (socket: string, args: string[]) => run("/usr/bin/docker", [`--host=unix://${socket}`, ...args]);
function overlaps(a: string, b: string) { return a === "/" || b === "/" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
type Mount = { id: string; device: string; root: string; point: string };
function mountField(value: string) { return value.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8))); }
function parseMountInfo(raw: string): Map<string, Mount> {
  const result = new Map<string, Mount>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const fields = line.split(" "), split = fields.indexOf("-");
    if (fields.length < 10 || split < 6 || !/^\d+$/.test(fields[0]!) || !/^\d+:\d+$/.test(fields[2]!) || result.has(fields[0]!)) throw new Error("挂载拓扑不可核验");
    const root = mountField(fields[3]!), point = mountField(fields[4]!);
    if (!root || !point.startsWith("/") || root.startsWith("/") && resolve(root) !== root || resolve(point) !== point) throw new Error("挂载拓扑路径异常");
    result.set(fields[0]!, { id: fields[0]!, device: fields[2]!, root, point });
  }
  if (!result.size) throw new Error("挂载拓扑为空");
  return result;
}
async function backing(path: string, records: Map<string, Mount>) {
  const canonical = await realpath(path), before = await lstat(canonical);
  // Linux O_PATH 能读取文件或目录的 mount ID 而不打开其内容，拒绝跟随末级符号链接。
  const fd = await open(canonical, 0x200000 | constants.O_NOFOLLOW);
  try {
    const held = await fd.stat();
    if (held.dev !== before.dev || held.ino !== before.ino) throw new Error("挂载来源身份已变化");
    const info = await readFile(`/proc/self/fdinfo/${fd.fd}`, "utf8"), ids = [...info.matchAll(/^mnt_id:[ \t]+(\d+)$/gm)];
    if (ids.length !== 1) throw new Error("挂载 ID 不可核验");
    const mount = records.get(ids[0]![1]!);
    if (!mount || !mount.root.startsWith("/") || !overlaps(canonical, mount.point) || mount.point !== "/" && canonical !== mount.point && !canonical.startsWith(`${mount.point}/`)) throw new Error("挂载路径与 ID 不一致");
    const relative = mount.point === "/" ? canonical.slice(1) : canonical.slice(mount.point.length).replace(/^\//, "");
    return { canonical, device: mount.device, root: resolve(mount.root, relative) };
  } finally { await fd.close(); }
}
async function mounts(socket: string, id: string) {
  const out = await docker(socket, ["inspect", "--format", "{{json .Id}}\n{{json .Image}}\n{{json .State.Running}}\n{{json .HostConfig.RestartPolicy.Name}}\n{{json .Mounts}}\n{{json .Config.User}}", id]);
  const lines = out.split("\n"); if (lines.length !== 6) throw new Error("容器信息不完整");
  const [actualId, image, running, restart, mounted, user] = lines.map(line => JSON.parse(line));
  if (!/^[a-f0-9]{64}$/.test(actualId) || !/^sha256:[a-f0-9]{64}$/.test(image) || typeof running !== "boolean" || typeof restart !== "string" || !Array.isArray(mounted) || typeof user !== "string") throw new Error("容器身份异常");
  return { actualId, image, running, restart, mounted, user };
}
export async function verifyTrimRecoveryIdentity(data: string) {
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("需要 root 核验部署身份");
  const binding = bindingSchema.parse(JSON.parse(await trustedRootFile(bindingPath)));
  const appSocket = recoveryDockerEndpoint(binding.appDocker);
  if (binding.appDocker !== "maintenance" && binding.maintenanceRetainedContainers?.length) throw new Error("宿主应用不能登记维护容器");
  if (resolve(data) !== data || binding.dataPath !== data || await realpath(data) !== data) throw new Error("数据目录与部署不一致");
  const dir = await lstat(data, { bigint: true });
  if (binding.appUid === "0" || !dir.isDirectory() || dir.isSymbolicLink() || dir.uid.toString() !== binding.appUid || dir.dev.toString() !== binding.dataDev || dir.ino.toString() !== binding.dataIno) throw new Error("数据卷身份变化");
  const sourcePath = resolve(data, "multiTenant/dataSource.json"), sourceInfo = await lstat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.uid.toString() !== binding.appUid || sourceInfo.mode & 0o022 || sourceInfo.nlink !== 1 || sourceInfo.size > 65536 || await realpath(sourcePath) !== sourcePath) throw new Error("数据源配置异常");
  const sourceFile = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source: string;
  try { const actual = await sourceFile.stat(); if (actual.dev !== sourceInfo.dev || actual.ino !== sourceInfo.ino || actual.size !== sourceInfo.size || actual.nlink !== 1) throw new Error("数据源配置已变化"); source = await sourceFile.readFile("utf8"); }
  finally { await sourceFile.close(); }
  if (createHash("sha256").update(source).digest("hex") !== binding.sourceSha256) throw new Error("数据源配置与部署不一致");
  const config = JSON.parse(source);
  if (config?.provider !== "sqlite" || typeof config?.sqlite?.file !== "string" || config.sqlite.file !== basename(config.sqlite.file)) throw new Error("仅支持已绑定的 SQLite 数据源");
  const dbPath = resolve(data, "multiTenant", config.sqlite.file);
  if (binding.sqlitePath !== dbPath || await realpath(dbPath) !== dbPath) throw new Error("SQLite 路径与部署不一致");
  const db = await lstat(dbPath, { bigint: true });
  if (!db.isFile() || db.isSymbolicLink() || db.uid.toString() !== binding.appUid || (db.mode & 0o022n) !== 0n || db.nlink !== 1n || db.dev.toString() !== binding.sqliteDev || db.ino.toString() !== binding.sqliteIno) throw new Error("SQLite 文件身份变化");
  const registeredApp = trustedAppManagement(binding.appManagement, binding.appUnit);
  requireManualEndpoint(registeredApp.mode, binding.appDocker);
  if (registeredApp.mode === "unit") {
    const service = await run("/usr/bin/systemctl", ["show", registeredApp.unit, "--property=ActiveState,UnitFileState,MainPID"]);
    const values = Object.fromEntries(service.split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (values.ActiveState !== "inactive" || values.MainPID !== "0" || !["masked", "masked-runtime"].includes(values.UnitFileState)) throw new Error("应用未停止并屏蔽");
  }
  const mountSnapshot = await readFile("/proc/self/mountinfo", "utf8"), mountRecords = parseMountInfo(mountSnapshot);
  const targetBacking = await backing(data, mountRecords);
  // 目标目录内可包含额外挂载点；它们也受保护，不能只比较最外层设备。
  const nested = [...mountRecords.values()].filter(mount => mount.point !== data && mount.point.startsWith(`${data}/`));
  if (nested.some(mount => !mount.root.startsWith("/"))) throw new Error("目标内的挂载根不可核验");
  const protectedMounts = [{ device: targetBacking.device, root: targetBacking.root }, ...nested.map(mount => ({ device: mount.device, root: mount.root }))];
  const target = await mounts(appSocket, binding.appContainerId);
  if (target.actualId !== binding.appContainerId || target.image !== binding.appImageId || target.running || target.restart !== "no" || target.user.split(":")[0] !== binding.appUid
    || !target.mounted.some((mount: any) => mount.Type === "bind" && mount.Source === data && mount.Destination === "/app/data")) throw new Error("应用容器或数据挂载与部署不一致");
  // 即使为停止状态，自动重启的其他挂载者也不能通过；每次扫描全部容器。
  const records = await inspectRecoveryDaemons(binding.appDocker,
    async socket => (await docker(socket, ["ps", "-aq", "--no-trunc"])).split("\n").filter(Boolean),
    async (socket, id) => {
      const row = socket === appSocket && id === target.actualId ? target : await mounts(socket, id);
      if (row.actualId !== id) throw new Error("容器身份不可核验");
      return row;
    });
  for (const { row } of records) {
    if (!row.running && row.restart === "no") continue;
    for (const mount of row.mounted) {
      if (mount.Type !== "bind" && mount.Type !== "volume") continue;
      if (typeof mount.Source !== "string" || !mount.Source.startsWith("/")) throw new Error("容器挂载来源异常");
      const source = await backing(mount.Source, mountRecords);
      if (overlaps(data, source.canonical) || protectedMounts.some(protectedMount => protectedMount.device === source.device && overlaps(protectedMount.root, source.root))) throw new Error("目标数据卷仍有运行或自动重启的容器");
    }
  }
  if (await readFile("/proc/self/mountinfo", "utf8") !== mountSnapshot) throw new Error("挂载拓扑在核验期间发生变化");
  // 离线维护时不接受任何持应用 UID 的进程，包括非 Docker 写入者；未知状态拒绝。
  const { readdir } = await import("node:fs/promises");
  for (const pid of await readdir("/proc")) {
    if (!/^[0-9]+$/.test(pid)) continue;
    let status: string;
    try { status = await readFile(`/proc/${pid}/status`, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") continue; throw error; }
    const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    if (!uid) throw new Error("应用进程身份不可核验");
    if (uid.slice(1).some(value => value === binding.appUid)) throw new Error("应用 UID 仍有进程，不能离线恢复");
  }
  return { dataPath: data, sqlitePath: dbPath, appContainerId: target.actualId, appManagement: registeredApp.mode === "manual" ? { mode: "manual" as const, id: target.actualId, image: target.image } : registeredApp,
    maintenanceAllowed: binding.appDocker === "maintenance"
      ? [{ id: binding.appContainerId, image: binding.appImageId }, ...(binding.maintenanceRetainedContainers ?? [])] : [] };
}
