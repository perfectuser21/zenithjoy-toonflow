import { createConnection } from "node:net";
import { lstat, readdir, realpath, stat } from "@toonflow/file";
import { dirname, join, resolve } from "node:path";
import conf from "@/utils/conf";
import { getRuntimePlatform } from "@/lib/platform";

export function projectQuotaRoot() {
  const value = process.env.TOONFLOW_PROJECT_QUOTA_ROOT;
  if (!value && process.env.NODE_ENV !== "dev" && !getRuntimePlatform().desktop
    && conf.get("settings", {}).multiTenantEnabled === true) {
    throw Object.assign(new Error("多租户服务必须配置用户磁盘配额"), { status: 503 });
  }
  return value ? resolve(value) : undefined;
}

export async function ensureProjectQuota(userId: string, operation: "enroll" | "check") {
  const root = projectQuotaRoot();
  if (!root) return;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(userId)) throw Object.assign(new Error("账号标识无效"), { status: 403 });
  const oldWorkspace = join(dirname(conf.path), "multiTenant", "workspaces", userId);
  const oldInfo = await lstat(oldWorkspace).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  const oldTasks = join(dirname(conf.path), "mediaTasks");
  const legacyTasks = await readdir(oldTasks).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  if (oldInfo || legacyTasks.length) throw Object.assign(new Error("检测到未归属的旧数据，暂不能启用用户配额"), { status: 409 });
  await quotaRequest(root, { userId, operation }, true);
}

export async function verifyProjectQuota() {
  if (process.env.NODE_ENV === "dev" || getRuntimePlatform().desktop) return;
  if (typeof process.getuid !== "function" || process.getuid() === 0 || typeof process.getgid !== "function" || process.getgid() === 0) {
    throw Object.assign(new Error("多租户服务必须使用非 root 身份运行"), { status: 503 });
  }
  const configured = process.env.TOONFLOW_PROJECT_QUOTA_ROOT;
  if (!configured) throw Object.assign(new Error("多租户服务必须配置用户磁盘配额"), { status: 503 });
  const root = resolve(configured);
  const temporary = process.env.TMPDIR;
  if (!temporary) throw Object.assign(new Error("多租户服务必须配置受限卷临时目录"), { status: 503 });
  const paths = [root, dirname(conf.path), resolve(temporary)];
  const devices = await Promise.all(paths.map(async path => {
    const actual = await realpath(path);
    const info = await stat(actual);
    if (!info.isDirectory()) throw Object.assign(new Error("受限卷目录无效"), { status: 503 });
    return info.dev;
  }));
  if (devices.some(device => device !== devices[0])) throw Object.assign(new Error("数据、配额及临时目录必须位于同一受限卷"), { status: 503 });
  await quotaRequest(root, { operation: "health" }, false);
}

async function quotaRequest(root: string, request: object, expectProject: boolean) {
  if (await realpath(root) !== root) throw Object.assign(new Error("配额根目录无效"), { status: 503 });
  const socket = join(root, "quotaHelper.sock");
  const info = await lstat(socket);
  if (!info.isSocket() || info.uid !== 0 || info.mode & 0o002) throw Object.assign(new Error("配额服务不可用"), { status: 503 });
  await new Promise<void>((accept, reject) => {
    const conn = createConnection(socket);
    let data = "";
    const fail = () => { conn.destroy(); reject(Object.assign(new Error("配额服务不可用"), { status: 503 })); };
    conn.setTimeout(5000, fail);
    conn.once("error", fail);
    conn.once("connect", () => conn.write(`${JSON.stringify(request)}\n`));
    conn.on("data", chunk => {
      data += chunk.toString("utf8");
      if (data.length > 1024) return fail();
      if (!data.endsWith("\n")) return;
      try {
        const value = JSON.parse(data);
        if (value.ready !== true || expectProject && (!Number.isSafeInteger(value.projectId) || value.projectId < 1)) return fail();
        conn.destroy(); accept();
      } catch { fail(); }
    });
    conn.once("end", fail);
  });
}
