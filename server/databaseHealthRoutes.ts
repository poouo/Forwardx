import type { Express, ErrorRequestHandler, RequestHandler } from "express";
import { databaseHealth } from "./databaseHealthState";
import { DATABASE_UNAVAILABLE_MESSAGE } from "../shared/databaseHealth";

export function registerDatabaseHealthRoutes(app: Express) {
  // No auth context or DB query here: this endpoint must remain usable even
  // when login/session resolution and all business queries are unavailable.
  app.get("/api/database-health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json(databaseHealth.snapshot());
  });
}

export const databaseUnavailableApiGuard: RequestHandler = (req, res, next) => {
  if (databaseHealth.snapshot().state !== "unavailable" || !req.path.startsWith("/api/") || req.path.startsWith("/api/trpc")) return next();
  res.setHeader("Retry-After", "15");
  res.status(503).json({ error: DATABASE_UNAVAILABLE_MESSAGE, code: "DATABASE_UNAVAILABLE" });
};

export const databaseRequestErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (!databaseHealth.unavailable(error)) return next(error);
  if (res.headersSent) { res.destroy(); return; }
  res.setHeader("Retry-After", "15");
  res.status(503).json({ error: DATABASE_UNAVAILABLE_MESSAGE, code: "DATABASE_UNAVAILABLE" });
};
