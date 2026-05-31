import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { FORWARD_TYPES } from "../../shared/forwardTypes";
import { isValidAvatarValue } from "../../shared/avatar";
import { ensureAdminOrSelf, refreshUserForwardEndpoints } from "./helpers";
import { getEmailConfig, sendMail } from "../email";

function actorLabel(ctx: { user?: { id: number; username?: string } | null }) {
  return ctx.user ? `adminId=${ctx.user.id}` : "adminId=unknown";
}

function maskIdentifier(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) return "unknown";
  const [name, domain] = text.split("@");
  if (domain) {
    const visible = name.length <= 2 ? `${name[0] || "*"}*` : `${name.slice(0, 2)}***`;
    return `${visible}@${domain}`;
  }
  if (text.length <= 3) return `${text[0] || "*"}***`;
  return `${text.slice(0, 2)}***${text.slice(-1)}`;
}

export const usersRouter = router({
    list: adminProcedure.query(async () => {
      return db.getAllUsers();
    }),
    summary: adminProcedure.query(async () => {
      const [users, stats] = await Promise.all([
        db.getAllUsers(),
        db.getDashboardStats(),
      ]);
      return {
        totalUsers: users.length,
        totalRules: stats.totalRules,
        activeRules: stats.activeRules,
        totalTrafficIn: stats.totalTrafficIn,
        totalTrafficOut: stats.totalTrafficOut,
      };
    }),
    create: adminProcedure
      .input(z.object({
        username: z.string().min(1).max(64),
        password: z.string().min(6),
        name: z.string().optional(),
        email: z.string().email().optional(),
        canAddRules: z.boolean().default(false),
      }))
      .mutation(async ({ input, ctx }) => {
        const existing = await db.getUserByUsername(input.username);
        if (existing) {
          console.warn(`[Users] Create user rejected duplicate username=${maskIdentifier(input.username)} ${actorLabel(ctx)}`);
          throw new Error("用户名已存在");
        }
        // 安全限制：通过后台创建的用户一律为普通用户，不允许创建新管理员
        const id = await db.createUser({ ...input, role: "user" });
        console.info(`[Users] Created user userId=${id} username=${maskIdentifier(input.username)} ${actorLabel(ctx)}`);
        return { id };
      }),
    updateRole: adminProcedure
      .input(z.object({ userId: z.number(), role: z.enum(["user", "admin"]) }))
      .mutation(async ({ input, ctx }) => {
        // 安全限制：不允许提升用户为管理员，也不允许修改已有管理员的角色
        if (input.role === "admin") {
          console.warn(`[Users] Role update rejected userId=${input.userId} requestedRole=admin ${actorLabel(ctx)}`);
          throw new Error("出于安全考虑，不允许将用户提升为管理员");
        }
        const target = await db.getUserById(input.userId);
        if (target?.role === "admin") {
          console.warn(`[Users] Role update rejected target is admin userId=${input.userId} ${actorLabel(ctx)}`);
          throw new Error("不允许修改管理员账户的角色");
        }
        await db.updateUserRole(input.userId, input.role);
        await db.setUserForwardAccess(input.userId, false);
        await refreshUserForwardEndpoints(input.userId, "user-role-updated");
        console.info(`[Users] Updated role userId=${input.userId} role=${input.role} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    resetPassword: adminProcedure
      .input(z.object({
        userId: z.number(),
        username: z.string().trim().min(1).max(64).optional(),
        name: z.string().trim().max(64).nullable().optional(),
        avatar: z.string().max(90 * 1024).optional(),
        newPassword: z.string().max(128).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const target = await db.getUserById(input.userId);
        if (!target) throw new Error("用户不存在");
        const username = input.username?.trim();
        if (username && username !== target.username) {
          const existing = await db.getUserByUsername(username);
          if (existing && existing.id !== input.userId) throw new Error("账号已存在");
        }
        const password = input.newPassword?.trim() || "";
        if (password && password.length < 6) throw new Error("密码至少6个字符");
        if (input.avatar !== undefined && !isValidAvatarValue(input.avatar)) throw new Error("头像格式不支持或超过 50K");
        if (!username && input.name === undefined && input.avatar === undefined && !password) throw new Error("没有需要保存的修改");
        await db.updateUserAccount(input.userId, {
          username,
          name: input.name,
          avatar: input.avatar,
          password: password || undefined,
        });
        console.info(`[Users] Updated account userId=${input.userId} usernameChanged=${!!username && username !== target.username} passwordChanged=${!!password} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    updateAvatar: protectedProcedure
      .input(z.object({
        userId: z.number().optional(),
        avatar: z.string().max(90 * 1024),
      }))
      .mutation(async ({ input, ctx }) => {
        const userId = input.userId ?? ctx.user.id;
        ensureAdminOrSelf(ctx, userId);
        if (!isValidAvatarValue(input.avatar)) throw new Error("头像格式不支持或超过 50K");
        const target = await db.getUserById(userId);
        if (!target) throw new Error("用户不存在");
        const quota = await db.updateUserAvatarWithQuota(userId, input.avatar, { actorRole: ctx.user.role, countQuota: userId === ctx.user.id });
        console.info(`[Users] Updated avatar userId=${userId} ${actorLabel(ctx)}`);
        return { success: true, quota };
      }),
    randomAvatar: protectedProcedure
      .input(z.object({ userId: z.number().optional() }).optional())
      .mutation(async ({ input, ctx }) => {
        const userId = input?.userId ?? ctx.user.id;
        ensureAdminOrSelf(ctx, userId);
        const target = await db.getUserById(userId);
        if (!target) throw new Error("用户不存在");
        const result = await db.updateUserAvatarRandomWithQuota(userId, { actorRole: ctx.user.role, countQuota: userId === ctx.user.id });
        console.info(`[Users] Randomized avatar userId=${userId} ${actorLabel(ctx)}`);
        return { success: true, ...result };
      }),
    avatarQuota: protectedProcedure
      .input(z.object({ userId: z.number().optional() }).optional())
      .query(async ({ input, ctx }) => {
        const userId = input?.userId ?? ctx.user.id;
        ensureAdminOrSelf(ctx, userId);
        return db.getUserAvatarQuota(userId);
      }),
    delete: adminProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await db.deleteUserPermissions(input.userId);
        await db.deleteUser(input.userId);
        console.info(`[Users] Deleted user userId=${input.userId} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    /** 获取某用户的主机权限列表 */
    getHostPermissions: adminProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => {
        return db.getUserAllowedHostIds(input.userId);
      }),
    /** 设置某用户的主机权限（全量替换） */
    setHostPermissions: adminProcedure
      .input(z.object({ userId: z.number(), hostIds: z.array(z.number()) }))
      .mutation(async ({ input, ctx }) => {
        await db.setUserHostPermissions(input.userId, input.hostIds);
        console.info(`[Users] Updated host permissions userId=${input.userId} count=${input.hostIds.length} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    /** 获取所有用户的主机权限映射 */
    allHostPermissions: adminProcedure.query(async () => {
      return db.getAllUserHostPermissions();
    }),
    getTrafficBillingPermissions: adminProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => {
        return db.getUserTrafficBillingPermissions(input.userId);
      }),
    setTrafficBillingPermissions: adminProcedure
      .input(z.object({
        userId: z.number(),
        hostIds: z.array(z.number()),
        tunnelIds: z.array(z.number()),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.setUserTrafficBillingPermissions(input.userId, input.hostIds, input.tunnelIds);
        const recovery = await db.recoverUserForwardAccessIfEligible(input.userId);
        if (recovery.restored) {
          await refreshUserForwardEndpoints(input.userId, "traffic-billing-permission-forward-restored");
        }
        console.info(`[Users] Updated traffic billing permissions userId=${input.userId} hosts=${input.hostIds.length} tunnels=${input.tunnelIds.length} ${actorLabel(ctx)}`);
        return { success: true, forwardAccessRestored: recovery.restored };
      }),
    getTunnelPermissions: adminProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => {
        return db.getUserAllowedTunnelIds(input.userId);
      }),
    setTunnelPermissions: adminProcedure
      .input(z.object({ userId: z.number(), tunnelIds: z.array(z.number()) }))
      .mutation(async ({ input, ctx }) => {
        await db.setUserTunnelPermissions(input.userId, input.tunnelIds);
        console.info(`[Users] Updated tunnel permissions userId=${input.userId} count=${input.tunnelIds.length} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    sendEmail: adminProcedure
      .input(z.object({
        userId: z.number(),
        subject: z.string().trim().min(1).max(120),
        content: z.string().trim().min(1).max(4000),
      }))
      .mutation(async ({ input, ctx }) => {
        const config = await getEmailConfig();
        if (!config.enabled) throw new Error("邮箱服务未启用");
        const user = await db.getUserById(input.userId);
        if (!user) throw new Error("用户不存在");
        if (!user.email || !user.emailVerified) throw new Error("该用户邮箱尚未验证，不能发送邮件");
        await sendMail({
          to: user.email,
          subject: input.subject.trim(),
          text: input.content.trim(),
          html: input.content.trim().replace(/\n/g, "<br />"),
        });
        console.info(`[Users] Sent email userId=${input.userId} subjectLength=${input.subject.trim().length} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    allTunnelPermissions: adminProcedure.query(async () => {
      return db.getAllUserTunnelPermissions();
    }),
    /** 获取某用户的规则数和端口数 */
    getUserQuotaUsage: protectedProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input, ctx }) => {
        ensureAdminOrSelf(ctx, input.userId);
        const [ruleCount, portCount] = await Promise.all([
          db.getUserRuleCount(input.userId),
          db.getUserPortCount(input.userId),
        ]);
        return { ruleCount, portCount };
      }),
    /** 更新用户流量管理和权限设置 */
    updateTrafficSettings: adminProcedure
      .input(z.object({
        userId: z.number(),
        trafficLimit: z.number().min(0).optional(),
        gostRateLimitIn: z.number().min(0).optional(),
        gostRateLimitOut: z.number().min(0).optional(),
        expiresAt: z.string().nullable().optional(), // ISO date string or null
        trafficAutoReset: z.boolean().optional(),
        trafficResetDay: z.number().min(1).max(28).optional(),
        canAddRules: z.boolean().optional(),
        displayRemark: z.string().trim().max(24).nullable().optional(),
        maxRules: z.number().min(0).optional(),
        maxPorts: z.number().min(0).optional(),
        maxConnections: z.number().min(0).optional(),
        maxIPs: z.number().min(0).optional(),
        // 逗号分隔的转发方式列表；null 为全部允许
        allowedForwardTypes: z.string().nullable().optional(),
        allowForwardXTunnel: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { userId, expiresAt, allowedForwardTypes, ...rest } = input;
        const data: any = { ...rest };
        if (expiresAt !== undefined) {
          data.expiresAt = expiresAt ? new Date(expiresAt) : null;
        }
        if (allowedForwardTypes !== undefined) {
          // null 表示全部允许；空字符串表示全部禁用。
          const set = new Set((allowedForwardTypes ?? "").split(",").map(s => s.trim()).filter(Boolean));
          const valid = FORWARD_TYPES.filter(t => set.has(t));
          data.allowedForwardTypes = allowedForwardTypes === null || valid.length === FORWARD_TYPES.length ? null : valid.join(",");
        }
        if (input.displayRemark !== undefined) {
          data.displayRemark = input.displayRemark?.trim() || null;
        }
        if (input.canAddRules !== undefined) {
          data.forwardAccessPauseReason = input.canAddRules ? null : "manual";
          data.allowForwardXTunnel = input.canAddRules ? (data.allowForwardXTunnel ?? true) : false;
        }
        await db.updateUserTrafficSettings(userId, data);
        console.info(`[Users] Updated traffic settings userId=${userId} keys=${Object.keys(data).join(",") || "none"} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    setForwardAccess: adminProcedure
      .input(z.object({ userId: z.number(), enabled: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        const target = await db.getUserById(input.userId);
        if (!target) throw new Error("用户不存在");
        if (target.role === "admin") throw new Error("管理员默认拥有全部权限");
        await db.setUserForwardAccess(input.userId, input.enabled);
        await refreshUserForwardEndpoints(input.userId, input.enabled ? "user-forward-enabled" : "user-forward-disabled");
        console.info(`[Users] Forward access ${input.enabled ? "enabled" : "disabled"} userId=${input.userId} ${actorLabel(ctx)}`);
        return { success: true };
      }),
    /** 手动重置用户流量 */
    resetTraffic: adminProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await db.resetUserTraffic(input.userId);
        const recovery = await db.recoverUserForwardAccessIfEligible(input.userId);
        if (recovery.restored) {
          await refreshUserForwardEndpoints(input.userId, "user-traffic-reset-forward-restored");
        }
        console.info(`[Users] Reset traffic userId=${input.userId} ${actorLabel(ctx)}`);
        return { success: true, forwardAccessRestored: recovery.restored };
      }),
  });
