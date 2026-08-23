import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createLogger, createServer } from "vite";

const root = process.cwd();
const devDir = path.join(root, ".dev");
const sqlitePath = path.join(devDir, "forwardx-dev.db");
const databaseConfigPath = path.join(devDir, "database.json");
const jwtSecretPath = path.join(devDir, "jwt.secret");
const serverPort = Number.parseInt(process.env.FORWARDX_DEV_SERVER_PORT || "3000", 10);
const clientPort = Number.parseInt(process.env.FORWARDX_DEV_CLIENT_PORT || "5173", 10);
const host = process.env.HOST || "127.0.0.1";
let shuttingDown = false;
let vite = null;
let backendPort = null;
let shutdownPromise = null;
let backendExited = false;

// An in-flight browser poll can be reset while the child server is shutting
// down. Vite otherwise prints a full stack for that expected close; real
// backend failures are still reported by the child exit handler below.
const viteLogger = createLogger("info");
const defaultViteError = viteLogger.error.bind(viteLogger);
viteLogger.error = (message, options) => {
  const errorText = `${message}\n${options?.error instanceof Error ? options.error.stack || options.error.message : ""}`;
  if (/http proxy error:[\s\S]*ECONNRESET/i.test(errorText)) return;
  defaultViteError(message, options);
};

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

function waitForChildExit(child, timeoutMs = 2_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function killServerTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    await waitForChildExit(child);
    return;
  }
  await new Promise((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("exit", resolve);
    killer.once("error", resolve);
  });
  await waitForChildExit(child);
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

// Run the server through the current Node process so Windows does not leave a
// pnpm/cmd wrapper behind or deliver console signals to only part of the tree.
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  cwd: root,
  env: serverEnv,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
});

let startupOutput = "";
let backendReadyResolve;
let backendReadyReject;
const backendReady = new Promise((resolve, reject) => {
  backendReadyResolve = resolve;
  backendReadyReject = reject;
});

server.stdout.on("data", (chunk) => {
  const output = chunk.toString();
  process.stdout.write(output);
  // Read the port from the child instead of assuming the preferred port. In
  // development mode the server may select the next available port.
  startupOutput = `${startupOutput}${output}`.slice(-8_192);
  const match = startupOutput.match(/ForwardX panel started on \S+ port (\d+)/);
  if (match && !backendPort) {
    const port = Number.parseInt(match[1], 10);
    if (Number.isInteger(port) && port > 0 && port < 65_536) {
      backendPort = port;
      backendReadyResolve(port);
    }
  }
});
server.stderr.on("data", (chunk) => process.stderr.write(chunk));
server.on("error", (error) => {
  backendReadyReject(error);
});
server.on("exit", (code, signal) => {
  backendExited = true;
  if (shuttingDown) return;
  const reason = signal || code || 1;
  const error = new Error(`[ForwardX] dev panel server exited: ${reason}`);
  if (!backendPort) backendReadyReject(error);
  else {
    console.error(error.message);
    void shutdown(typeof code === "number" && code !== 0 ? code : 1);
  }
});

let readyTimer;
try {
  readyTimer = setTimeout(() => {
    backendReadyReject(new Error(`[ForwardX] dev panel server did not announce a listening port within 20s (preferred port ${serverPort})`));
  }, 20_000);
  backendPort = await backendReady;
  if (!await waitForServer(backendPort, 5_000)) {
    throw new Error(`[ForwardX] dev panel server announced port ${backendPort}, but it is not accepting connections`);
  }
} catch (error) {
  clearTimeout(readyTimer);
  console.error(error instanceof Error ? error.message : error);
  await shutdown(1);
  process.exit(1);
} finally {
  clearTimeout(readyTimer);
}

try {
  vite = await createServer({
    configFile: "vite.config.ts",
    mode: "development",
    customLogger: viteLogger,
    server: {
      host,
      port: clientPort,
      strictPort: false,
      open: false,
      proxy: {
        "/api": `http://127.0.0.1:${backendPort}`,
      },
    },
    define: {
      "import.meta.env.VITE_FORWARDX_DEV_PANEL": JSON.stringify("1"),
    },
  });

  await vite.listen();
} catch (error) {
  console.error(`[ForwardX] Vite dev server failed: ${error instanceof Error ? error.message : error}`);
  await shutdown(1);
  process.exit(1);
}

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
  if (shutdownPromise) {
    await shutdownPromise;
    process.exitCode = process.exitCode || exitCode;
    return;
  }
  shuttingDown = true;
  shutdownPromise = (async () => {
    if (vite) await vite.close().catch(() => undefined);
    await killServerTree(server);
    process.exitCode = exitCode;
  })();
  await shutdownPromise;
}

const handleSignal = () => void shutdown(0).then(() => process.exit(0));
process.on("SIGINT", handleSignal);
process.on("SIGTERM", handleSignal);
