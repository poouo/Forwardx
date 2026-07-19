import { ACCOUNT_DISABLED_ERR_MSG, COOKIE_NAME, NOT_ADMIN_ERR_MSG, SESSION_BUSY_ERR_MSG, SESSION_REPLACED_ERR_MSG, UNAUTHED_ERR_MSG } from '../../shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { getSessionCookieOptions } from "./cookies";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    if (ctx.authFailureReason === "session_busy") {
      throw new TRPCError({ code: "CONFLICT", message: SESSION_BUSY_ERR_MSG });
    }
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: ctx.authFailureReason === "session_replaced" ? SESSION_REPLACED_ERR_MSG : UNAUTHED_ERR_MSG,
    });
  }
  if ((ctx.user as any).accountEnabled === false) {
    ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
    throw new TRPCError({ code: "UNAUTHORIZED", message: ACCOUNT_DISABLED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user) {
      if (ctx.authFailureReason === "session_busy") {
        throw new TRPCError({ code: "CONFLICT", message: SESSION_BUSY_ERR_MSG });
      }
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: ctx.authFailureReason === "session_replaced" ? SESSION_REPLACED_ERR_MSG : UNAUTHED_ERR_MSG,
      });
    }
    if ((ctx.user as any).accountEnabled === false) {
      ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
      throw new TRPCError({ code: "UNAUTHORIZED", message: ACCOUNT_DISABLED_ERR_MSG });
    }
    if (ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
