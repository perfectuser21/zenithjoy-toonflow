import { isAbsolute } from "node:path";
import { openDatabase } from "@toonflow/multi-tenant-db";
import { createModelSecret } from "./secret";
import { createUserProviderKeys } from "./userProviderKeys";

// 显式运维入口：只准备数据表，不创建或替换模型加密主密钥。
export async function migrateUserProviderKeys(dataDirectory: string) {
  if (!isAbsolute(dataDirectory)) throw new Error("请提供绝对数据目录");
  const database = await openDatabase(dataDirectory, false);
  if (!database) throw new Error("多租户数据源尚未初始化");
  try {
    if (!await database.getAdmin()) throw new Error("多租户管理员尚未初始化");
    const secret = createModelSecret(dataDirectory);
    await secret.requireExistingUserProviderKey();
    const routing = await database.getModelRouting();
    let verifiedPlatformCipher = false;
    if (routing) {
      if (!routing.configuration || typeof routing.configuration !== "object" || Array.isArray(routing.configuration)) {
        throw new Error("模型配置无效");
      }
      const configuration = routing.configuration as Record<string, unknown>;
      for (const [field, purpose] of [["providerCipher", "providers"], ["cloudCipher", "cloud"]] as const) {
        if (configuration[field] !== undefined) {
          if (typeof configuration[field] !== "string") throw new Error("模型密文无效");
          await secret.open(configuration[field], purpose);
          verifiedPlatformCipher = true;
        }
      }
    }
    if (!verifiedPlatformCipher) throw new Error("需要先验证既有平台模型密文与原始主密钥");
    await database.initializeUserProviderKeys();
    await database.initializeUserProviderGuard();
    await createUserProviderKeys(dataDirectory, database).initializeGuard();
  } finally { await database.close(); }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error("请提供一个绝对数据目录");
    await migrateUserProviderKeys(process.argv[2]!);
    console.log("客户凭据数据表已准备");
  } catch {
    console.error("客户凭据迁移失败，请检查管理员、数据源及既有模型加密密钥");
    process.exitCode = 1;
  }
}
