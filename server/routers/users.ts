import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { z } from "zod";
import * as db from "../db";
import { FORWARD_TYPES } from "../../shared/forwardTypes";
import { ensureAdminOrSelf, refreshUserForwardEndpoints } from "./helpers";
import { getEmailConfig, sendMail } from "../email";

export const usersRouter = router({
    list: adminProcedure.query(async () => {
      return db.getAllUsers();
    }),
    create: adminProcedure
      .input(z.object({
        username: z.string().min(1).max(64),
        password: z.string().min(6),
        name: z.string().optional(),
        email: z.string().email().optional(),
        canAddRules: z.boolean().default(false),
      }))
      .mutation(async ({ input }) => {
        const existing = await db.getUserByUsername(input.username);
        if (existing) {
          throw new Error("用户名已存在");
        }
        // 安全限制：通过后台创建的用户一律为普通用户，不允许创建新管理员
        const id = await db.createUser({ ...input, role: "user" });
        return { id };
      }),
    updateRole: adminProcedure
      .input(z.object({ userId: z.number(), role: z.enum(["user", "admin"]) }))
      .mutation(async ({ input }) => {
        // 安全限制：不允许提升用户为管理员，也不允许修改已有管理员的角色
        if (input.role === "admin") {
          throw new Error("出于安全考虑，不允许将用户提升为管理员");
        }
        const target = await db.getUserById(input.userId);
        if (target?.role === "admin") {
          throw new Error("不允许修改管理员账户的角色");
        }
        await db.updateUserRole(input.userId, input.role);
        await db.setUserForwardAccess(input.userId, false);
        await refreshUserForwardEndpoints(input.userId, "user-role-updated");
        return { success: true };
      }),
    resetPassword: adminProcedure
      .input(z.object({ userId: z.number(), newPassword: z.string().min(6) }))
      .mutation(async ({ input }) => {
        await db.resetUserPassword(input.userId, input.newPassword);
        return { success: true };
      }),
    delete: adminProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteUserPermissions(input.userId);
        await db.deleteUser(input.userId);
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
      .mutation(async ({ input }) => {
        await db.setUserHostPermissions(input.userId, input.hostIds);
        return { success: true };
      }),
    /** 获取所有用户的主机权限映射 */
    allHostPermissions: adminProcedure.query(async () => {
      return db.getAllUserHostPermissions();
    }),
    getTunnelPermissions: adminProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => {
        return db.getUserAllowedTunnelIds(input.userId);
      }),
    setTunnelPermissions: adminProcedure
      .input(z.object({ userId: z.number(), tunnelIds: z.array(z.number()) }))
      .mutation(async ({ input }) => {
        await db.setUserTunnelPermissions(input.userId, input.tunnelIds);
        return { success: true };
      }),
    sendEmail: adminProcedure
      .input(z.object({
        userId: z.number(),
        subject: z.string().trim().min(1).max(120),
        content: z.string().trim().min(1).max(4000),
      }))
      .mutation(async ({ input }) => {
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
        maxRules: z.number().min(0).optional(),
        maxPorts: z.number().min(0).optional(),
        maxConnections: z.number().min(0).optional(),
        maxIPs: z.number().min(0).optional(),
        // 逗号分隔的转发方式列表；null 为全部允许
        allowedForwardTypes: z.string().nullable().optional(),
        allowForwardXTunnel: z.boolean().optional(),
      }))
      .mutation(async ({ input }) => {
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
        await db.updateUserTrafficSettings(userId, data);
        return { success: true };
      }),
    setForwardAccess: adminProcedure
      .input(z.object({ userId: z.number(), enabled: z.boolean() }))
      .mutation(async ({ input }) => {
        const target = await db.getUserById(input.userId);
        if (!target) throw new Error("用户不存在");
        if (target.role === "admin") throw new Error("管理员默认拥有全部权限");
        await db.setUserForwardAccess(input.userId, input.enabled);
        await refreshUserForwardEndpoints(input.userId, input.enabled ? "user-forward-enabled" : "user-forward-disabled");
        return { success: true };
      }),
    /** 手动重置用户流量 */
    resetTraffic: adminProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ input }) => {
        await db.resetUserTraffic(input.userId);
        return { success: true };
      }),
  });
