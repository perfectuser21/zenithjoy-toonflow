/** 只读降级优先：停止创建裁剪，但继续读取及导出已生成的素材。 */
export function trimMode(env: NodeJS.ProcessEnv = process.env) {
  const readOnly = env.TOONFLOW_SECURE_TRIM_READ_ONLY === "1";
  const enabled = env.TOONFLOW_SECURE_TRIM_ENABLED === "1";
  return { read: enabled || readOnly, create: enabled && !readOnly };
}

/** 仅受信任运维完成旧实例隔离、持久状态和回退核验后可显式开放。 */
export function unknownTrimRecoveryAvailable(env: NodeJS.ProcessEnv = process.env) {
  return env.TOONFLOW_TRIM_RECOVERY_ISOLATION_CONFIRMED === "1"
    && env.TOONFLOW_SECURE_TRIM_SINGLE_INSTANCE === "1" && trimMode(env).create;
}

/** 只读模式只允许查询既有裁剪状态，不允许执行或释放。 */
export function canAccessTrimRoute(path: string, method: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.TOONFLOW_SECURE_TRIM_SINGLE_INSTANCE !== "1") return false;
  const mode = trimMode(env);
  if (path === "/api/ffmpeg/trim/capabilities" && method === "GET") return mode.read;
  if (method !== "POST") return false;
  if (["/api/ffmpeg/trim", "/api/ffmpeg/trim/status", "/api/ffmpeg/trim/recoveries"].includes(path)) return mode.read;
  return mode.create && path === "/api/ffmpeg/trim/discard";
}
