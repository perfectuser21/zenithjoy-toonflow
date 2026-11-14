import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { and, asc, count, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { mysqlSchema, varchar } from "drizzle-orm/mysql-core";
import { mysqlAdmin, mysqlBackgroundJob, mysqlBillingLedger, mysqlModelRouting, mysqlSettings, mysqlSourceMapping, mysqlUser, mysqlUserProviderGuard, mysqlUserProviderKey, mysqlWallet, mysqlWebSession } from "./schema";
import type { AdminDatabase, WalletRecord } from "./schema";
import { backgroundJobKeySchema, backgroundJobCreateSchema, backgroundJobLeaseSchema, backgroundJobRenewSchema, backgroundJobUpdateSchema, backgroundJobReleaseSchema } from "./backgroundJobs";
import type { DataSource } from "./index";
import { maxWalletMicros, validateWalletAmount, walletBalanceOverflow, walletSettlementExceeded, walletStateConflict } from "./billing";

const informationColumns = mysqlSchema("information_schema").table("COLUMNS", {
  tableSchema: varchar("TABLE_SCHEMA", { length: 64 }).notNull(),
  tableName: varchar("TABLE_NAME", { length: 64 }).notNull(),
  columnName: varchar("COLUMN_NAME", { length: 64 }).notNull(),
});
const informationTables = mysqlSchema("information_schema").table("TABLES", {
  tableSchema: varchar("TABLE_SCHEMA", { length: 64 }).notNull(),
  tableName: varchar("TABLE_NAME", { length: 64 }).notNull(),
  engine: varchar("ENGINE", { length: 64 }),
});

export function connectMysql(config: Extract<DataSource, { provider: "mysql" }>["mysql"]): AdminDatabase {
  const client = mysql.createPool({ ...config, connectionLimit: 5, ...(config.ssl ? { ssl: { ...config.ssl, rejectUnauthorized: true } } : {}) });
  const db = drizzle(client);
  let accountColumn: boolean | undefined;
  let initialized = false;
  let billingEngine: Promise<void> | undefined;
  async function columns(tableName = "multiTenantAdmin") {
    return db.select({ columnName: informationColumns.columnName }).from(informationColumns).where(and(
      eq(informationColumns.tableSchema, config.database), eq(informationColumns.tableName, tableName),
    ));
  }
  function errorCode(error: unknown) {
    const failure = error as { code?: string; cause?: { code?: string } };
    return failure.cause?.code ?? failure.code;
  }
  function requireWallet(wallet: WalletRecord | undefined) {
    if (!wallet || !Number.isSafeInteger(wallet.balanceMicros) || !Number.isSafeInteger(wallet.reservedMicros)
      || wallet.balanceMicros < 0 || wallet.balanceMicros > maxWalletMicros || wallet.reservedMicros < 0
      || wallet.reservedMicros > wallet.balanceMicros) walletStateConflict();
    return wallet;
  }
  async function requireBillingEngine() {
    if (billingEngine) return billingEngine;
    const checking = (async () => {
      const tables = await db.select({ engine: informationTables.engine }).from(informationTables).where(and(
        eq(informationTables.tableSchema, config.database),
        sql`${informationTables.tableName} IN (${"multiTenantWallet"}, ${"multiTenantBillingLedger"})`,
      ));
      if (tables.length !== 2 || tables.some(table => table.engine?.toLowerCase() !== "innodb")) {
        throw Object.assign(new Error("钱包数据表尚未初始化或存储引擎不支持事务"), { code: "walletStorageUnavailable", status: 503 });
      }
    })();
    billingEngine = checking;
    try { await checking; }
    catch (error) {
      if (billingEngine === checking) billingEngine = undefined;
      throw error;
    }
  }
  const insufficientWallet = new Error("余额不足");
  const backgroundNow = sql`CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED)`;
  function backgroundIdentity(input: { jobId: string; ownerId: string; workspaceHash: string }) {
    return and(eq(mysqlBackgroundJob.jobId, input.jobId), eq(mysqlBackgroundJob.ownerId, input.ownerId), eq(mysqlBackgroundJob.workspaceHash, input.workspaceHash));
  }
  function backgroundLease(input: { jobId: string; ownerId: string; workspaceHash: string; leaseOwner: string; generation: number }) {
    return and(backgroundIdentity(input), eq(mysqlBackgroundJob.leaseOwner, input.leaseOwner), eq(mysqlBackgroundJob.leaseGeneration, input.generation), sql`${mysqlBackgroundJob.leaseUntil} > ${backgroundNow}`);
  }
  return {
    async initializeBackgroundJobs() {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantBackgroundJob (
        jobId VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, ownerId VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        workspaceHash VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, payload JSON NOT NULL, revision INT NOT NULL,
        leaseOwner VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin, leaseUntil BIGINT NOT NULL, leaseGeneration INT NOT NULL
      ) ENGINE=InnoDB`);
      const [table] = await db.select({ engine: informationTables.engine }).from(informationTables).where(and(
        eq(informationTables.tableSchema, config.database), eq(informationTables.tableName, "multiTenantBackgroundJob"))).limit(1);
      if (table?.engine?.toLowerCase() !== "innodb") throw Object.assign(new Error("批次存储不支持事务"), { status: 503 });
    },
    async createBackgroundJob(input) {
      const value = backgroundJobCreateSchema.parse(input);
      try { await db.insert(mysqlBackgroundJob).values({ ...value, revision: 1, leaseOwner: null, leaseUntil: 0, leaseGeneration: 0 }); return true; }
      catch (error) { if (errorCode(error) === "ER_DUP_ENTRY") return false; throw error; }
    },
    async getBackgroundJob(input) {
      const value = backgroundJobKeySchema.parse(input);
      return (await db.select().from(mysqlBackgroundJob).where(backgroundIdentity(value)).limit(1))[0];
    },
    async acquireBackgroundJobLease(input) {
      const value = backgroundJobLeaseSchema.parse(input);
      const [result] = await db.update(mysqlBackgroundJob).set({ leaseOwner: value.leaseOwner, leaseUntil: sql`${backgroundNow} + ${value.ttlMs}`, leaseGeneration: sql`${mysqlBackgroundJob.leaseGeneration} + 1` })
        .where(and(backgroundIdentity(value), sql`${mysqlBackgroundJob.leaseUntil} <= ${backgroundNow}`, sql`${mysqlBackgroundJob.leaseGeneration} < 2147483646`));
      return result.affectedRows === 1;
    },
    async renewBackgroundJobLease(input) {
      const value = backgroundJobRenewSchema.parse(input);
      const [result] = await db.update(mysqlBackgroundJob).set({ leaseUntil: sql`${backgroundNow} + ${value.ttlMs}` }).where(backgroundLease(value));
      return result.affectedRows === 1;
    },
    async updateBackgroundJob(input) {
      const value = backgroundJobUpdateSchema.parse(input);
      const [result] = await db.update(mysqlBackgroundJob).set({ payload: value.payload, revision: sql`${mysqlBackgroundJob.revision} + 1` })
        .where(and(backgroundLease(value), eq(mysqlBackgroundJob.revision, value.expectedRevision),
          value.requireDisabledUserId ? sql`EXISTS (SELECT 1 FROM ${mysqlUser} WHERE ${mysqlUser.id} = ${value.requireDisabledUserId} AND ${mysqlUser.disabled} = 1)` : undefined,
          value.requireEnabledUserId ? sql`EXISTS (SELECT 1 FROM ${mysqlUser} WHERE ${mysqlUser.id} = ${value.requireEnabledUserId} AND ${mysqlUser.disabled} = 0)` : undefined));
      return result.affectedRows === 1;
    },
    async releaseBackgroundJobLease(input) {
      const value = backgroundJobReleaseSchema.parse(input);
      const [result] = await db.update(mysqlBackgroundJob).set({ leaseOwner: null, leaseUntil: 0 }).where(backgroundLease(value));
      return result.affectedRows === 1;
    },
    async close() { await client.end(); },
    async initializeBilling() {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantWallet (
        userId VARCHAR(36) NOT NULL,
        currency ENUM('CNY', 'USD') NOT NULL,
        balanceMicros BIGINT NOT NULL DEFAULT 0,
        reservedMicros BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (userId, currency),
        CHECK (balanceMicros >= 0 AND balanceMicros <= 9007199254740991),
        CHECK (reservedMicros >= 0 AND reservedMicros <= balanceMicros)
      ) ENGINE=InnoDB`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantBillingLedger (
        requestId VARCHAR(36) PRIMARY KEY,
        userId VARCHAR(36) NOT NULL,
        currency ENUM('CNY', 'USD') NOT NULL,
        kind ENUM('credit', 'model') NOT NULL,
        status ENUM('reserved', 'settled', 'released') NOT NULL,
        requestHash VARCHAR(64) NOT NULL,
        reservedMicros BIGINT NOT NULL DEFAULT 0,
        amountMicros BIGINT NOT NULL DEFAULT 0,
        details JSON NOT NULL,
        \`usage\` JSON,
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL,
        INDEX multiTenantBillingLedgerUserCreatedAt (userId, createdAt),
        CHECK (reservedMicros >= 0 AND reservedMicros <= 9007199254740991),
        CHECK (amountMicros >= 0 AND amountMicros <= 9007199254740991)
      ) ENGINE=InnoDB`);
      await requireBillingEngine();
    },
    async getWallets(userId) {
      try {
        const wallets = await db.select().from(mysqlWallet).where(eq(mysqlWallet.userId, userId)).orderBy(asc(mysqlWallet.currency));
        return wallets.map(requireWallet);
      }
      catch (error) {
        if (errorCode(error) === "ER_NO_SUCH_TABLE") return [];
        throw error;
      }
    },
    async getBillingRecord(requestId) {
      try { return (await db.select().from(mysqlBillingLedger).where(eq(mysqlBillingLedger.requestId, requestId)).limit(1))[0]; }
      catch (error) {
        if (errorCode(error) === "ER_NO_SUCH_TABLE") return;
        throw error;
      }
    },
    async listBillingRecords(userId, limit) {
      try {
        return await db.select().from(mysqlBillingLedger).where(eq(mysqlBillingLedger.userId, userId))
          .orderBy(desc(mysqlBillingLedger.createdAt), desc(mysqlBillingLedger.requestId)).limit(limit);
      } catch (error) {
        if (errorCode(error) === "ER_NO_SUCH_TABLE") return [];
        throw error;
      }
    },
    async creditWallet(record) {
      validateWalletAmount(record.amountMicros);
      await requireBillingEngine();
      return db.transaction(async tx => {
        try {
          await tx.insert(mysqlBillingLedger).values({ ...record, kind: "credit", status: "settled", reservedMicros: 0,
            usage: null, updatedAt: record.createdAt });
        } catch (error) {
          if (errorCode(error) === "ER_DUP_ENTRY") return "duplicate" as const;
          throw error;
        }
        // 所有资金事务先锁请求流水，再锁钱包；不能反向持锁等待其他流水。
        await tx.insert(mysqlWallet).values({ userId: record.userId, currency: record.currency, balanceMicros: 0, reservedMicros: 0 })
          .onDuplicateKeyUpdate({ set: { userId: record.userId } });
        const [found] = await tx.select().from(mysqlWallet)
          .where(and(eq(mysqlWallet.userId, record.userId), eq(mysqlWallet.currency, record.currency))).limit(1).for("update");
        const wallet = requireWallet(found);
        if (wallet.balanceMicros > maxWalletMicros - record.amountMicros) walletBalanceOverflow();
        if (record.amountMicros > 0) {
          const [result] = await tx.update(mysqlWallet).set({ balanceMicros: sql`${mysqlWallet.balanceMicros} + ${record.amountMicros}` })
            .where(and(eq(mysqlWallet.userId, record.userId), eq(mysqlWallet.currency, record.currency),
              sql`${mysqlWallet.balanceMicros} <= ${maxWalletMicros - record.amountMicros}`));
          if (result.affectedRows !== 1) walletStateConflict();
        }
        return "created" as const;
      });
    },
    async reserveWallet(record) {
      validateWalletAmount(record.reservedMicros);
      await requireBillingEngine();
      try {
        return await db.transaction(async tx => {
          try {
            await tx.insert(mysqlBillingLedger).values({ ...record, kind: "model", status: "reserved", amountMicros: 0,
              usage: null, updatedAt: record.createdAt });
          } catch (error) {
            if (errorCode(error) === "ER_DUP_ENTRY") return "duplicate" as const;
            throw error;
          }
          await tx.insert(mysqlWallet).values({ userId: record.userId, currency: record.currency, balanceMicros: 0, reservedMicros: 0 })
            .onDuplicateKeyUpdate({ set: { userId: record.userId } });
          const [found] = await tx.select().from(mysqlWallet)
            .where(and(eq(mysqlWallet.userId, record.userId), eq(mysqlWallet.currency, record.currency))).limit(1).for("update");
          const wallet = requireWallet(found);
          // 抛出仅用于事务回滚；余额不足时，新流水与零钱包都不提交。
          if (wallet.balanceMicros - wallet.reservedMicros < record.reservedMicros) throw insufficientWallet;
          if (record.reservedMicros > 0) {
            const [result] = await tx.update(mysqlWallet).set({ reservedMicros: sql`${mysqlWallet.reservedMicros} + ${record.reservedMicros}` })
              .where(and(eq(mysqlWallet.userId, record.userId), eq(mysqlWallet.currency, record.currency),
                sql`${mysqlWallet.balanceMicros} - ${mysqlWallet.reservedMicros} >= ${record.reservedMicros}`));
            if (result.affectedRows !== 1) walletStateConflict();
          }
          return "created" as const;
        });
      } catch (error) {
        if (error === insufficientWallet) return "insufficient";
        throw error;
      }
    },
    async settleWallet(requestId, userId, amountMicros, usage, at) {
      validateWalletAmount(amountMicros);
      await requireBillingEngine();
      return db.transaction(async tx => {
        const [record] = await tx.select().from(mysqlBillingLedger).where(eq(mysqlBillingLedger.requestId, requestId)).limit(1).for("update");
        if (!record || record.userId !== userId || record.kind !== "model" || record.status !== "reserved") return false;
        if (!Number.isSafeInteger(record.reservedMicros) || record.reservedMicros < 0 || record.reservedMicros > maxWalletMicros
          || record.amountMicros !== 0) walletStateConflict();
        if (amountMicros > record.reservedMicros) walletSettlementExceeded();
        const [found] = await tx.select().from(mysqlWallet)
          .where(and(eq(mysqlWallet.userId, userId), eq(mysqlWallet.currency, record.currency))).limit(1).for("update");
        const wallet = requireWallet(found);
        if (wallet.reservedMicros < record.reservedMicros || wallet.balanceMicros < amountMicros) walletStateConflict();
        if (record.reservedMicros > 0 || amountMicros > 0) {
          const [result] = await tx.update(mysqlWallet).set({ balanceMicros: sql`${mysqlWallet.balanceMicros} - ${amountMicros}`,
            reservedMicros: sql`${mysqlWallet.reservedMicros} - ${record.reservedMicros}` })
            .where(and(eq(mysqlWallet.userId, userId), eq(mysqlWallet.currency, record.currency),
              sql`${mysqlWallet.balanceMicros} >= ${amountMicros}`, sql`${mysqlWallet.reservedMicros} >= ${record.reservedMicros}`));
          if (result.affectedRows !== 1) walletStateConflict();
        }
        const [result] = await tx.update(mysqlBillingLedger).set({ status: "settled", amountMicros, usage, updatedAt: at })
          .where(and(eq(mysqlBillingLedger.requestId, requestId), eq(mysqlBillingLedger.userId, userId), eq(mysqlBillingLedger.status, "reserved")));
        if (result.affectedRows !== 1) walletStateConflict();
        return true;
      });
    },
    async releaseWallet(requestId, userId, at, usage) {
      await requireBillingEngine();
      return db.transaction(async tx => {
        const [record] = await tx.select().from(mysqlBillingLedger).where(eq(mysqlBillingLedger.requestId, requestId)).limit(1).for("update");
        if (!record || record.userId !== userId || record.kind !== "model" || record.status !== "reserved") return false;
        if (!Number.isSafeInteger(record.reservedMicros) || record.reservedMicros < 0 || record.reservedMicros > maxWalletMicros
          || record.amountMicros !== 0) walletStateConflict();
        const [found] = await tx.select().from(mysqlWallet)
          .where(and(eq(mysqlWallet.userId, userId), eq(mysqlWallet.currency, record.currency))).limit(1).for("update");
        const wallet = requireWallet(found);
        if (wallet.reservedMicros < record.reservedMicros) walletStateConflict();
        if (record.reservedMicros > 0) {
          const [result] = await tx.update(mysqlWallet).set({ reservedMicros: sql`${mysqlWallet.reservedMicros} - ${record.reservedMicros}` })
            .where(and(eq(mysqlWallet.userId, userId), eq(mysqlWallet.currency, record.currency),
              sql`${mysqlWallet.reservedMicros} >= ${record.reservedMicros}`));
          if (result.affectedRows !== 1) walletStateConflict();
        }
        const [result] = await tx.update(mysqlBillingLedger).set({ status: "released", amountMicros: 0, usage: usage ?? record.usage, updatedAt: at })
          .where(and(eq(mysqlBillingLedger.requestId, requestId), eq(mysqlBillingLedger.userId, userId), eq(mysqlBillingLedger.status, "reserved")));
        if (result.affectedRows !== 1) walletStateConflict();
        return true;
      });
    },
    async initializeSettings() {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantSettings (
        id INT PRIMARY KEY,
        registrationEnabled BOOLEAN NOT NULL DEFAULT TRUE
      )`);
      await db.insert(mysqlSettings).values({ id: 1, registrationEnabled: true }).onDuplicateKeyUpdate({ set: { id: 1 } });
    },
    async getRegistrationEnabled() {
      try {
        const [settings] = await db.select({ enabled: mysqlSettings.registrationEnabled }).from(mysqlSettings).where(eq(mysqlSettings.id, 1)).limit(1);
        return settings?.enabled ?? true;
      } catch (error) {
        const failure = error as { code?: string; cause?: { code?: string } };
        if ((failure.cause?.code ?? failure.code) === "ER_NO_SUCH_TABLE") return true;
        throw error;
      }
    },
    async setRegistrationEnabled(enabled) {
      await db.insert(mysqlSettings).values({ id: 1, registrationEnabled: enabled }).onDuplicateKeyUpdate({ set: { registrationEnabled: enabled } });
    },
    async getSourceMapping() {
      try {
        const [mapping] = await db.select({ mappings: mysqlSourceMapping.mappings, revision: mysqlSourceMapping.revision })
          .from(mysqlSourceMapping).where(eq(mysqlSourceMapping.id, 1)).limit(1);
        return mapping;
      } catch (error) {
        const failure = error as { code?: string; cause?: { code?: string } };
        if ((failure.cause?.code ?? failure.code) === "ER_NO_SUCH_TABLE") return;
        throw error;
      }
    },
    async initializeSourceMapping() {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantSourceMapping (
        id INT PRIMARY KEY,
        mappings JSON NOT NULL,
        revision INT NOT NULL
      )`);
    },
    async writeSourceMapping(mappings, expectedRevision) {
      if (expectedRevision === 0) {
        try {
          await db.insert(mysqlSourceMapping).values({ id: 1, mappings, revision: 1 });
          return true;
        } catch (error) {
          const failure = error as { code?: string; cause?: { code?: string } };
          if ((failure.cause?.code ?? failure.code) === "ER_DUP_ENTRY") return false;
          throw error;
        }
      }
      const [result] = await db.update(mysqlSourceMapping).set({ mappings, revision: expectedRevision + 1 })
        .where(and(eq(mysqlSourceMapping.id, 1), eq(mysqlSourceMapping.revision, expectedRevision)));
      return result.affectedRows === 1;
    },
    async getModelRouting() {
      try {
        const [routing] = await db.select({ configuration: mysqlModelRouting.configuration, revision: mysqlModelRouting.revision })
          .from(mysqlModelRouting).where(eq(mysqlModelRouting.id, 1)).limit(1);
        return routing;
      } catch (error) {
        const failure = error as { code?: string; cause?: { code?: string } };
        if ((failure.cause?.code ?? failure.code) === "ER_NO_SUCH_TABLE") return;
        throw error;
      }
    },
    async initializeUserProviderGuard() {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantUserProviderGuard (id INT PRIMARY KEY, cipher VARCHAR(8192) NOT NULL)`);
    },
    async getUserProviderGuard() {
      const [value] = await db.select({ cipher: mysqlUserProviderGuard.cipher }).from(mysqlUserProviderGuard).where(eq(mysqlUserProviderGuard.id, 1)).limit(1);
      return value?.cipher;
    },
    async insertUserProviderGuard(cipher) {
      try { await db.insert(mysqlUserProviderGuard).values({ id: 1, cipher }); return true; }
      catch (error) {
        const failure = error as { code?: string; cause?: { code?: string } };
        if ((failure.cause?.code ?? failure.code) === "ER_DUP_ENTRY") return false;
        throw error;
      }
    },
    async hasUserProviderKeys() {
      const [value] = await db.select({ userId: mysqlUserProviderKey.userId }).from(mysqlUserProviderKey).limit(1);
      return value !== undefined;
    },
    async getUserProviderKey(userId, providerId) {
      const [value] = await db.select({ cipher: mysqlUserProviderKey.cipher, revision: mysqlUserProviderKey.revision }).from(mysqlUserProviderKey)
        .where(and(eq(mysqlUserProviderKey.userId, userId), eq(mysqlUserProviderKey.providerId, providerId))).limit(1);
      return value;
    },
    async initializeUserProviderKeys() {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantUserProviderKey (
        userId VARCHAR(36) NOT NULL, providerId VARCHAR(96) NOT NULL, cipher VARCHAR(8192) NOT NULL, revision INT NOT NULL,
        PRIMARY KEY (userId, providerId)
      )`);
    },
    async writeUserProviderKey(userId, providerId, cipher, expectedRevision) {
      if (expectedRevision === 0) {
        try { await db.insert(mysqlUserProviderKey).values({ userId, providerId, cipher, revision: 1 }); return true; }
        catch (error) {
          const failure = error as { code?: string; cause?: { code?: string } };
          if ((failure.cause?.code ?? failure.code) === "ER_DUP_ENTRY") return false;
          throw error;
        }
      }
      const [result] = await db.update(mysqlUserProviderKey).set({ cipher, revision: expectedRevision + 1 })
        .where(and(eq(mysqlUserProviderKey.userId, userId), eq(mysqlUserProviderKey.providerId, providerId), eq(mysqlUserProviderKey.revision, expectedRevision)));
      return result.affectedRows === 1;
    },
    async initializeModelRouting() {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantModelRouting (
        id INT PRIMARY KEY,
        configuration JSON NOT NULL,
        revision INT NOT NULL
      )`);
    },
    async writeModelRouting(configuration, expectedRevision) {
      if (expectedRevision === 0) {
        try {
          await db.insert(mysqlModelRouting).values({ id: 1, configuration, revision: 1 });
          return true;
        } catch (error) {
          const failure = error as { code?: string; cause?: { code?: string } };
          if ((failure.cause?.code ?? failure.code) === "ER_DUP_ENTRY") return false;
          throw error;
        }
      }
      const [result] = await db.update(mysqlModelRouting).set({ configuration, revision: expectedRevision + 1 })
        .where(and(eq(mysqlModelRouting.id, 1), eq(mysqlModelRouting.revision, expectedRevision)));
      return result.affectedRows === 1;
    },
    async initialize() {
      if (initialized) return;
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantAdmin (
        id INT PRIMARY KEY,
        userName VARCHAR(64) NOT NULL DEFAULT 'admin',
        passwordHash VARCHAR(255) NOT NULL,
        sessionHash VARCHAR(64),
        sessionExpiresAt BIGINT NOT NULL DEFAULT 0,
        failedAttempts INT NOT NULL DEFAULT 0,
        lockedUntil BIGINT NOT NULL DEFAULT 0
      )`);
      if (!(await columns()).some(column => column.columnName === "userName")) {
        try { await db.execute(sql`ALTER TABLE multiTenantAdmin ADD COLUMN userName VARCHAR(64) NOT NULL DEFAULT 'admin'`); }
        catch (error) {
          const failure = error as { code?: string; cause?: { code?: string } };
          if ((failure.cause?.code ?? failure.code) !== "ER_DUP_FIELDNAME") throw error;
          if (!(await columns()).some(column => column.columnName === "userName")) throw error;
        }
      }
      accountColumn = true;
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantUser (
        id VARCHAR(36) PRIMARY KEY,
        userName VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
        userNameKey VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL UNIQUE,
        passwordHash VARCHAR(255) NOT NULL,
        failedAttempts INT NOT NULL DEFAULT 0,
        lockedUntil BIGINT NOT NULL DEFAULT 0,
        settings JSON,
        settingsRevision INT NOT NULL DEFAULT 0,
        disabled BOOLEAN NOT NULL DEFAULT FALSE,
        authVersion INT NOT NULL DEFAULT 0,
        createdAt BIGINT NOT NULL DEFAULT 0,
        lastLoginAt BIGINT NOT NULL DEFAULT 0
      )`);
      const userColumns = await columns("multiTenantUser");
      for (const [name, migration] of [
        ["settings", sql`ALTER TABLE multiTenantUser ADD COLUMN settings JSON`],
        ["settingsRevision", sql`ALTER TABLE multiTenantUser ADD COLUMN settingsRevision INT NOT NULL DEFAULT 0`],
        ["disabled", sql`ALTER TABLE multiTenantUser ADD COLUMN disabled BOOLEAN NOT NULL DEFAULT FALSE`],
        ["authVersion", sql`ALTER TABLE multiTenantUser ADD COLUMN authVersion INT NOT NULL DEFAULT 0`],
        ["createdAt", sql`ALTER TABLE multiTenantUser ADD COLUMN createdAt BIGINT NOT NULL DEFAULT 0`],
        ["lastLoginAt", sql`ALTER TABLE multiTenantUser ADD COLUMN lastLoginAt BIGINT NOT NULL DEFAULT 0`],
      ] as const) {
        if (userColumns.some(column => column.columnName === name)) continue;
        try { await db.execute(migration); }
        catch (error) {
          const failure = error as { code?: string; cause?: { code?: string } };
          if ((failure.cause?.code ?? failure.code) !== "ER_DUP_FIELDNAME"
            || !(await columns("multiTenantUser")).some(column => column.columnName === name)) throw error;
        }
      }
      await db.execute(sql`CREATE TABLE IF NOT EXISTS multiTenantWebSession (
        tokenHash VARCHAR(64) PRIMARY KEY,
        userId VARCHAR(36) NOT NULL,
        role ENUM('admin', 'user') NOT NULL,
        expiresAt BIGINT NOT NULL,
        authVersion INT NOT NULL DEFAULT 0
      )`);
      if (!(await columns("multiTenantWebSession")).some(column => column.columnName === "authVersion")) {
        try { await db.execute(sql`ALTER TABLE multiTenantWebSession ADD COLUMN authVersion INT NOT NULL DEFAULT 0`); }
        catch (error) {
          const failure = error as { code?: string; cause?: { code?: string } };
          if ((failure.cause?.code ?? failure.code) !== "ER_DUP_FIELDNAME"
            || !(await columns("multiTenantWebSession")).some(column => column.columnName === "authVersion")) throw error;
        }
      }
      initialized = true;
    },
    async getAdmin() {
      if (accountColumn === undefined) {
        const current = await columns();
        if (!current.length) return;
        accountColumn = current.some(column => column.columnName === "userName");
      }
      return (await db.select({ ...getTableColumns(mysqlAdmin), userName: accountColumn ? mysqlAdmin.userName : sql<string>`${"admin"}` })
        .from(mysqlAdmin).where(eq(mysqlAdmin.id, 1)).limit(1))[0];
    },
    async createAdmin(userName, passwordHash) {
      await db.insert(mysqlAdmin).values({ id: 1, userName, passwordHash });
    },
    async updateAdmin(values) {
      await db.update(mysqlAdmin).set(values).where(eq(mysqlAdmin.id, 1));
    },
    async getUser(userNameKey) {
      return (await db.select().from(mysqlUser).where(eq(mysqlUser.userNameKey, userNameKey)).limit(1))[0];
    },
    async getUserById(id) {
      return (await db.select().from(mysqlUser).where(eq(mysqlUser.id, id)).limit(1))[0];
    },
    async createUser(user) {
      await db.insert(mysqlUser).values({ ...user, settings: {}, settingsRevision: 0 });
    },
    async updateUser(id, values, expectedAuthVersion) {
      await db.update(mysqlUser).set(values).where(and(eq(mysqlUser.id, id),
        expectedAuthVersion === undefined ? undefined : eq(mysqlUser.authVersion, expectedAuthVersion)));
    },
    async completeUserLogin(id, expectedAuthVersion, at) {
      const [result] = await db.update(mysqlUser).set({ failedAttempts: 0, lockedUntil: 0, lastLoginAt: at })
        .where(and(eq(mysqlUser.id, id), eq(mysqlUser.disabled, false), eq(mysqlUser.authVersion, expectedAuthVersion)));
      return result.affectedRows === 1;
    },
    async listUsers(options) {
      const pattern = `%${options.search.replace(/[!%_]/g, "!$&")}%`;
      const condition = and(options.search ? sql`${mysqlUser.userNameKey} LIKE ${pattern} ESCAPE '!'` : undefined,
        options.status === "all" ? undefined : eq(mysqlUser.disabled, options.status === "disabled"));
      const [total] = await db.select({ value: count() }).from(mysqlUser).where(condition);
      const items = await db.select({ id: mysqlUser.id, userName: mysqlUser.userName, disabled: mysqlUser.disabled,
        createdAt: mysqlUser.createdAt, lastLoginAt: mysqlUser.lastLoginAt }).from(mysqlUser).where(condition)
        .orderBy(desc(mysqlUser.createdAt), asc(mysqlUser.userNameKey)).limit(options.pageSize).offset((options.page - 1) * options.pageSize);
      return { items, total: total!.value };
    },
    async setUserDisabled(id, disabled) {
      const [result] = await db.update(mysqlUser).set({ disabled, authVersion: sql`${mysqlUser.authVersion} + 1` }).where(eq(mysqlUser.id, id));
      return result.affectedRows === 1;
    },
    async resetUserPassword(id, passwordHash) {
      const [result] = await db.update(mysqlUser).set({ passwordHash, failedAttempts: 0, lockedUntil: 0, authVersion: sql`${mysqlUser.authVersion} + 1` })
        .where(eq(mysqlUser.id, id));
      return result.affectedRows === 1;
    },
    async createWebSession(session) {
      await db.insert(mysqlWebSession).values(session);
    },
    async getWebSession(tokenHash) {
      try { return (await db.select().from(mysqlWebSession).where(eq(mysqlWebSession.tokenHash, tokenHash)).limit(1))[0]; }
      catch (error) {
        const failure = error as { code?: string; cause?: { code?: string } };
        if ((failure.cause?.code ?? failure.code) === "ER_NO_SUCH_TABLE") return;
        throw error;
      }
    },
    async expireWebSession(tokenHash) {
      await db.update(mysqlWebSession).set({ expiresAt: 0 }).where(eq(mysqlWebSession.tokenHash, tokenHash));
    },
    async writeUserSettings(userId, settings, expectedRevision) {
      const [result] = await db.update(mysqlUser).set({ settings, settingsRevision: expectedRevision + 1 })
        .where(and(eq(mysqlUser.id, userId), eq(mysqlUser.settingsRevision, expectedRevision)));
      return result.affectedRows === 1;
    },
  };
}
