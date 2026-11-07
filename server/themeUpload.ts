import type { Request, RequestHandler, Response } from "express";
import { THEME_LIMITS } from "../shared/themes";
import { createBoundedBodyParser, rejectRequestBody } from "./requestBodyParser";

// Base64 adds one third to the archive size; leave room for the tRPC envelope.
export const THEME_UPLOAD_BODY_BYTES = 4 * Math.ceil(THEME_LIMITS.archiveBytes / 3) + 64 * 1024;
type UploadUser = { role: string; accountEnabled?: boolean } | null;

async function authenticate(req: Request, res: Response): Promise<UploadUser> {
  const { createContext } = await import("./_core/context");
  return (await createContext({ req, res, info: {} as any })).user;
}

/** Grant the larger body budget only after admin authentication, for one upload at a time. */
export function createThemeUploadBodyParser(fallback: RequestHandler, resolveUser = authenticate): RequestHandler {
  const parse = createBoundedBodyParser({
    jsonLimitBytes: THEME_UPLOAD_BODY_BYTES, timeoutMs: 120_000,
    maxConcurrent: 1, maxPerIp: 1, maxLargeRequests: 1, maxLargeRequestsPerIp: 1,
    largeBodyLimit: 6, globalLargeBodyLimit: 12,
  });
  let active = false;
  return (req, res, next) => {
    // Single-procedure tRPC requests, including batch=1 with one procedure.
    // Mixed batches and every other API retain the ordinary parser's limits.
    if (req.method !== "POST" || req.path !== "/api/trpc/themes.install") return fallback(req, res, next);
    if (active) return rejectRequestBody(req, res, 429, "THEME_UPLOAD_BUSY");
    active = true;
    const release = () => {
      active = false;
      res.off("finish", release);
      res.off("close", release);
    };
    res.once("finish", release);
    res.once("close", release);
    void resolveUser(req, res).then(user => {
      if (res.destroyed || res.headersSent) return;
      if (!user || user.accountEnabled === false) return rejectRequestBody(req, res, 401, "UNAUTHORIZED");
      if (user.role !== "admin") return rejectRequestBody(req, res, 403, "FORBIDDEN");
      parse(req, res, next);
    }).catch(next);
  };
}
