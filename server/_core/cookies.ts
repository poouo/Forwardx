import type { Request, CookieOptions } from "express";
import { TEN_DAYS_MS } from "../../shared/const";

export function getSessionCookieOptions(req: Request): CookieOptions {
  const isSecure = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
  return {
    httpOnly: true,
    secure: isSecure,
    sameSite: isSecure ? "none" : "lax",
    maxAge: TEN_DAYS_MS,
    path: "/",
  };
}
