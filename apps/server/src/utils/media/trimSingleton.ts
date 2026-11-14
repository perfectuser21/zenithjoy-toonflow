import { constants, lstat, open, realpath } from "@toonflow/file";
import type { FileHandle } from "@toonflow/file";
import { resolve } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { projectQuotaRoot } from "@/utils/workspace/projectQuota";

let held: FileHandle | undefined;
let acquiring: Promise<void> | undefined;
let heldRoot: string | undefined;
// root 创建固定锁文件；FD 持有至进程退出，不能仅依赖环境变量声明单实例。
export async function ensureTrimSingleton() {
  if (held) {
    if (projectQuotaRoot() !== heldRoot || process.env.TOONFLOW_SECURE_TRIM_SINGLE_INSTANCE !== "1") throw new Error("裁剪锁配置已变化");
    const [path, handle] = await Promise.all([lstat(resolve(heldRoot!, ".trimApp.lock")), held.stat()]);
    if (!path.isFile() || path.isSymbolicLink() || path.uid !== 0 || path.mode & 0o022 || path.nlink !== 1 || path.dev !== handle.dev || path.ino !== handle.ino) throw new Error("裁剪锁文件已变化");
    return;
  }
  acquiring ??= (async () => {
    const root = projectQuotaRoot();
    if (process.platform !== "linux" || !root || process.env.TOONFLOW_SECURE_TRIM_SINGLE_INSTANCE !== "1") throw new Error("裁剪单实例尚未配置");
    const directory = await lstat(root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || directory.mode & 0o022 || await realpath(root) !== resolve(root)) throw new Error("裁剪锁目录不安全");
    const file = await open(resolve(root, ".trimApp.lock"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || info.mode & 0o022) throw new Error("裁剪锁文件不安全");
      const libc = dlopen("libc.so.6", { flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int }, fcntl: { args: [FFIType.int, FFIType.int, FFIType.int], returns: FFIType.int } });
      try { if (libc.symbols.fcntl(file.fd, 2, 1) !== 0 || libc.symbols.flock(file.fd, 6) !== 0) throw new Error("裁剪已有其他应用实例"); }
      finally { libc.close(); }
      heldRoot = root; held = file;
    } catch (error) { await file.close(); throw error; }
  })();
  try { await acquiring; } catch (error) { acquiring = undefined; throw error; }
}
