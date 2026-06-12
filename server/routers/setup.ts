import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "../_core/trpc";
import { MIGRATION_TABLES, ensureDatabaseSchema } from "../dbSchema";
import {
  DatabaseConfig,
  DatabaseDialectMismatchError,
  closeDatabase,
  defaultSqlitePath,
  executeRaw,
  getConfiguredDatabaseKind,
  getDb,
  getDatabaseKind,
  getSchemaDialect,
  maskDatabaseConfig,
  queryRaw,
  readDatabaseConfig,
  reconnectDatabase,
  testDatabaseConnection,
  writeDatabaseConfig,
} from "../dbRuntime";
import { createInitialAdmin, hasAdminUser, updateInitialAdmin } from "../db";
import { getAllSettings, setSettings } from "../repositories/settingsRepository";
import { getMigrationJob, startPanelMigration } from "../migration";

let setupSchemaReadyKey = "";

const mysqlConfigInput = z.object({
  host: z.string().trim().min(1, "请输入 MySQL 地址"),
  port: z.coerce.number().int().min(1).max(65535).default(3306),
  user: z.string().trim().min(1, "请输入 MySQL 用户名"),
  password: z.string().default(""),
  database: z.string().trim().min(1, "请输入数据库名"),
  ssl: z.boolean().default(false),
});

const postgresqlConfigInput = z.object({
  host: z.string().trim().min(1, "请输入 PostgreSQL 地址"),
  port: z.coerce.number().int().min(1).max(65535).default(5432),
  user: z.string().trim().min(1, "请输入 PostgreSQL 用户名"),
  password: z.string().default(""),
  database: z.string().trim().min(1, "请输入数据库名"),
  ssl: z.boolean().default(false),
});

const databaseConfigInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mysql"), mysql: mysqlConfigInput }),
  z.object({ type: z.literal("postgresql"), postgresql: postgresqlConfigInput }),
  z.object({
    type: z.literal("sqlite"),
    sqlite: z.object({
      path: z.string().trim().min(1).default(defaultSqlitePath()),
    }),
  }),
]);

async function ensureSetupSchemaReady() {
  const db = await getDb();
  if (!db) throw new Error("Database is not connected");
  const key = `${getConfiguredDatabaseKind() || ""}:${getDatabaseKind() || ""}`;
  if (setupSchemaReadyKey !== key) {
    await ensureDatabaseSchema();
    setupSchemaReadyKey = key;
  }
  return db;
}

