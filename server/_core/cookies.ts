import type { Request, CookieOptions } from "express";
import { TEN_DAYS_MS } from "../../shared/const";

export function getSessionCookieOptions(req: Request): CookieOptions {
  // `req.secure`/`req.protocol` already apply Express's configured trust proxy
  // policy. Never trust a client-supplied X-Forwarded-Proto header directly.
  const isSecure = req.secure === true || req.protocol === "https";
  return {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: TEN_DAYS_MS,
    path: "/",
  };
}
