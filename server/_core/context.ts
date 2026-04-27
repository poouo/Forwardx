import type { Request, Response } from "express";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import jwt from "jsonwebtoken";
import { COOKIE_NAME } from "../../shared/const";
import { ENV } from "../env";
import * as db from "../db";
import type { User } from "../../drizzle/schema";

export interface TrpcContext {
  req: Request;
  res: Response;
  user: User | null;
}

export async function createContext({ req, res }: CreateExpressContextOptions): Promise<TrpcContext> {
  let user: User | null = null;

  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (token && ENV.cookieSecret) {
      const payload = jwt.verify(token, ENV.cookieSecret) as { userId: number };
      if (payload?.userId) {
        const found = await db.getUserById(payload.userId);
        if (found) {
          user = found;
        }
      }
    }
  } catch {
    // Invalid token, user stays null
  }

  return { req, res, user };
}