async function setupStatus() {
  const config = readDatabaseConfig();
  if (!config) {
    return {
      databaseConfigured: false,
      databaseConnected: false,
      databaseType: null,
      activeDatabaseType: getDatabaseKind(),
      schemaReady: false,
      hasAdmin: false,
      hasExistingData: false,
      existingData: null,
      setupDataChoice: null,
      setupComplete: false,
      config: null,
      needsRestart: false,
      defaultSqlitePath: defaultSqlitePath(),
      error: null,
    };
  }

  try {
    const db = await getDb();
    if (!db) throw new Error("数据库未连接");
    await ensureSetupSchemaReady();
    const hasAdmin = await hasAdminUser();
    const settings = await getAllSettings();
    const setupDataChoice = settings.setupDataChoice || null;
    const fastSetupComplete = hasAdmin && (setupDataChoice === "use-existing" || setupDataChoice === "new-panel");
    const existingData = fastSetupComplete ? null : await getExistingDataSummary();
    const hasExistingData = existingData?.hasExistingData ?? false;
    return {
      databaseConfigured: true,
      databaseConnected: true,
      databaseType: config.type,
      activeDatabaseType: getDatabaseKind(),
      schemaReady: true,
      hasAdmin,
      hasExistingData,
      existingData,
      setupDataChoice,
      setupComplete: fastSetupComplete || (hasAdmin && !hasExistingData),
      config: maskDatabaseConfig(config),
      needsRestart: false,
      defaultSqlitePath: defaultSqlitePath(),
      error: null,
    };
  } catch (error) {
    const needsRestart = error instanceof DatabaseDialectMismatchError || getConfiguredDatabaseKind() !== getDatabaseKind();
    return {
      databaseConfigured: true,
      databaseConnected: false,
      databaseType: config.type,
      activeDatabaseType: getDatabaseKind(),
      schemaReady: false,
      hasAdmin: false,
      hasExistingData: false,
      existingData: null,
      setupDataChoice: null,
      setupComplete: false,
      config: maskDatabaseConfig(config),
      needsRestart,
      defaultSqlitePath: defaultSqlitePath(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function ensureSetupWriteAllowed(ctx: { user?: { role?: string } | null }) {
  if (ctx.user?.role === "admin") return;
  const config = readDatabaseConfig();
  if (!config) return;
  try {
    await ensureSetupSchemaReady();
    if (!await hasAdminUser()) return;
  } catch {
    throw new TRPCError({ code: "FORBIDDEN", message: "SETUP_LOCKED" });
  }
  throw new TRPCError({ code: "FORBIDDEN", message: "SETUP_LOCKED" });
}

function redactSetupStatusForPublic(status: Awaited<ReturnType<typeof setupStatus>>) {
  return {
    ...status,
    config: null,
    defaultSqlitePath: "",
    error: status.setupComplete || status.hasAdmin ? null : status.error,
  };
}

function quote(name: string) {
  return getDatabaseKind() === "mysql" ? `\`${name}\`` : `"${name}"`;
}

async function countTableRows(table: string) {
  try {
    const rows = await queryRaw<{ count: number }>(`SELECT COUNT(*) as "count" FROM ${quote(table)}`);
    return Number(rows[0]?.count || 0);
  } catch {
    return 0;
  }
}

async function getExistingDataSummary() {
  const counts: Record<string, number> = {};
  for (const table of MIGRATION_TABLES) {
    counts[table] = await countTableRows(table);
  }
  const userCount = counts.users || 0;
  const hostCount = counts.hosts || 0;
  const ruleCount = counts.forward_rules || 0;
  const tunnelCount = counts.tunnels || 0;
  const businessDataCount = Object.entries(counts).reduce((sum, [table, count]) => {
    if (table === "system_settings") return sum;
    if (table === "users") return sum + Math.max(0, count - 1);
    return sum + count;
  }, 0);
  const hasExistingData = businessDataCount > 0;
  return { hasExistingData, businessDataCount, userCount, hostCount, ruleCount, tunnelCount, counts };
}

async function clearExistingPanelData() {
  await reconnectDatabase();
  await ensureDatabaseSchema();
  const settings = await getAllSettings();
  for (const table of [...MIGRATION_TABLES].reverse()) {
    await executeRaw(`DELETE FROM ${quote(table)}`);
  }
  await setSettings({
    storeEnabled: settings.storeEnabled ?? "false",
    homepageEnabled: settings.homepageEnabled ?? "true",
    homepageCustomEnabled: settings.homepageCustomEnabled ?? "false",
    homepageHtml: settings.homepageHtml ?? "",
    redemptionEnabled: settings.redemptionEnabled ?? "true",
    discountEnabled: settings.discountEnabled ?? "true",
    databaseConfigured: "true",
    databaseType: getDatabaseKind() || "",
    mysqlConfigured: getDatabaseKind() === "mysql" ? "true" : "false",
    mysqlHost: settings.mysqlHost ?? "",
    mysqlDatabase: settings.mysqlDatabase ?? "",
    postgresqlConfigured: getDatabaseKind() === "postgresql" ? "true" : "false",
    postgresqlHost: settings.postgresqlHost ?? "",
    postgresqlDatabase: settings.postgresqlDatabase ?? "",
    sqlitePath: settings.sqlitePath ?? "",
    setupDataChoice: "new-panel",
  });
}

async function saveDatabase(input: DatabaseConfig) {
  await testDatabaseConnection(input);
  writeDatabaseConfig(input);
  if (getSchemaDialect() !== input.type) {
    await closeDatabase();
    setTimeout(() => process.exit(0), 800);
    return {
      ...(await setupStatus()),
      needsRestart: true,
      databaseConfigured: true,
      databaseType: input.type,
      error: "数据库类型已切换，服务正在重启以加载对应的数据库方言",
    };
  }
  const db = await reconnectDatabase();
  if (!db) throw new Error("数据库连接未建立");
  await ensureDatabaseSchema();
  await setSettings({
    databaseConfigured: "true",
    databaseType: input.type,
    mysqlConfigured: input.type === "mysql" ? "true" : "false",
    mysqlHost: input.type === "mysql" ? input.mysql.host.trim() : "",
    mysqlDatabase: input.type === "mysql" ? input.mysql.database.trim() : "",
    postgresqlConfigured: input.type === "postgresql" ? "true" : "false",
    postgresqlHost: input.type === "postgresql" ? input.postgresql.host.trim() : "",
    postgresqlDatabase: input.type === "postgresql" ? input.postgresql.database.trim() : "",
    sqlitePath: input.type === "sqlite" ? input.sqlite.path.trim() : "",
  });
  return setupStatus();
}

export const setupRouter = router({
  status: publicProcedure.query(async ({ ctx }) => {
    const status = await setupStatus();
    if (ctx.user?.role === "admin") return status;
    if (status.setupComplete || status.hasAdmin) return redactSetupStatusForPublic(status);
    return status;
  }),

  testDatabase: publicProcedure
    .input(databaseConfigInput)
    .mutation(async ({ input, ctx }) => {
      await ensureSetupWriteAllowed(ctx);
      await testDatabaseConnection(input as DatabaseConfig);
      return { success: true };
    }),

  saveDatabase: publicProcedure
    .input(databaseConfigInput)
    .mutation(async ({ input, ctx }) => {
      await ensureSetupWriteAllowed(ctx);
      return saveDatabase(input as DatabaseConfig);
    }),

  testMysql: publicProcedure
    .input(mysqlConfigInput)
    .mutation(async ({ input, ctx }) => {
      await ensureSetupWriteAllowed(ctx);
      await testDatabaseConnection({ type: "mysql", mysql: input });
      return { success: true };
    }),

  saveMysql: publicProcedure
    .input(mysqlConfigInput)
    .mutation(async ({ input, ctx }) => {
      await ensureSetupWriteAllowed(ctx);
      return saveDatabase({ type: "mysql", mysql: input });
    }),

  startMigration: publicProcedure
    .input(z.object({
      oldPanelUrl: z.string().trim().min(1, "请输入旧面板地址"),
      migrationCode: z.string().trim().min(1, "请输入旧面板迁移码"),
      targetPanelUrl: z.string().trim().min(1, "请输入新面板访问地址"),
    }))
    .mutation(async ({ input, ctx }) => {
      await ensureSetupWriteAllowed(ctx);
      await reconnectDatabase();
      await ensureDatabaseSchema();
      const job = startPanelMigration(input);
      return job;
    }),

  migrationStatus: publicProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      await ensureSetupWriteAllowed(ctx);
      return getMigrationJob(input.jobId);
    }),

  useExistingData: publicProcedure.mutation(async ({ ctx }) => {
    await ensureSetupWriteAllowed(ctx);
    await reconnectDatabase();
    await ensureDatabaseSchema();
    await setSettings({ setupDataChoice: "use-existing" });
    return setupStatus();
  }),

  resetExistingData: publicProcedure.mutation(async ({ ctx }) => {
    await ensureSetupWriteAllowed(ctx);
    await clearExistingPanelData();
    return setupStatus();
  }),

  createAdmin: publicProcedure
    .input(z.object({
      email: z.string().email("请输入有效邮箱地址").max(320),
      password: z.string().min(8, "密码至少 8 位").max(128),
      name: z.string().trim().max(64).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await ensureSetupWriteAllowed(ctx);
      await reconnectDatabase();
      await ensureDatabaseSchema();
      const id = await createInitialAdmin(input);
      await setSettings({ setupDataChoice: "new-panel" });
      return { id, success: true };
    }),

  updateAdmin: publicProcedure
    .input(z.object({
      email: z.string().email("请输入有效邮箱地址").max(320),
      password: z.string().max(128).optional(),
      name: z.string().trim().max(64).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await ensureSetupWriteAllowed(ctx);
      await reconnectDatabase();
      await ensureDatabaseSchema();
      if (input.password && input.password.length < 8) {
        throw new Error("密码至少 8 位");
      }
      const id = await updateInitialAdmin(input);
      const existingData = await getExistingDataSummary();
      await setSettings({ setupDataChoice: existingData.hasExistingData ? "use-existing" : "new-panel" });
      return { id, success: true };
    }),
});
