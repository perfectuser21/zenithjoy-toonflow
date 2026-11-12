import { lstat, mkdir, readdir, realpath, rmdir, statfs } from "@toonflow/file";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import conf from "@/utils/conf";
import { projectQuotaRoot } from "@/utils/workspace/projectQuota";

// 共享目录锁不自动回收：进程意外退出时保持关闭，等待运维核实后恢复。
const quotaBytes = 5 * 1024 * 1024 * 1024;
const minimumFreeBytes = 2 * 1024 * 1024 * 1024;

function within(root: string, path: string) {
  const offset = relative(root, path);
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

async function totalBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw Object.assign(new Error("工作区包含无法计量的文件，请联系管理员"), { status: 409 });
  }
  if (info.isFile()) return info.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await totalBytes(resolve(path, entry));
  if (!Number.isSafeInteger(total)) throw Object.assign(new Error("工作区容量无效"), { status: 503 });
  return total;
}

export async function withWorkspaceQuota<T>(path: string, requested: number | (() => Promise<number>), replace: boolean, action: () => Promise<T>): Promise<T> {
  const dataDirectory = await realpath(dirname(conf.path));
  const configuredRoot = projectQuotaRoot();
  const workspaceRoots = [resolve(dataDirectory, "multiTenant", "workspaces"),
    ...(configuredRoot ? [resolve(configuredRoot, "quotaWorkspaces")] : [])];
  let parent = dirname(resolve(path));
  let resolvedParent: string;
  for (;;) {
    try { resolvedParent = await realpath(parent); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === dirname(parent)) throw error;
      parent = dirname(parent);
    }
  }
  const actualPath = resolve(resolvedParent, relative(parent, resolve(path)));
  const workspaces = workspaceRoots.find(root => within(root, actualPath));
  if (!workspaces) return action();
  const offset = relative(workspaces, actualPath);
  const ownerId = offset.split(sep)[0];
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(ownerId)) {
    throw Object.assign(new Error("工作区容量参数无效"), { status: 400 });
  }
  const root = resolve(workspaces, ownerId);
  const actualRoot = await realpath(root);
  if (actualRoot !== root || !within(actualRoot, actualPath)) throw Object.assign(new Error("工作区目录无效"), { status: 403 });
  const lock = resolve(dataDirectory, "multiTenant", "workspaceQuotaLock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error("存储空间正在检查，请稍后重试"), { status: 503 });
    throw cause;
  }
  try {
    const size = typeof requested === "number" ? requested : await requested();
    if (!Number.isSafeInteger(size) || size < 0) throw Object.assign(new Error("工作区容量参数无效"), { status: 400 });
    const current = await totalBytes(root);
    const existing = replace ? await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }) : null;
    if (existing && !existing.isFile()) throw Object.assign(new Error("只能覆盖普通文件"), { status: 403 });
    if (current - (existing?.size ?? 0) + size > quotaBytes) throw Object.assign(new Error("工作区存储空间已满，请释放空间后重试"), { status: 507 });
    const disk = await statfs(root, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(minimumFreeBytes) + BigInt(size)) {
      throw Object.assign(new Error("服务器剩余空间不足，请稍后重试"), { status: 507 });
    }
    return await action();
  } finally { await rmdir(lock); }
}

export { totalBytes as workspaceTreeBytes };
