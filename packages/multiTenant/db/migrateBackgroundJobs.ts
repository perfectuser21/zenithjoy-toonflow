import { isAbsolute, resolve } from "node:path";
import { lstat, realpath } from "@toonflow/file";
import { openDatabase } from "./index";
import { initializeBackgroundBudget } from "./backgroundBudget";

// 显式运维入口：准备或迁移现有数据库，不由普通请求或服务启动隐式执行。
const [directory, confirmation, ...extra] = process.argv.slice(2);
if (!directory || !isAbsolute(directory) || confirmation !== "--confirm-background-jobs-migration" || extra.length) {
  throw new Error("用法：bun migrateBackgroundJobs.ts <绝对数据目录> --confirm-background-jobs-migration");
}
const target = resolve(directory);
const info = await lstat(target);
if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target) throw new Error("数据目录必须是规范的普通目录");
let db: Awaited<ReturnType<typeof openDatabase>>;
try {
  db = await openDatabase(target, false);
  if (!db || !await db.getAdmin()) throw new Error("多租户数据库或管理员尚未初始化");
  await db.initializeBackgroundJobs();
  await initializeBackgroundBudget(db);
  console.log("长视频批次存储迁移完成");
} catch {
  // 数据库连接错误可能包含敏感配置，不把驱动错误写到终端或日志。
  throw new Error("长视频批次存储迁移失败，请检查数据库和管理员配置");
} finally {
  if (db) await db.close().catch(() => {});
}
