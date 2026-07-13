import { appendPanelLog } from "../_core/panelLogger";
import * as db from "../db";
import { refreshUserForwardEndpoints } from "../routers/helpers";

type CommandActor = { id: number; role?: string };

async function requireTargetUser(userId: number) {
  const target = await db.getUserById(userId);
  if (!target) throw new Error("用户不存在");
  return target;
}

async function recoverForwardAccess(userId: number, reasonPrefix: string) {
  const recovery = await db.recoverUserForwardAccessIfEligible(userId);
  if (recovery.restored) {
    await refreshUserForwardEndpoints(userId, `${reasonPrefix}-forward-restored`);
  } else if (recovery.reason === "traffic_billing_balance") {
    await refreshUserForwardEndpoints(userId, `${reasonPrefix}-forward-paused`);
  }
  return recovery;
}

export async function setUserBalanceCommand(input: {
  actor: CommandActor;
  targetUserId: number;
  balanceCents: number;
  description: string;
  reasonPrefix?: string;
}) {
  await requireTargetUser(input.targetUserId);
  const result = await db.setUserBalance(input.targetUserId, input.balanceCents, {
    type: "admin_adjust",
    description: input.description,
    operatorUserId: input.actor.id,
  } as any);
  const recovery = await recoverForwardAccess(input.targetUserId, input.reasonPrefix || "balance-adjusted");
  appendPanelLog("info", `[UserCommand] action=balance.set actor=${input.actor.id} target=${input.targetUserId} balance=${input.balanceCents} delta=${result.amountCents}`);
  return { ...result, forwardAccessRestored: recovery.restored };
}

export async function adjustUserBalanceCommand(input: {
  actor: CommandActor;
  targetUserId: number;
  amountCents: number;
  description: string;
  reasonPrefix?: string;
}) {
  await requireTargetUser(input.targetUserId);
  const result = await db.addUserBalance(input.targetUserId, input.amountCents, {
    type: input.amountCents > 0 ? "admin_recharge" : "admin_adjust",
    description: input.description,
    operatorUserId: input.actor.id,
  } as any);
  const recovery = await recoverForwardAccess(input.targetUserId, input.reasonPrefix || "balance-adjusted");
  appendPanelLog("info", `[UserCommand] action=balance.adjust actor=${input.actor.id} target=${input.targetUserId} amount=${input.amountCents}`);
  return { ...result, forwardAccessRestored: recovery.restored };
}

export async function setUserAccountEnabledCommand(input: {
  actor: CommandActor;
  targetUserId: number;
  enabled: boolean;
  reasonPrefix?: string;
}) {
  if (!input.enabled && input.targetUserId === input.actor.id) throw new Error("不能禁用当前登录账户");
  const target = await requireTargetUser(input.targetUserId);
  if (!input.enabled && String(target.role) === "admin") throw new Error("不能禁用管理员账户");
  await db.setUserAccountEnabled(input.targetUserId, input.enabled);
  let forwardAccessRestored = false;
  const prefix = input.reasonPrefix || "user-account";
  if (!input.enabled) {
    await refreshUserForwardEndpoints(input.targetUserId, `${prefix}-disabled`);
  } else {
    const recovery = await recoverForwardAccess(input.targetUserId, `${prefix}-enabled`);
    forwardAccessRestored = recovery.restored;
  }
  appendPanelLog("info", `[UserCommand] action=account.${input.enabled ? "enable" : "disable"} actor=${input.actor.id} target=${input.targetUserId}`);
  return { target, forwardAccessRestored };
}

export async function setUserForwardAccessCommand(input: {
  actor: CommandActor;
  targetUserId: number;
  enabled: boolean;
  reasonPrefix?: string;
}) {
  const target = await requireTargetUser(input.targetUserId);
  if (String(target.role) === "admin") throw new Error("管理员默认拥有全部转发权限");
  await db.updateUserManualEntitlements(input.targetUserId, {
    manualCanAddRules: input.enabled,
    manualAllowForwardXTunnel: input.enabled,
    forwardAccessPauseReason: input.enabled ? null : "manual",
  });
  if (!input.enabled) await db.disableAllUserRules(input.targetUserId);
  await refreshUserForwardEndpoints(input.targetUserId, `${input.reasonPrefix || "user-forward"}-${input.enabled ? "enabled" : "disabled"}`);
  appendPanelLog("info", `[UserCommand] action=forward.${input.enabled ? "enable" : "disable"} actor=${input.actor.id} target=${input.targetUserId}`);
  return { target };
}

export async function resetUserTrafficCommand(input: {
  actor: CommandActor;
  targetUserId: number;
  reasonPrefix?: string;
}) {
  const target = await requireTargetUser(input.targetUserId);
  await db.resetUserTraffic(input.targetUserId);
  const recovery = await recoverForwardAccess(input.targetUserId, input.reasonPrefix || "user-traffic-reset");
  appendPanelLog("info", `[UserCommand] action=traffic.reset actor=${input.actor.id} target=${input.targetUserId}`);
  return { target, forwardAccessRestored: recovery.restored };
}

export async function renewUserCommand(input: {
  actor: CommandActor;
  targetUserId: number;
  expiresAt: Date;
  reasonPrefix?: string;
}) {
  const target = await requireTargetUser(input.targetUserId);
  await db.updateUserTrafficSettings(input.targetUserId, { expiresAt: input.expiresAt });
  const recovery = await recoverForwardAccess(input.targetUserId, input.reasonPrefix || "user-renewed");
  appendPanelLog("info", `[UserCommand] action=user.renew actor=${input.actor.id} target=${input.targetUserId} expiresAt=${input.expiresAt.toISOString()}`);
  return { target, forwardAccessRestored: recovery.restored };
}
