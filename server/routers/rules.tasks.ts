import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import type { TrpcContext } from "../_core/context";
import { enqueueRuleTaskSchema, isRuleTaskPortConflict } from "../../shared/ruleTaskQueue";
import { RuleTaskQueue, RuleTaskAuthorizationError, RuleTaskStopError, RULE_TASK_INSTANCE_ID, type RuleTaskActor } from "../ruleTaskQueue";
import { crudRulesRouter } from "./rules.crud";
import { getAuthSessionIdentity } from "../repositories/sessionRepository";
import { getUserById } from "../repositories/userRepository";
import { getSetting } from "../repositories/settingsRepository";
import { getSessionKindField, isSessionLeaseOwnedByAnother, parseSessionLease } from "../session";
import { DEV_ADMIN_USERNAME, isDevPanelMode } from "../devPanel";
import { databaseHealth, isDatabaseBusyError } from "../databaseHealthState";

async function executionContext(actor: RuleTaskActor): Promise<TrpcContext> {
  // Safe to wait here: no business write has started. Never retry the actual
  // mutation after a transport, timeout or unknown database failure.
  for (let attempt = 0; ; attempt++) {
    try {
      if (databaseHealth.snapshot().state === "unavailable") throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "数据库暂不可用" });
      const identity = actor.sid ? await getAuthSessionIdentity(actor.userId, actor.sid, actor.kind) : null;
      const user = identity?.session ? identity.user : actor.dev && isDevPanelMode() ? await getUserById(actor.userId) : null;
      if (!user || (user as any).accountEnabled === false || actor.dev && user.username !== DEV_ADMIN_USERNAME) throw new RuleTaskAuthorizationError("登录或账号已失效，任务未继续执行");
      if (actor.sid && await getSetting("allowMultiDeviceLogin") !== "true" && isSessionLeaseOwnedByAnother(parseSessionLease(String((user as any)[getSessionKindField(actor.kind)] || "")), actor.sid)) {
        throw new RuleTaskAuthorizationError("登录已被替换，任务未继续执行");
      }
      return { user, authSession: null, authFailureReason: null,
        req: { headers: { "x-request-id": actor.requestId }, protocol: "http" } as any,
        res: { clearCookie() {} } as any };
    } catch (error) {
      if (!(isDatabaseBusyError(error) || (error as any)?.code === "SERVICE_UNAVAILABLE")) throw error;
      if (attempt >= 29) throw new RuleTaskStopError("数据库持续繁忙或不可用，任务已停止，请核对已完成项目后再操作");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

export const queuedRuleTasks = new RuleTaskQueue(async (actor, action) => {
  const ctx = await executionContext(actor);
  // Reuse the original parsers, permissions, quota/stock locks and audit path.
  const caller = crudRulesRouter.createCaller(ctx);
  const invoke = (input: Record<string, unknown>) => {
    switch (action.operation) {
      case "create": return caller.create(input as any);
      case "update": return caller.update(input as any);
      case "toggle": return caller.toggle(input as any);
      case "restart": return caller.restart(input as any);
      case "delete": return caller.delete(input as any);
    }
  };
  let value: any;
  try { value = await invoke(action.input); }
  catch (error) {
    if (!["create", "update"].includes(action.operation) || action.conflictStrategy === "error" || !isRuleTaskPortConflict(error)) throw error;
    if (action.conflictStrategy === "skip") return { skipped: true };
    value = await invoke({ ...action.input, sourcePort: 0 });
  }
  return { ...(Number(value?.id) > 0 ? { id: Number(value.id) } : {}),
    ...(Number(value?.sourcePort) > 0 ? { sourcePort: Number(value.sourcePort) } : {}), ...(value?.skipped ? { skipped: true } : {}) };
});

export const ruleTasksRouter = router({
  enqueueTask: protectedProcedure.input(enqueueRuleTaskSchema).mutation(({ ctx, input }) => {
    const sid = ctx.authSession?.sid || null;
    const dev = !sid && isDevPanelMode() && ctx.user.username === DEV_ADMIN_USERNAME;
    if (!sid && !dev) throw new TRPCError({ code: "UNAUTHORIZED", message: "请重新登录后提交任务" });
    try {
      return { instanceId: RULE_TASK_INSTANCE_ID, task: queuedRuleTasks.enqueue({ userId: ctx.user.id, sid,
        kind: ctx.authSession?.kind || "browser", dev, requestId: input.requestId }, input) };
    } catch (cause) { throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: (cause as Error).message, cause }); }
  }),
  taskStatus: protectedProcedure.input(z.object({ ids: z.array(z.string().uuid()).max(20) })).query(({ ctx, input }) => ({
    instanceId: RULE_TASK_INSTANCE_ID, tasks: input.ids.map(id => queuedRuleTasks.get(ctx.user.id, id)),
  })),
  taskLookup: protectedProcedure.input(z.object({ requestId: z.string().min(8).max(80) })).query(({ ctx, input }) => ({
    instanceId: RULE_TASK_INSTANCE_ID, task: queuedRuleTasks.lookup(ctx.user.id, input.requestId),
  })),
  cancelTask: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(({ ctx, input }) => {
    const task = queuedRuleTasks.cancel(ctx.user.id, input.id);
    if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "任务不存在或已过期" });
    return task;
  }),
});
