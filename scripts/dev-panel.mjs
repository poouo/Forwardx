import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createServer } from "vite";

const root = process.cwd();
const devDir = path.join(root, ".dev");
const sqlitePath = path.join(devDir, "forwardx-dev.db");
const databaseConfigPath = path.join(devDir, "database.json");
const jwtSecretPath = path.join(devDir, "jwt.secret");
const serverPort = Number.parseInt(process.env.FORWARDX_DEV_SERVER_PORT || "3000", 10);
const clientPort = Number.parseInt(process.env.FORWARDX_DEV_CLIENT_PORT || "5173", 10);
const host = process.env.HOST || "127.0.0.1";
let shuttingDown = false;

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(port, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canConnect(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

fs.mkdirSync(devDir, { recursive: true });
fs.writeFileSync(databaseConfigPath, JSON.stringify({
  type: "sqlite",
  sqlite: { path: sqlitePath },
}, null, 2));

const serverEnv = {
  ...process.env,
  NODE_ENV: "development",
  FORWARDX_DEV_PANEL: "1",
  DATABASE_TYPE: "sqlite",
  DATABASE_CONFIG_PATH: databaseConfigPath,
  SQLITE_PATH: sqlitePath,
  FORWARDX_JWT_SECRET_PATH: jwtSecretPath,
  PORT: String(serverPort),
};

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const server = spawn(command, ["exec", "tsx", "server/index.ts"], {
  cwd: root,
  env: serverEnv,
  stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32",
});

server.stdout.on("data", (chunk) => process.stdout.write(chunk));
server.stderr.on("data", (chunk) => process.stderr.write(chunk));
server.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.error(`[ForwardX] dev panel server exited: ${signal || code}`);
  void shutdown(code || 1);
});

if (!await waitForServer(serverPort)) {
  console.error(`[ForwardX] dev panel server did not become ready on port ${serverPort}`);
  await shutdown(1);
}

const vite = await createServer({
  configFile: "vite.config.ts",
  mode: "development",
  server: {
    host,
    port: clientPort,
    strictPort: false,
    open: false,
    proxy: {
      "/api": `http://127.0.0.1:${serverPort}`,
    },
  },
  define: {
    "import.meta.env.VITE_FORWARDX_DEV_PANEL": JSON.stringify("1"),
  },
});

await vite.listen();

const localUrls = vite.resolvedUrls?.local || [];
const baseUrl = localUrls[0] || `http://${host}:${clientPort}/`;

console.log("");
console.log("[ForwardX] 本地真实开发后台已启动");
console.log(`[ForwardX] 访问地址：${baseUrl}`);
console.log(`[ForwardX] 公开主机监控：${new URL("dev", baseUrl).toString()}`);
console.log(`[ForwardX] 本地 SQLite：${sqlitePath}`);
console.log(`[ForwardX] 开发管理员：dev.admin@forwardx.local / forwardx-dev`);
console.log("[ForwardX] 该模式使用真实页面、真实路由和真实组件，只是数据为本地开发数据。");
console.log("[ForwardX] 按 Ctrl+C 停止服务。");
console.log("");

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await vite.close().catch(() => undefined);
  if (!server.killed) server.kill();
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
