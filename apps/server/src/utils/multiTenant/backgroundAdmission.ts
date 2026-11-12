import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, readFile, realpath, stat, statfs } from "@toonflow/file";
import { dataSourceSchema, openDatabase } from "@toonflow/multi-tenant-db";
import conf from "@/utils/conf";
import { getRuntimePlatform } from "@/lib/platform";
import { projectQuotaRoot, verifyProjectQuota } from "@/utils/workspace/projectQuota";
import { isEnabled } from "./mode";

const budgetKey = { jobId: "00000000-0000-4000-8000-000000000001", ownerId: "system", workspaceHash: "0".repeat(64) };
const localFileSystems = new Set([0xef53, 0x58465342]); // ext4、XFS；不接受 overlay、tmpfs、NFS。
let admission: Promise<{ root: string; workspaceRoot: string; device: number; lockPath: string; legacyPath: string; inode: number; lock: FileHandle }> | undefined;

async function rejectLegacyMarker(path: string) {
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("检测到旧版独占标记，须先离线迁移");
}

function within(root: string, path: string) {
  const offset = relative(root, path);
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

export async function isolatedBackgroundBeta() {
  if (process.env.TOONFLOW_BACKGROUND_BETA !== "1" || process.env.NODE_ENV === "production") return false;
  try { return within(await realpath(tmpdir()), await realpath(dirname(conf.path))) && await realpath(tmpdir()) !== await realpath(dirname(conf.path)); }
  catch { return false; }
}

async function initializeProductionAdmission() {
  if (process.platform !== "linux" || process.env.NODE_ENV !== "production" || getRuntimePlatform().desktop) throw new Error("生产换背景仅支持经过校验的 Linux 服务");
  await verifyProjectQuota();
  const root = await realpath(dirname(conf.path));
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("数据目录无效");
  const temp = await realpath(tmpdir());
  if (temp === root || !within(root, temp)) throw new Error("临时目录必须位于持久数据卷内");
  const configuredQuotaRoot = projectQuotaRoot();
  if (!configuredQuotaRoot) throw new Error("用户项目配额尚未配置");
  const quotaRoot = await realpath(configuredQuotaRoot);
  if (quotaRoot !== configuredQuotaRoot || dirname(quotaRoot) !== root) throw new Error("用户配额目录必须是数据目录的直接子目录");
  const workspaceRoot = await realpath(resolve(quotaRoot, "quotaWorkspaces"));
  if (workspaceRoot !== resolve(quotaRoot, "quotaWorkspaces")) throw new Error("用户配额工作区无效");
  const rootDevice = (await stat(root)).dev;
  if ((await stat(temp)).dev !== rootDevice || (await stat(workspaceRoot)).dev !== rootDevice || !localFileSystems.has((await statfs(root)).type)) throw new Error("换背景需要同一受支持的本地持久文件系统");
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  const mountPaths = mounts.split("\n").flatMap(line => {
    const [before, after] = line.split(" - ");
    if (!after || !before) return [];
    const fields = before.split(" "), details = after.split(" ");
    const point = fields[4]?.replace(/\\([0-7]{3})/g, (_all, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    return point && point !== "/" && details[1]?.startsWith("/dev/") && (within(point, root) || point === quotaRoot) ? [point] : [];
  });
  // 两个挂载点均不能被服务账号改名；只保护锁文件本身无法阻止整个父目录被替换。
  if (!mountPaths.includes(root) || !mountPaths.includes(quotaRoot)) throw new Error("数据及配额目录必须分别为固定挂载点");
  const status = await readFile("/proc/self/status", "utf8");
  for (const field of ["CapEff", "CapPrm", "CapInh", "CapAmb"]) {
    const capabilities = new RegExp(`^${field}:\\s*([0-9a-f]+)$`, "im").exec(status);
    if (!capabilities || (BigInt(`0x${capabilities[1]}`) & (1n << 21n)) !== 0n) throw new Error("换背景服务不能拥有挂载权限");
  }
  if (!/^NoNewPrivs:\s*1$/m.test(status)) throw new Error("换背景服务必须禁止获取新权限");
  const sourcePath = resolve(root, "multiTenant/dataSource.json");
  const sourceInfo = await lstat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size > 65536) throw new Error("数据源配置无效");
  const source = dataSourceSchema.parse(JSON.parse(await readFile(sourcePath, "utf8")));
  if (source.provider !== "sqlite") throw new Error("当前准入只支持本地 SQLite 单实例");
  const database = await openDatabase(root, false);
  if (!database) throw new Error("数据库尚未初始化");
  try {
    if (!await database.getAdmin()) throw new Error("管理员尚未初始化");
    const budget = await database.getBackgroundJob(budgetKey);
    if (!budget || budget.payload.kind !== "backgroundBudget" || !Array.isArray(budget.payload.reservations)) throw new Error("换背景预算账本尚未迁移");
  } finally { await database.close(); }
  const legacyPath = resolve(root, "multiTenant/backgroundAdmission.lock");
  await rejectLegacyMarker(legacyPath);
  const lockPath = resolve(quotaRoot, "backgroundAdmission.flock");
  const lock = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = await lock.stat();
    const path = await lstat(lockPath);
    if (!file.isFile() || !path.isFile() || file.uid !== 0 || file.gid !== process.getgid?.() || (file.mode & 0o7777) !== 0o660 || file.nlink !== 1 || file.dev !== rootDevice || file.dev !== path.dev || file.ino !== path.ino) throw new Error("换背景进程锁文件无效");
    const { dlopen, FFIType } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    try {
      // FD_CLOEXEC 防止子进程无意继承锁；LOCK_EX | LOCK_NB 不等待其他实例。
      if (libc.symbols.fcntl(lock.fd, 2, 1) !== 0 || libc.symbols.flock(lock.fd, 2 | 4) !== 0) throw new Error("换背景已由其他进程占用");
    } finally { libc.close(); }
    await rejectLegacyMarker(legacyPath);
    return { root, workspaceRoot, device: rootDevice, lockPath, legacyPath, inode: file.ino, lock };
  } catch (error) { await lock.close(); throw error; }
}

export async function productionBackgroundAdmission() {
  admission ??= initializeProductionAdmission().catch(error => { admission = undefined; throw error; });
  try {
    const state = await admission;
    await verifyProjectQuota();
    await rejectLegacyMarker(state.legacyPath);
    const lock = await lstat(state.lockPath);
    const held = await state.lock.stat();
    if (!lock.isFile() || lock.isSymbolicLink() || lock.uid !== 0 || lock.gid !== process.getgid?.() || (lock.mode & 0o7777) !== 0o660 || lock.nlink !== 1 || lock.dev !== state.device || lock.ino !== state.inode || held.dev !== state.device || held.ino !== state.inode) return false;
    if ((await stat(state.root)).dev !== state.device || (await stat(await realpath(tmpdir()))).dev !== state.device) return false;
    return true;
  } catch { return false; }
}

export async function assertBackgroundWorkspace(cwd: string) {
  const state = await admission;
  if (!state || !await productionBackgroundAdmission() || !within(state.workspaceRoot, cwd) || (await stat(cwd)).dev !== state.device) {
    throw Object.assign(new Error("工作区不在已验证的换背景数据卷内"), { status: 503 });
  }
}

export async function backgroundMediaPolicy(cwd: string): Promise<"new" | "recovery" | "none"> {
  if (!isEnabled()) return "none";
  if (await isolatedBackgroundBeta()) return "new";
  const canCreate = process.env.TOONFLOW_BACKGROUND_PRODUCTION === "1";
  const canRecover = process.env.TOONFLOW_BACKGROUND_RECOVERY === "1";
  if (!canCreate && !canRecover || !await productionBackgroundAdmission()) return "none";
  try { await assertBackgroundWorkspace(cwd); }
  catch { return "none"; }
  return canCreate ? "new" : "recovery";
}
