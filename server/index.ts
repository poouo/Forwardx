import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { agentRouter } from "./agentRoutes";
import { paymentCallbackRouter } from "./payment";
import { migrationRouter } from "./migration";
import { initDatabase } from "./db";
import { installPanelLogger } from "./_core/panelLogger";
import { loadPanelSslRuntimeConfig } from "./panelSsl";
import { startBackgroundServices } from "./backgroundServices";

installPanelLogger();

const serverDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort = 9810): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

function serveStatic(app: express.Express) {
  const clientDist = path.resolve(serverDir, "../client/dist");
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

function installMobileCors(app: express.Express) {
  const allowedOrigins = new Set([
    "capacitor://localhost",
    "ionic://localhost",
    "http://localhost",
    "https://localhost",
  ]);

  app.use((req, res, next) => {
    const origin = String(req.headers.origin || "");
    const allowed = allowedOrigins.has(origin) || /^https?:\/\/localhost:\d+$/i.test(origin);
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-forwardx-mobile,trpc-accept,x-trpc-source");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS" && allowed) {
      res.status(204).end();
      return;
    }
    next();
  });
}

async function startServer() {
  const databaseStatus = await initDatabase();

  const app = express();
  app.set("trust proxy", "loopback");
  const panelSsl = await loadPanelSslRuntimeConfig();
  const protocol = panelSsl.enabled ? "https" : "http";
  const server = panelSsl.enabled && panelSsl.options
    ? createHttpsServer(panelSsl.options, app)
    : createHttpServer(app);

  // Payment webhooks need the original request body for signature verification.
  app.use(paymentCallbackRouter);
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.use(cookieParser());
  installMobileCors(app);
  app.use(agentRouter);
  app.use(migrationRouter);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );
  serveStatic(app);

  const preferredPort = Number.parseInt(process.env.PORT || "9810", 10);
  const isProduction = process.env.NODE_ENV === "production";
  const port = isProduction ? preferredPort : await findAvailablePort(preferredPort);

  if (isProduction && !(await isPortAvailable(preferredPort))) {
    throw new Error(`Port ${preferredPort} is already in use`);
  }

  if (port !== preferredPort) {
    console.warn(`[Server] Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.info(`Server running on ${protocol}://localhost:${port}/`);
    console.info(`[Server] ForwardX panel started on ${protocol.toUpperCase()} port ${port}`);
  });

  if (databaseStatus.ready) {
    startBackgroundServices();
  } else {
    console.warn("[Server] Database is not ready; background tasks are paused until the database setup is fixed and the panel restarts");
  }
}

startServer().catch(console.error);
