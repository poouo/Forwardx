import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import net from "net";
import path from "path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { agentRouter } from "./agentRoutes";
import { initDatabase } from "./db";
import * as db from "./db";
import { installPanelLogger } from "./_core/panelLogger";

installPanelLogger();

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

function serveStatic(app: express.Express) {
  const clientDist = path.resolve(__dirname, "../client/dist");
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// ==================== 定时任务 ====================

/** 月度流量自动重置：每天 00:05 执行，检查当天是否为用户设定的重置日 */
async function runMonthlyTrafficReset() {
  try {
    const today = new Date().getDate(); // 1-31
    const usersToReset = await db.getUsersForAutoReset(today);
    for (const user of usersToReset) {
      await db.resetUserTraffic(user.id);
      console.log(`[Scheduler] Auto-reset traffic for user ${user.id} (${user.username})`);
    }
    if (usersToReset.length > 0) {
      console.log(`[Scheduler] Monthly traffic reset: ${usersToReset.length} user(s) reset`);
    }
  } catch (error) {
    console.error("[Scheduler] Monthly traffic reset error:", error);
  }
}

/** 到期检查：每小时执行，到期用户自动禁用所有规则 */
async function runExpirationCheck() {
  try {
    const expiredUsers = await db.getExpiredUsers();
    for (const user of expiredUsers) {
      await db.disableAllUserRules(user.id);
      console.log(`[Scheduler] User ${user.id} (${user.username}) expired, disabled all rules`);
    }
    if (expiredUsers.length > 0) {
      console.log(`[Scheduler] Expiration check: ${expiredUsers.length} user(s) expired`);
    }
  } catch (error) {
    console.error("[Scheduler] Expiration check error:", error);
  }
}

/** 转发自测超时清理：每 30 秒扫一次，超过 60 秒未完成的任务标为 timeout */
async function runSelfTestTimeoutSweep() {
  try {
    const n = await db.timeoutStaleForwardTests(60);
    if (n > 0) {
      console.log(`[Scheduler] Self-test timeout sweep: ${n} test(s) marked as timeout`);
    }
  } catch (error) {
    console.error("[Scheduler] Self-test timeout sweep error:", error);
  }
}

/** TCPing 数据清理：保留最近 48 小时的数据 */
async function runTcpingCleanup() {
  try {
    await db.cleanOldTcpingStats(48);
  } catch (error) {
    console.error("[Scheduler] TCPing cleanup error:", error);
  }
}

function startScheduler() {
  // 月度流量重置：每小时检查一次（在整点的第5分钟）
  setInterval(async () => {
    const now = new Date();
    if (now.getMinutes() < 10) {
      // 仅在每小时的前10分钟内执行，避免重复
      await runMonthlyTrafficReset();
    }
  }, 60 * 60 * 1000); // 每小时

  // 到期检查：每小时执行
  setInterval(async () => {
    await runExpirationCheck();
  }, 60 * 60 * 1000); // 每小时

  // 转发自测超时扫描：每 30 秒一次
  setInterval(async () => {
    await runSelfTestTimeoutSweep();
  }, 30 * 1000);

  // TCPing 数据清理：每小时清理一次
  setInterval(async () => {
    await runTcpingCleanup();
  }, 60 * 60 * 1000);

  // 启动时立即执行一次
  setTimeout(async () => {
    await runMonthlyTrafficReset();
    await runExpirationCheck();
    await runSelfTestTimeoutSweep();
    await runTcpingCleanup();
  }, 5000); // 延迟5秒等数据库初始化完成

  console.log("[Scheduler] Scheduled tasks started (monthly reset + expiration check + selftest timeout sweep + tcping cleanup)");
}

// ==================== 启动服务器 ====================

async function startServer() {
  // Initialize database tables and seed default admin
  await initDatabase();

  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.use(cookieParser());
  // Agent API routes (no auth middleware, uses token-based auth)
  app.use(agentRouter);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // production mode uses static files
  serveStatic(app);

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.warn(`[Server] Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.info(`Server running on http://localhost:${port}/`);
    console.info(`[Server] ForwardX panel started on port ${port}`);
  });

  // 启动定时任务
  startScheduler();
}

startServer().catch(console.error);
