// 运维显式运行；只建立全局锁。账号目录由 quota helper 验证并按需创建。
import { constants, lstat, open, realpath } from "@toonflow/file";
import { dirname, isAbsolute, resolve } from "node:path";

const [rootArg, appGidArg, confirm, ...extra] = process.argv.slice(2);
const appGid = Number(appGidArg);
if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0 || !rootArg || !isAbsolute(rootArg)
  || !Number.isSafeInteger(appGid) || appGid <= 0 || confirm !== "--confirm-trim-store-provision" || extra.length) {
  throw new Error("用法：provisionTrimStore <配额根目录> <裁剪访问 GID> --confirm-trim-store-provision");
}
const root = resolve(rootArg);
for (let directory = root;;) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022 || await realpath(directory) !== directory) throw new Error("配额目录必须由 root 控制且不可由其他账号修改");
  const next = dirname(directory); if (next === directory) break; directory = next;
}
for (const name of [".trimApp.lock", ".trimStore.lock"]) {
  const path = resolve(root, name);
  let created = false;
  let file;
  try { file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDONLY | constants.O_NOFOLLOW, 0o640); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || !created && (info.gid !== appGid || (info.mode & 0o777) !== 0o640)) throw new Error("已有锁文件权限不匹配，未修改");
    if (created) { await file.chown(0, appGid); await file.chmod(0o640); await file.sync(); }
  } finally { await file.close(); }
}
const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
try { await rootHandle.sync(); } finally { await rootHandle.close(); }
console.log("裁剪单实例锁已准备；账号目录由配额服务按需创建");
