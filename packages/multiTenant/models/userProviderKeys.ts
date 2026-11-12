import { openDatabase } from "@toonflow/multi-tenant-db";
import type { AdminDatabase } from "@toonflow/multi-tenant-db";
import { z } from "zod";
import { createModelSecret, modelCipherSchema } from "./secret";

const userIdSchema = z.uuid();
const providerIdSchema = z.literal("aliyun");
const revisionSchema = z.number().int().min(0).max(2147483647);
const apiKeySchema = z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const unboundSchema = z.strictObject({ unbound: z.literal(true) });

function fail(message: string, status: number): never { throw Object.assign(new Error(message), { status }); }
async function databaseCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const failure = error as { message?: string; code?: string; cause?: { message?: string; code?: string } };
    if ((failure.cause?.message ?? failure.message)?.includes("no such table: multiTenantUserProviderKey") || (failure.cause?.message ?? failure.message)?.includes("no such table: multiTenantUserProviderGuard") || (failure.cause?.code ?? failure.code) === "ER_NO_SUCH_TABLE") {
      return fail("客户凭据存储尚未迁移，请联系管理员", 503);
    }
    return fail("客户凭据存储不可用，请稍后重试", 503);
  }
}

// 用户身份必须由已认证会话提供；路由层不得采信请求体里的 userId。
export function createUserProviderKeys(dataDirectory: string, existingDatabase?: AdminDatabase) {
  const secret = createModelSecret(dataDirectory);
  let database: Promise<AdminDatabase | undefined> | undefined = existingDatabase ? Promise.resolve(existingDatabase) : undefined;
  async function getDatabase() {
    if (!database) database = openDatabase(dataDirectory, false);
    try { return await database; }
    catch { database = undefined; return fail("客户凭据存储不可用，请稍后重试", 503); }
  }
  async function verifyGuard(db: AdminDatabase) {
    const cipher = await databaseCall(() => db.getUserProviderGuard());
    if (!cipher) fail("客户凭据密钥校验标记缺失，请先执行受控迁移", 503);
    const value = await secret.open(cipher, "userProviderGuard");
    if (value.marker !== "toonflowUserProviderGuardV1") fail("客户凭据密钥校验标记无效", 503);
    return cipher;
  }
  async function identity(userId: string, providerId: string) {
    const user = userIdSchema.parse(userId).toLowerCase();
    const provider = providerIdSchema.parse(providerId);
    const db = await getDatabase();
    if (!db) fail("多租户数据源尚未初始化", 503);
    const guard = await verifyGuard(db);
    const account = await databaseCall(() => db.getUserById(user));
    if (!account || account.disabled) fail("用户不存在或已停用", 403);
    return { db, user, provider, guard, binding: `${user}:${provider}` };
  }
  return {
    // 仅供受控迁移调用；普通请求不得创建或重置标记。
    async initializeGuard() {
      const db = await getDatabase();
      if (!db) fail("多租户数据源尚未初始化", 503);
      const current = await databaseCall(() => db.getUserProviderGuard());
      if (!current) {
        if (await databaseCall(() => db.hasUserProviderKeys())) fail("已有客户凭据但缺少密钥校验标记，需先恢复原标记", 503);
        const cipher = await secret.seal({ marker: "toonflowUserProviderGuardV1" }, "userProviderGuard");
        await databaseCall(() => db.insertUserProviderGuard(cipher));
      }
      await verifyGuard(db);
    },
    async status(userId: string, providerId: string) {
      const { db, user, provider, binding, guard } = await identity(userId, providerId);
      const stored = await databaseCall(() => db.getUserProviderKey(user, provider));
      if (stored && (!modelCipherSchema.safeParse(stored.cipher).success || !Number.isSafeInteger(stored.revision) || stored.revision < 1)) fail("客户凭据记录无效", 503);
      if (stored) {
        const value = await secret.openUserProvider(stored.cipher, binding, guard);
        if (unboundSchema.safeParse(value).success) return { configured: false, revision: stored.revision };
        if (!apiKeySchema.safeParse(value.apiKey).success) fail("客户凭据记录无效", 503);
      }
      return { configured: !!stored, revision: stored?.revision ?? 0 };
    },
    async save(userId: string, providerId: string, apiKey: string, expectedRevision: number) {
      const { db, user, provider, binding, guard } = await identity(userId, providerId);
      const revision = revisionSchema.parse(expectedRevision);
      if (revision >= 2147483646) fail("客户凭据版本已耗尽，请联系管理员", 409);
      const parsedKey = apiKeySchema.safeParse(apiKey);
      if (!parsedKey.success) fail("API Key 格式无效", 400);
      const key = parsedKey.data;
      const stored = await databaseCall(() => db.getUserProviderKey(user, provider));
      if ((stored?.revision ?? 0) !== revision) fail("客户凭据已更新，请刷新后重试", 409);
      if (stored) {
        const previous = await secret.openUserProvider(stored.cipher, binding, guard);
        if (!unboundSchema.safeParse(previous).success && !apiKeySchema.safeParse(previous.apiKey).success) fail("客户凭据记录无效", 503);
      }
      const cipher = await secret.replaceUserProvider({ apiKey: key }, binding, stored?.cipher, guard);
      if (cipher.length > 8192) fail("API Key 编码后过长", 400);
      if (!await databaseCall(() => db.writeUserProviderKey(user, provider, cipher, revision))) fail("客户凭据已更新，请刷新后重试", 409);
      return { configured: true, revision: revision + 1 };
    },
    async unbind(userId: string, providerId: string, expectedRevision: number) {
      const { db, user, provider, binding, guard } = await identity(userId, providerId);
      const revision = revisionSchema.parse(expectedRevision);
      if (revision >= 2147483647) fail("客户凭据版本已耗尽，请联系管理员", 409);
      const stored = await databaseCall(() => db.getUserProviderKey(user, provider));
      if (!stored || stored.revision !== revision) fail("客户凭据已更新，请刷新后重试", 409);
      const previous = await secret.openUserProvider(stored.cipher, binding, guard);
      if (unboundSchema.safeParse(previous).success) fail("客户凭据已更新，请刷新后重试", 409);
      if (!apiKeySchema.safeParse(previous.apiKey).success) fail("客户凭据记录无效", 503);
      const cipher = await secret.replaceUserProvider({ unbound: true }, binding, stored.cipher, guard);
      if (!await databaseCall(() => db.writeUserProviderKey(user, provider, cipher, revision))) fail("客户凭据已更新，请刷新后重试", 409);
      return { configured: false, revision: revision + 1 };
    },
    // 只供服务端生成适配器读取，不能通过 API 返回给浏览器。
    async openForExecution(userId: string, providerId: string) {
      const { db, user, provider, binding, guard } = await identity(userId, providerId);
      const stored = await databaseCall(() => db.getUserProviderKey(user, provider));
      if (!stored) return undefined;
      const value = await secret.openUserProvider(stored.cipher, binding, guard);
      if (unboundSchema.safeParse(value).success) return undefined;
      const parsedKey = apiKeySchema.safeParse(value.apiKey);
      if (!parsedKey.success) fail("客户凭据记录无效", 503);
      return parsedKey.data;
    },
  };
}
