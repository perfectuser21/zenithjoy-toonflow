import { lstat, unlink } from "node:fs/promises";

// 只在正常停止并排空请求后移除本进程创建的 socket；异常退出仍保留现场。
export async function installTrimSocketShutdown(path: string, server: { stop: (closeActiveConnections?: boolean) => void | Promise<void> }) {
  const original = await lstat(path);
  if (!original.isSocket() || original.isSymbolicLink()) throw new Error("裁剪 socket 身份无效");
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      // Bun 的 stop 会自行移除路径，必须在调用前确认路径仍是本进程的 socket。
      const before = await lstat(path);
      if (!before.isSocket() || before.isSymbolicLink() || before.dev !== original.dev || before.ino !== original.ino) throw new Error("裁剪 socket 已变化，保留现场");
      await server.stop(false);
      const current = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (current) {
        if (!current.isSocket() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino) throw new Error("裁剪 socket 已变化，保留现场");
        await unlink(path);
      }
      process.exit(0);
    } catch {
      console.error("裁剪服务停止失败，保留现场");
      // 路径异常时不能调用 stop 或 exit：运行时退出清理也可能删除替换后的 socket。
      stopping = false;
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
