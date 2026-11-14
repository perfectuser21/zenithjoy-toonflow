import { constants, lstat, open, realpath } from "@toonflow/file";
import { dirname, resolve } from "node:path";

/** 应用凭据只从 root 管控的只读文件读取，避免继承给媒体子进程。 */
export async function readTrimSecret(path: string | undefined) {
  if (!path?.startsWith("/") || resolve(path) !== path || typeof process.getuid !== "function" || !process.getuid()) throw new Error("裁剪服务凭据未配置");
  for (let directory = dirname(path);;) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022 || await realpath(directory) !== directory) throw new Error("裁剪服务凭据目录不安全");
    const next = dirname(directory); if (next === directory) break; directory = next;
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat(), entry = await lstat(path);
    if (!info.isFile() || !entry.isFile() || entry.isSymbolicLink() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o777) !== 0o640
      || typeof process.getgid !== "function" || typeof process.getgroups !== "function" || process.getgid() !== info.gid && !process.getgroups().includes(info.gid)
      || entry.dev !== info.dev || entry.ino !== info.ino || info.size !== 64) throw new Error("裁剪服务凭据不安全");
    const token = (await file.readFile()).toString("utf8");
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("裁剪服务凭据无效");
    return token;
  } finally { await file.close(); }
}
