import { COOKIE_NAME } from "../shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, adminProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { nanoid } from "nanoid";
import jwt from "jsonwebtoken";
import net from "net";
import { ENV } from "./env";
import * as db from "./db";
import { generateFullInstallScript, pushAgentRefresh, pushAgentUpgrade } from "./agentRoutes";
import { FORWARD_TYPES } from "../shared/forwardTypes";
import { appendPanelLog } from "./_core/panelLogger";

const forwardTypeSchema = z.enum(FORWARD_TYPES);

// ==================== 验证码系统 ====================
interface CaptchaEntry { question: string; answer: number; expiresAt: number; }
const captchaStore = new Map<string, CaptchaEntry>();

function generateCaptcha(): { captchaId: string; question: string } {
  const a = Math.floor(Math.random() * 20) + 1;
  const b = Math.floor(Math.random() * 20) + 1;
  const ops = [
    { symbol: "+", fn: (x: number, y: number) => x + y },
    { symbol: "-", fn: (x: number, y: number) => x - y },
  ];
  const op = ops[Math.floor(Math.random() * ops.length)];
  const answer = op.fn(a, b);
  const question = `${a} ${op.symbol} ${b} = ?`;
  const captchaId = nanoid(16);
  captchaStore.set(captchaId, { question, answer, expiresAt: Date.now() + 5 * 60 * 1000 });
  // 清理过期验证码
  for (const [k, v] of captchaStore) {
    if (v.expiresAt < Date.now()) captchaStore.delete(k);
  }
  return { captchaId, question };
}

function verifyCaptcha(captchaId: string, captchaAnswer: number): boolean {
  const entry = captchaStore.get(captchaId);
  if (!entry) return false;
  captchaStore.delete(captchaId);
  if (entry.expiresAt < Date.now()) return false;
  return entry.answer === captchaAnswer;
}

// ==================== 登录失败计数 ====================
// key: IP 或 username, value: { count, lastFailAt }
const loginFailStore = new Map<string, { count: number; lastFailAt: number }>();
const LOGIN_FAIL_THRESHOLD = 1; // 第1次失败后就需要验证码
const LOGIN_FAIL_WINDOW_MS = 30 * 60 * 1000; // 30分钟窗口

function getLoginFailKey(ip: string, username: string) {
  return `${ip}:${username}`;
}

function recordLoginFail(ip: string, username: string) {
  const key = getLoginFailKey(ip, username);
  const entry = loginFailStore.get(key);
  const now = Date.now();
  if (entry && (now - entry.lastFailAt) < LOGIN_FAIL_WINDOW_MS) {
    entry.count += 1;
    entry.lastFailAt = now;
  } else {
    loginFailStore.set(key, { count: 1, lastFailAt: now });
  }
}

function needsCaptcha(ip: string, username: string): boolean {
  const key = getLoginFailKey(ip, username);
  const entry = loginFailStore.get(key);
  if (!entry) return false;
  if ((Date.now() - entry.lastFailAt) > LOGIN_FAIL_WINDOW_MS) {
    loginFailStore.delete(key);
    return false;
  }
  return entry.count >= LOGIN_FAIL_THRESHOLD;
}

function clearLoginFail(ip: string, username: string) {
  loginFailStore.delete(getLoginFailKey(ip, username));
}

function ensureAdminOrSelf(ctx: { user: { id: number; role: string } }, userId: number) {
  if (ctx.user.role !== "admin" && ctx.user.id !== userId) {
    throw new Error("无权访问该用户的数据");
  }
}

async function requireHostAccess(ctx: { user: { id: number; role: string } }, hostId: number) {
  const host = await db.getHostById(hostId);
  if (!host) throw new Error("主机不存在");
  if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) {
    const hasPermission = await db.checkUserHostPermission(ctx.user.id, host.id);
    if (!hasPermission) throw new Error("无权访问该主机");
  }
  return host;
}

async function requireRuleAccess(ctx: { user: { id: number; role: string } }, ruleId: number) {
  const rule = await db.getForwardRuleById(ruleId);
  if (!rule) throw new Error("规则不存在");
  if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
    throw new Error("无权访问该规则");
  }
  return rule;
}

async function requireTunnelAccess(ctx: { user: { id: number; role: string } }, tunnelId: number) {
  const tunnel = await db.getTunnelById(tunnelId);
  if (!tunnel) throw new Error("隧道不存在");
  if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) {
    throw new Error("无权访问该隧道");
  }
  return tunnel;
}

function maskToken(token: string) {
  if (!token) return "";
  if (token.length <= 12) return `${token.slice(0, 4)}...`;
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(({ ctx }) => {
      if (!ctx.user) return null;
      const { password, ...safeUser } = ctx.user;
      return safeUser;
    }),

    /** 获取验证码 */
    getCaptcha: publicProcedure.query(() => {
      return generateCaptcha();
    }),

    /** 检查是否需要验证码 */
    needsCaptcha: publicProcedure
      .input(z.object({ username: z.string() }))
      .query(({ input, ctx }) => {
        const ip = ctx.req.ip || ctx.req.socket.remoteAddress || "unknown";
        return { required: needsCaptcha(ip, input.username) };
      }),

    login: publicProcedure
      .input(z.object({
        username: z.string().min(1, "请输入用户名"),
        password: z.string().min(1, "请输入密码"),
        captchaId: z.string().optional(),
        captchaAnswer: z.number().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const ip = ctx.req.ip || ctx.req.socket.remoteAddress || "unknown";

        // 如果该 IP+用户名 需要验证码，则校验
        if (needsCaptcha(ip, input.username)) {
          if (!input.captchaId || input.captchaAnswer === undefined) {
            throw new Error("CAPTCHA_REQUIRED");
          }
          if (!verifyCaptcha(input.captchaId, input.captchaAnswer)) {
            throw new Error("验证码错误，请重新输入");
          }
        }

        const user = await db.authenticateUser(input.username, input.password);
        if (!user) {
          recordLoginFail(ip, input.username);
          // 检查是否刚触发验证码要求
          const captchaNeeded = needsCaptcha(ip, input.username);
          if (captchaNeeded) {
            throw new Error("CAPTCHA_REQUIRED_AFTER_FAIL");
          }
          throw new Error("用户名或密码错误");
        }
        clearLoginFail(ip, input.username);
        const token = jwt.sign({ userId: user.id }, ENV.cookieSecret, { expiresIn: "10d" });
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, token, cookieOptions);
        const { password, ...safeUser } = user;
        return safeUser;
      }),

    /** 用户自行注册（需要验证码） */
    register: publicProcedure
      .input(z.object({
        username: z.string().min(2, "用户名至少2个字符").max(64),
        password: z.string().min(6, "密码至少6个字符"),
        name: z.string().max(64).optional(),
        email: z.string().email("邮箱格式不正确").optional(),
        captchaId: z.string(),
        captchaAnswer: z.number(),
      }))
      .mutation(async ({ input }) => {
        // 验证码校验
        if (!verifyCaptcha(input.captchaId, input.captchaAnswer)) {
          throw new Error("验证码错误，请重新输入");
        }
        const existing = await db.getUserByUsername(input.username);
        if (existing) {
          throw new Error("用户名已存在");
        }
        const { captchaId, captchaAnswer, ...userData } = input;
        const id = await db.registerUser(userData);
        return { id, message: "注册成功，请联系管理员开通权限" };
      }),

    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),

    changePassword: protectedProcedure
      .input(z.object({
        oldPassword: z.string().min(1, "请输入当前密码"),
        newPassword: z.string().min(6, "新密码至少6个字符"),
      }))
      .mutation(async ({ input, ctx }) => {
        const success = await db.changeUserPassword(ctx.user.id, input.oldPassword, input.newPassword);
        if (!success) {
          throw new Error("当前密码错误");
        }
        return { success: true };
      }),

    updateProfile: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(64).optional(),
        email: z.string().email().max(320).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await db.updateUserProfile(ctx.user.id, input);
        return { success: true };
      }),
  }),

  // ==================== Dashboard ====================
  dashboard: router({
    stats: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getDashboardStats(isAdmin ? undefined : ctx.user.id);
    }),
    /** 全局流量走势（仪表盘图表） */
    trafficSeries: protectedProcedure
      .input(z.object({
        hours: z.number().min(1).max(24 * 30).default(24),
        bucketMinutes: z.number().min(1).max(60).default(5),
      }).optional())
      .query(async ({ input, ctx }) => {
        const hours = input?.hours ?? 24;
        const bucketMinutes = input?.bucketMinutes ?? 5;
        const since = new Date(Date.now() - hours * 3600 * 1000);
        const isAdmin = ctx.user.role === "admin";
        return db.getGlobalTrafficSeries({
          bucketMinutes,
          since,
          userId: isAdmin ? undefined : ctx.user.id,
        });
      }),
    /** 全局 TCPing 延迟走势（仪表盘图表） */
    tcpingSeries: protectedProcedure
      .input(z.object({
        hours: z.number().min(1).max(24 * 30).default(24),
        bucketMinutes: z.number().min(1).max(60).default(1),
      }).optional())
      .query(async ({ input, ctx }) => {
        const hours = input?.hours ?? 24;
        const bucketMinutes = input?.bucketMinutes ?? 1;
        const since = new Date(Date.now() - hours * 3600 * 1000);
        const isAdmin = ctx.user.role === "admin";
        return db.getGlobalTcpingSeries({
          bucketMinutes,
          since,
          userId: isAdmin ? undefined : ctx.user.id,
        });
      }),
    /** 用户流量汇总（管理员看全部，普通用户看自己） */
    userTraffic: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      if (isAdmin) {
        return db.getUserTrafficSummaries();
      }
      const user = await db.getUserById(ctx.user.id);
      if (!user) return [];
      return [{
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        trafficLimit: user.trafficLimit,
        trafficUsed: user.trafficUsed,
        expiresAt: user.expiresAt,
        trafficAutoReset: user.trafficAutoReset,
        trafficResetDay: user.trafficResetDay,
      }];
    }),
  }),

  // ==================== User Management (Admin only) ====================
  users: router({
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
        expiresAt: z.string().nullable().optional(), // ISO date string or null
        trafficAutoReset: z.boolean().optional(),
        trafficResetDay: z.number().min(1).max(28).optional(),
        canAddRules: z.boolean().optional(),
        maxRules: z.number().min(0).optional(),
        maxPorts: z.number().min(0).optional(),
        // 逗号分隔的转发方式列表；null 为全部允许
        allowedForwardTypes: z.string().nullable().optional(),
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
    /** 手动重置用户流量 */
    resetTraffic: adminProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ input }) => {
        await db.resetUserTraffic(input.userId);
        return { success: true };
      }),
  }),

  // ==================== Host Management ====================
  hosts: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      if (isAdmin) return db.getHosts();
      // 普通用户：返回自己创建的主机 + 管理员授权的主机
      const allowedHostIds = await db.getUserAllowedHostIds(ctx.user.id);
      const allHosts = await db.getHosts();
      const allowedSet = new Set(allowedHostIds);
      return allHosts.filter(h => allowedSet.has(h.id) || h.userId === ctx.user.id);
    }),
    /** 获取所有主机列表（管理员用，用于权限分配） */
    listAll: adminProcedure.query(async () => {
      return db.getHosts();
    }),
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) return null;
        if (ctx.user.role !== "admin") {
          if (host.userId !== ctx.user.id) {
            const hasPermission = await db.checkUserHostPermission(ctx.user.id, host.id);
            if (!hasPermission) return null;
          }
        }
        return host;
      }),
    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(128),
        ip: z.string().min(1).max(64),
        hostType: z.enum(["master", "slave"]).default("slave"),
        networkInterface: z.string().max(32).optional(),
        entryIp: z.string().max(128).nullable().optional(),
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // 验证端口区间
        if (input.portRangeStart != null && input.portRangeEnd != null) {
          if (input.portRangeStart > input.portRangeEnd) {
            throw new Error("端口区间起始值不能大于结束值");
          }
        }
        const agentToken = nanoid(32);
        const id = await db.createHost({
          ...input,
          agentToken,
          networkInterface: input.networkInterface || null,
          portRangeStart: input.portRangeStart ?? null,
          portRangeEnd: input.portRangeEnd ?? null,
          userId: ctx.user.id,
        });
        return { id, agentToken };
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).max(128).optional(),
        ip: z.string().min(1).max(64).optional(),
        hostType: z.enum(["master", "slave"]).optional(),
        networkInterface: z.string().max(32).nullable().optional(),
        entryIp: z.string().max(128).nullable().optional(),
        portRangeStart: z.number().int().min(1).max(65535).nullable().optional(),
        portRangeEnd: z.number().int().min(1).max(65535).nullable().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) throw new Error("主机不存在");
        if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) throw new Error("无权操作此主机");
        // 验证端口区间
        const pStart = input.portRangeStart !== undefined ? input.portRangeStart : (host as any).portRangeStart;
        const pEnd = input.portRangeEnd !== undefined ? input.portRangeEnd : (host as any).portRangeEnd;
        if (pStart != null && pEnd != null && pStart > pEnd) {
          throw new Error("端口区间起始值不能大于结束值");
        }
        const { id, ...data } = input;
        await db.updateHost(id, data as any);
        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) throw new Error("主机不存在");
        if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) throw new Error("无权操作此主机");
        // 检查是否存在转发规则
        const ruleCount = await db.getHostRuleCount(input.id);
        if (ruleCount > 0) {
          throw new Error(`该主机下还有 ${ruleCount} 条转发规则，请先删除所有规则后再删除主机`);
        }
        await db.deleteHostPermissions(input.id);
        await db.deleteHost(input.id);
        return { success: true };
      }),
    metrics: protectedProcedure
      .input(z.object({ hostId: z.number(), limit: z.number().default(60) }))
      .query(async ({ input, ctx }) => {
        await requireHostAccess(ctx, input.hostId);
        return db.getLatestHostMetrics(input.hostId, input.limit);
      }),
    requestAgentUpgrade: adminProcedure
      .input(z.object({ hostId: z.number(), targetVersion: z.string().max(64).nullable().optional() }))
      .mutation(async ({ input }) => {
        const host = await db.getHostById(input.hostId);
        if (!host) throw new Error("主机不存在");
        await db.requestHostAgentUpgrade(input.hostId, input.targetVersion ?? null);
        const configuredPanelUrl = (await db.getSetting("panelPublicUrl")) || "";
        const panelUrl = /^https?:\/\//.test(configuredPanelUrl) ? configuredPanelUrl.replace(/\/+$/, "") : "";
        const pushed = pushAgentUpgrade(input.hostId, input.targetVersion ?? null, panelUrl);
        return { success: true, pushed };
      }),
  }),

  // ==================== Forward Rules ====================
  rules: router({
    list: protectedProcedure
      .input(z.object({ hostId: z.number().optional() }).optional())
      .query(async ({ input, ctx }) => {
        const isAdmin = ctx.user.role === "admin";
        return db.getForwardRules(isAdmin ? undefined : ctx.user.id, input?.hostId);
      }),
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const rule = await db.getForwardRuleById(input.id);
        if (!rule) return null;
        if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) return null;
        return rule;
      }),
    /** 检查端口是否已被占用 */
    checkPort: protectedProcedure
      .input(z.object({
        hostId: z.number(),
        sourcePort: z.number().min(1).max(65535),
        excludeRuleId: z.number().optional(),
      }))
      .query(async ({ input, ctx }) => {
        await requireHostAccess(ctx, input.hostId);
        if (input.excludeRuleId) {
          await requireRuleAccess(ctx, input.excludeRuleId);
        }
        const used = await db.isPortUsedOnHost(input.hostId, input.sourcePort, input.excludeRuleId);
        return { used };
      }),
    /** 获取随机可用端口 */
    randomPort: protectedProcedure
      .input(z.object({ hostId: z.number() }))
      .query(async ({ input, ctx }) => {
        const host = await requireHostAccess(ctx, input.hostId);
        const port = await db.findAvailablePort(input.hostId, (host as any).portRangeStart, (host as any).portRangeEnd);
        if (!port) throw new Error("该主机端口区间内已无可用端口");
        return { port };
      }),
    create: protectedProcedure
      .input(z.object({
        hostId: z.number(),
        name: z.string().min(1).max(128),
        forwardType: forwardTypeSchema.default("iptables"),
        protocol: z.enum(["tcp", "udp", "both"]).default("tcp"),
        gostMode: z.enum(["direct", "reverse"]).default("direct"),
        gostRelayHost: z.string().max(128).nullable().optional(),
        gostRelayPort: z.number().min(1).max(65535).nullable().optional(),
        tunnelId: z.number().nullable().optional(),
        sourcePort: z.number().min(0).max(65535), // 0 = 随机分配
        targetIp: z.string().min(1).max(64),
        targetPort: z.number().min(1).max(65535),
      }))
      .mutation(async ({ input, ctx }) => {
        // 权限检查：管理员或有 canAddRules 权限的用户
        if (ctx.user.role !== "admin" && !ctx.user.canAddRules) {
          throw new Error("您没有添加转发规则的权限，请联系管理员开通");
        }
        // 转发方式权限检查：非管理员需在 allowedForwardTypes 列表中
        if (ctx.user.role !== "admin") {
          const allowedRaw = (ctx.user as any).allowedForwardTypes as string | null | undefined;
          if (allowedRaw !== null && allowedRaw !== undefined) {
            const allowed = new Set(allowedRaw.split(",").map(s => s.trim()).filter(Boolean));
            if (!allowed.has(input.forwardType)) throw new Error(`您没有使用 ${input.forwardType} 转发方式的权限，请联系管理员`);
          }
        }
        const host = await db.getHostById(input.hostId);
        if (!host) throw new Error("主机不存在");

        // Agent 权限检查：非管理员需要拥有该主机，或被管理员授权使用该主机
        if (ctx.user.role !== "admin") {
          const hasPermission = host.userId === ctx.user.id || await db.checkUserHostPermission(ctx.user.id, input.hostId);
          if (!hasPermission) throw new Error("您没有使用该主机的权限，请联系管理员授权");
        }

        // 检查用户是否已到期
        if (ctx.user.expiresAt && new Date(ctx.user.expiresAt) <= new Date()) {
          throw new Error("您的账户已到期，无法添加规则");
        }
        // 检查用户流量是否已超额
        if (ctx.user.trafficLimit > 0 && ctx.user.trafficUsed >= ctx.user.trafficLimit) {
          throw new Error("您的流量已用完，无法添加规则");
        }

        // 检查用户规则数量限制
        const currentUser = await db.getUserById(ctx.user.id);
        if (currentUser && currentUser.maxRules > 0) {
          const ruleCount = await db.getUserRuleCount(ctx.user.id);
          if (ruleCount >= currentUser.maxRules) {
            throw new Error(`您已达到最大规则数量限制（${currentUser.maxRules} 条）`);
          }
        }
        // 检查用户端口数量限制
        if (currentUser && currentUser.maxPorts > 0) {
          const portCount = await db.getUserPortCount(ctx.user.id);
          if (portCount >= currentUser.maxPorts) {
            throw new Error(`您已达到最大端口数量限制（${currentUser.maxPorts} 个）`);
          }
        }

        let sourcePort = input.sourcePort;
        // 源端口为 0 时随机分配
        if (sourcePort === 0) {
          const randomPort = await db.findAvailablePort(input.hostId, (host as any).portRangeStart, (host as any).portRangeEnd);
          if (!randomPort) throw new Error("该主机端口区间内已无可用端口");
          sourcePort = randomPort;
        } else {
          // 检查端口区间限制
          const rangeStart = (host as any).portRangeStart;
          const rangeEnd = (host as any).portRangeEnd;
          if (rangeStart != null && rangeEnd != null) {
            if (sourcePort < rangeStart || sourcePort > rangeEnd) {
              throw new Error(`源端口必须在 ${rangeStart}-${rangeEnd} 区间内`);
            }
          }
          // 检查端口是否已被占用
          const used = await db.isPortUsedOnHost(input.hostId, sourcePort);
          if (used) {
            throw new Error(`端口 ${sourcePort} 已被其他规则占用`);
          }
        }

        const gostRelayHost = input.forwardType === "gost" && input.gostMode === "reverse" ? (input.gostRelayHost || "").trim() : null;
        const gostRelayPort = input.forwardType === "gost" && input.gostMode === "reverse" ? input.gostRelayPort : null;
        const tunnelId = input.forwardType === "gost" && input.gostMode === "direct" ? input.tunnelId ?? null : null;
        let tunnelExitPort: number | null = null;
        if (input.forwardType === "gost" && input.gostMode === "reverse") {
          if (!gostRelayHost) throw new Error("反向隧道需要填写中继地址");
          if (!gostRelayPort) throw new Error("反向隧道需要填写中继端口");
        }

        if (tunnelId) {
          const tunnel = await requireTunnelAccess(ctx, tunnelId);
          if (!tunnel.isEnabled) throw new Error("所选隧道已停用");
          if (tunnel.entryHostId !== input.hostId) {
            throw new Error("所选隧道的入口 Agent 必须与规则所属主机一致");
          }
          const exit = await db.getHostById(tunnel.exitHostId);
          tunnelExitPort = await db.findAvailableTunnelExitPort(
            tunnel.exitHostId,
            (exit as any)?.portRangeStart,
            (exit as any)?.portRangeEnd,
          );
          if (!tunnelExitPort) throw new Error("出口 Agent 已无可用隧道端口");
        }

        const id = await db.createForwardRule({ ...input, sourcePort, gostRelayHost, gostRelayPort, tunnelId, tunnelExitPort, userId: ctx.user.id });
        if (tunnelId) await db.updateTunnel(tunnelId, { isRunning: false } as any);
        return { id, sourcePort };
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).max(128).optional(),
        forwardType: forwardTypeSchema.optional(),
        protocol: z.enum(["tcp", "udp", "both"]).optional(),
        gostMode: z.enum(["direct", "reverse"]).optional(),
        gostRelayHost: z.string().max(128).nullable().optional(),
        gostRelayPort: z.number().min(1).max(65535).nullable().optional(),
        tunnelId: z.number().nullable().optional(),
        sourcePort: z.number().min(1).max(65535).optional(),
        targetIp: z.string().min(1).max(64).optional(),
        targetPort: z.number().min(1).max(65535).optional(),
        isEnabled: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const rule = await db.getForwardRuleById(input.id);
        if (!rule) throw new Error("规则不存在");
        if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权操作此规则");

        // 如果修改了源端口，检查端口区间和占用
        if (input.sourcePort && input.sourcePort !== rule.sourcePort) {
          const host = await db.getHostById(rule.hostId);
          if (host) {
            const rangeStart = (host as any).portRangeStart;
            const rangeEnd = (host as any).portRangeEnd;
            if (rangeStart != null && rangeEnd != null) {
              if (input.sourcePort < rangeStart || input.sourcePort > rangeEnd) {
                throw new Error(`源端口必须在 ${rangeStart}-${rangeEnd} 区间内`);
              }
            }
            const used = await db.isPortUsedOnHost(rule.hostId, input.sourcePort, rule.id);
            if (used) {
              throw new Error(`端口 ${input.sourcePort} 已被其他规则占用`);
            }
          }
        }

        const { id, ...data } = input;
        if ((data.forwardType ?? rule.forwardType) !== "gost") {
          (data as any).gostMode = "direct";
          (data as any).gostRelayHost = null;
          (data as any).gostRelayPort = null;
          (data as any).tunnelId = null;
        } else if ((data.gostMode ?? (rule as any).gostMode ?? "direct") === "reverse") {
          const relayHost = data.gostRelayHost !== undefined ? data.gostRelayHost : (rule as any).gostRelayHost;
          const relayPort = data.gostRelayPort !== undefined ? data.gostRelayPort : (rule as any).gostRelayPort;
          if (!relayHost) throw new Error("反向隧道需要填写中继地址");
          if (!relayPort) throw new Error("反向隧道需要填写中继端口");
          (data as any).tunnelId = null;
        } else {
          (data as any).gostRelayHost = null;
          (data as any).gostRelayPort = null;
          const nextTunnelId = data.tunnelId !== undefined ? data.tunnelId : (rule as any).tunnelId;
          if (nextTunnelId) {
            const tunnel = await requireTunnelAccess(ctx, nextTunnelId);
            if (!tunnel.isEnabled) throw new Error("所选隧道已停用");
            if (tunnel.entryHostId !== rule.hostId) {
              throw new Error("所选隧道的入口 Agent 必须与规则所属主机一致");
            }
            if (nextTunnelId !== (rule as any).tunnelId || !(rule as any).tunnelExitPort) {
              const exit = await db.getHostById(tunnel.exitHostId);
              (data as any).tunnelExitPort = await db.findAvailableTunnelExitPort(
                tunnel.exitHostId,
                (exit as any)?.portRangeStart,
                (exit as any)?.portRangeEnd,
              );
              if (!(data as any).tunnelExitPort) throw new Error("出口 Agent 已无可用隧道端口");
            }
          } else {
            (data as any).tunnelExitPort = null;
          }
        }
        // 关键字段变更时重置 isRunning
        const watchedFields: (keyof typeof data)[] = [
          "sourcePort",
          "targetIp",
          "targetPort",
          "forwardType",
          "protocol",
          "gostMode",
          "gostRelayHost",
          "gostRelayPort",
          "tunnelId",
          "tunnelExitPort",
        ];
        const keyFieldChanged = watchedFields.some((f) => {
          const v = data[f];
          return v !== undefined && v !== (rule as any)[f];
        });
        if (keyFieldChanged) {
          (data as any).isRunning = false;
          const affectedTunnelIds = new Set<number>();
          if ((rule as any).tunnelId) affectedTunnelIds.add((rule as any).tunnelId);
          if ((data as any).tunnelId) affectedTunnelIds.add((data as any).tunnelId);
          for (const affectedTunnelId of affectedTunnelIds) {
            await db.updateTunnel(affectedTunnelId, { isRunning: false } as any);
          }
        }
        await db.updateForwardRule(id, data);
        return { success: true, reset: keyFieldChanged };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const rule = await db.getForwardRuleById(input.id);
        if (!rule) throw new Error("规则不存在");
        if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权操作此规则");
        if ((rule as any).tunnelId) await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
        await db.deleteForwardRule(input.id);
        return { success: true };
      }),
    toggle: protectedProcedure
      .input(z.object({ id: z.number(), isEnabled: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        const rule = await db.getForwardRuleById(input.id);
        if (!rule) throw new Error("规则不存在");
        if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("无权操作此规则");
        if ((rule as any).tunnelId) await db.updateTunnel((rule as any).tunnelId, { isRunning: false } as any);
        if (input.isEnabled) {
          await db.updateForwardRule(input.id, { isEnabled: true, isRunning: false });
        } else {
          await db.toggleForwardRule(input.id, false);
        }
        return { success: true };
      }),
    traffic: protectedProcedure
      .input(z.object({ ruleId: z.number(), limit: z.number().default(60) }))
      .query(async ({ input, ctx }) => {
        await requireRuleAccess(ctx, input.ruleId);
        return db.getTrafficStats(input.ruleId, input.limit);
      }),
    trafficSummary: protectedProcedure
      .input(
        z.object({
          hours: z.number().min(1).max(24 * 30).default(24),
          hostId: z.number().optional(),
        })
      )
      .query(async ({ input, ctx }) => {
        const since = new Date(Date.now() - input.hours * 3600 * 1000);
        const isAdmin = ctx.user.role === "admin";
        return db.getTrafficSummaryByRule({
          userId: isAdmin ? undefined : ctx.user.id,
          hostId: input.hostId,
          since,
        });
      }),
    trafficSeries: protectedProcedure
      .input(
        z.object({
          ruleId: z.number(),
          hours: z.number().min(1).max(24 * 30).default(1),
          bucketMinutes: z.number().min(1).max(60).default(1),
        })
      )
      .query(async ({ input, ctx }) => {
        const rule = await db.getForwardRuleById(input.ruleId);
        if (!rule) throw new Error("规则不存在");
        if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
          throw new Error("无权查看此规则");
        }
        const since = new Date(Date.now() - input.hours * 3600 * 1000);
        return db.getTrafficSeriesByRule(input.ruleId, {
          bucketMinutes: input.bucketMinutes,
          since,
        });
      }),

    tcpingSeries: protectedProcedure
      .input(z.object({
        ruleId: z.number(),
        hours: z.number().min(1).max(48).default(24),
      }))
      .query(async ({ input, ctx }) => {
        const rule = await db.getForwardRuleById(input.ruleId);
        if (!rule) throw new Error("规则不存在");
        if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
          throw new Error("无权查看此规则");
        }
        const since = new Date(Date.now() - input.hours * 3600 * 1000);
        return db.getTcpingSeriesByRule(input.ruleId, { since });
      }),

    startSelfTest: protectedProcedure
      .input(z.object({ ruleId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const rule = await db.getForwardRuleById(input.ruleId);
        if (!rule) throw new Error("规则不存在");
        if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
          throw new Error("无权操作此规则");
        }
        const id = await db.createForwardTest({
          ruleId: rule.id,
          hostId: rule.hostId,
          userId: rule.userId,
          status: "pending",
          listenOk: false,
          targetReachable: false,
          forwardOk: false,
          message: null,
        });
        return { id };
      }),

    latestTest: protectedProcedure
      .input(z.object({ ruleId: z.number() }))
      .query(async ({ input, ctx }) => {
        const rule = await db.getForwardRuleById(input.ruleId);
        if (!rule) return null;
        if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
          return null;
        }
        const t = await db.getLatestForwardTest(input.ruleId);
        return t || null;
      }),
  }),

  // ==================== Gost Tunnels ====================
  tunnels: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getTunnels(isAdmin ? undefined : ctx.user.id);
    }),
    latencySeries: protectedProcedure
      .input(z.object({
        tunnelId: z.number(),
        hours: z.number().min(1).max(48).default(24),
      }))
      .query(async ({ input, ctx }) => {
        const tunnel = await db.getTunnelById(input.tunnelId);
        if (!tunnel) throw new Error("Tunnel not found");
        if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) {
          throw new Error("No permission to view this tunnel");
        }
        const since = new Date(Date.now() - input.hours * 3600 * 1000);
        return db.getTunnelLatencySeries(input.tunnelId, { since });
      }),
    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(128),
        entryHostId: z.number(),
        exitHostId: z.number(),
        mode: z.enum(["tls", "wss", "tcp", "mtls", "mwss", "mtcp"]).default("tls"),
        listenPort: z.number().min(0).max(65535).optional().default(0),
      }))
      .mutation(async ({ input, ctx }) => {
        if (input.entryHostId === input.exitHostId) throw new Error("入口 Agent 和出口 Agent 不能相同");
        const entry = await requireHostAccess(ctx, input.entryHostId);
        const exit = await requireHostAccess(ctx, input.exitHostId);
        if (!entry || !exit) throw new Error("主机不存在");
        let listenPort = Number(input.listenPort) || 0;
        if (listenPort > 0) {
          const start = (exit as any).portRangeStart;
          const end = (exit as any).portRangeEnd;
          if (start != null && end != null && (listenPort < start || listenPort > end)) {
            throw new Error(`出口监听端口必须在 ${start}-${end} 区间内`);
          }
          const used = await db.isPortUsedOnHost(input.exitHostId, listenPort);
          if (used) throw new Error(`出口 Agent 端口 ${listenPort} 已被转发规则占用`);
          const tunnelUsed = await db.isTunnelListenPortUsed(input.exitHostId, listenPort);
          if (tunnelUsed) throw new Error(`出口 Agent 端口 ${listenPort} 已被其他隧道占用`);
        } else {
          listenPort = await db.findAvailableTunnelExitPort(
            input.exitHostId,
            (exit as any).portRangeStart,
            (exit as any).portRangeEnd,
          ) ?? 0;
          if (!listenPort) throw new Error("出口 Agent 已无可用隧道端口");
        }
        const id = await db.createTunnel({ ...input, listenPort, userId: ctx.user.id });
        pushAgentRefresh(input.exitHostId, "tunnel-created");
        return { id, listenPort };
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).max(128).optional(),
        entryHostId: z.number().optional(),
        exitHostId: z.number().optional(),
        mode: z.enum(["tls", "wss", "tcp", "mtls", "mwss", "mtcp"]).optional(),
        listenPort: z.number().min(0).max(65535).optional(),
        isEnabled: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const tunnel = await db.getTunnelById(input.id);
        if (!tunnel) throw new Error("隧道不存在");
        if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) throw new Error("无权操作此隧道");
        const entryHostId = input.entryHostId ?? tunnel.entryHostId;
        const exitHostId = input.exitHostId ?? tunnel.exitHostId;
        if (entryHostId === exitHostId) throw new Error("入口 Agent 和出口 Agent 不能相同");
        await requireHostAccess(ctx, entryHostId);
        const exit = await requireHostAccess(ctx, exitHostId);
        const { id, ...data } = input;
        if ((data as any).listenPort !== undefined) {
          const listenPort = Number((data as any).listenPort) || 0;
          if (listenPort <= 0) {
            (data as any).listenPort = await db.findAvailableTunnelExitPort(
              exitHostId,
              (exit as any).portRangeStart,
              (exit as any).portRangeEnd,
            );
            if (!(data as any).listenPort) throw new Error("出口 Agent 已无可用隧道端口");
          } else {
            const start = (exit as any).portRangeStart;
            const end = (exit as any).portRangeEnd;
            if (start != null && end != null && (listenPort < start || listenPort > end)) {
              throw new Error(`出口监听端口必须在 ${start}-${end} 区间内`);
            }
            const used = await db.isPortUsedOnHost(exitHostId, listenPort);
            if (used) throw new Error(`出口 Agent 端口 ${listenPort} 已被转发规则占用`);
            const tunnelUsed = await db.isTunnelListenPortUsed(exitHostId, listenPort, id);
            if (tunnelUsed) throw new Error(`出口 Agent 端口 ${listenPort} 已被其他隧道占用`);
            (data as any).listenPort = listenPort;
          }
        }
        const keyChanged = ["entryHostId", "exitHostId", "mode", "listenPort", "isEnabled"].some((key) => (data as any)[key] !== undefined && (data as any)[key] !== (tunnel as any)[key]);
        if (keyChanged) (data as any).isRunning = false;
        await db.updateTunnel(id, data as any);
        if (keyChanged) await db.resetForwardRulesByTunnel(id);
        if (keyChanged) {
          pushAgentRefresh(exitHostId, "tunnel-updated");
          if (tunnel.exitHostId !== exitHostId) pushAgentRefresh(tunnel.exitHostId, "tunnel-updated-old-exit");
        }
        return { success: true, reset: keyChanged };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const tunnel = await db.getTunnelById(input.id);
        if (!tunnel) throw new Error("隧道不存在");
        if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) throw new Error("无权操作此隧道");
        await db.deleteTunnel(input.id);
        return { success: true };
      }),
    test: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const tunnel = await db.getTunnelById(input.id);
        if (!tunnel) throw new Error("Tunnel not found");
        if (ctx.user.role !== "admin" && tunnel.userId !== ctx.user.id) throw new Error("No permission to test this tunnel");
        const entry = await db.getHostById(tunnel.entryHostId);
        const exit = await db.getHostById(tunnel.exitHostId);
        if (!entry) throw new Error("Entry Agent not found");
        if (!exit) throw new Error("Exit Agent not found");
        appendPanelLog("info", `[TunnelTest] start tunnel=${tunnel.id} name=${tunnel.name} entryHost=${tunnel.entryHostId} exitHost=${tunnel.exitHostId} mode=${tunnel.mode} listenPort=${tunnel.listenPort}`);
        if (!tunnel.isRunning) {
          const pushed = pushAgentRefresh(tunnel.exitHostId, "tunnel-test-refresh");
          appendPanelLog(
            pushed ? "info" : "warn",
            pushed
              ? `[TunnelTest] tunnel=${tunnel.id} exit service not applied yet; pushed refresh to exit Agent`
              : `[TunnelTest] tunnel=${tunnel.id} exit service not applied yet; exit Agent event stream unavailable, test will still be queued`
          );
        }
        const target = String((exit as any).entryIp || (exit as any).ipv4 || (exit as any).ipv6 || exit.ip || "").trim();
        const targetPort = Number(tunnel.listenPort);
        if (!target || !targetPort) {
          const message = `TUNNEL_TEST_TARGET_INVALID target=${target || "-"} port=${targetPort || "-"}`;
          await db.updateTunnelTestResult(tunnel.id, { status: "failed", latencyMs: null, message });
          await db.insertTunnelLatencyStat({ tunnelId: tunnel.id, latencyMs: null, isTimeout: true });
          appendPanelLog("error", `[TunnelTest] tunnel=${tunnel.id} invalid test target. exitHost=${exit.id} target=${target || "-"} port=${targetPort || "-"}`);
          return { success: false, latencyMs: null, message };
        }
        const payload = {
          kind: "tunnel",
          tunnelId: tunnel.id,
          targetIp: target,
          targetPort,
        };
        await db.createForwardTest({
          ruleId: 0,
          hostId: tunnel.entryHostId,
          userId: tunnel.userId,
          message: JSON.stringify(payload),
        } as any);
        const message = `TUNNEL_LINK_TEST_PENDING ${target}:${targetPort}`;
        await db.updateTunnelTestResult(tunnel.id, { status: "pending", latencyMs: null, message });
        appendPanelLog("info", `[TunnelTest] tunnel=${tunnel.id} queued entry-agent TCPing from entryHost=${entry.id} to exit ${target}:${targetPort}`);
        return { success: false, latencyMs: null, message, pending: true };
      }),
  }),

  // ==================== Agent Tokens ====================
  agentTokens: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      const tokens = await db.getAgentTokens(isAdmin ? undefined : ctx.user.id);
      return tokens.map((token: any) => ({
        ...token,
        token: maskToken(token.token),
      }));
    }),
    create: protectedProcedure
      .input(z.object({ description: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        const token = nanoid(32);
        const id = await db.createAgentToken({
          token,
          description: input.description ?? null,
          userId: ctx.user.id,
        });
        return { id, token };
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), description: z.string().max(200).nullable().optional() }))
      .mutation(async ({ input, ctx }) => {
        const token = await db.getAgentTokenById(input.id);
        if (!token) throw new Error("Token 不存在");
        if (ctx.user.role !== "admin" && token.userId !== ctx.user.id) {
          throw new Error("无权修改该 Token");
        }
        const description = input.description?.trim() || null;
        await db.updateAgentTokenDescription(input.id, description);
        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const token = await db.getAgentTokenById(input.id);
        if (!token) throw new Error("Token 不存在");
        if (ctx.user.role !== "admin" && token.userId !== ctx.user.id) {
          throw new Error("无权删除该 Token");
        }
        await db.deleteAgentToken(input.id);
        return { success: true };
      }),
    getInstallScript: protectedProcedure
      .input(z.object({ id: z.number().optional(), token: z.string().optional(), panelUrl: z.string().optional() }))
      .query(async ({ input, ctx }) => {
        if (!input.id && !input.token) throw new Error("缺少 Token 参数");
        const token = input.id
          ? await db.getAgentTokenById(input.id)
          : await db.getAgentTokenByToken(input.token!);
        if (!token) throw new Error("Token 不存在");
        if (ctx.user.role !== "admin" && token.userId !== ctx.user.id) {
          throw new Error("无权使用该 Token");
        }
        const reqAny = ctx.req as any;
        const fallbackHost = reqAny?.get?.("host") || "localhost:3000";
        const fallbackProto = reqAny?.protocol || "http";
        const panelUrl = input.panelUrl || `${fallbackProto}://${fallbackHost}`;
        const script = generateFullInstallScript(panelUrl, token.token);
        return { script, token: token.token };
      }),
  }),

  // ==================== Config Backup / Restore ====================
  config: router({
    exportAll: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      const userId = isAdmin ? undefined : ctx.user.id;
      const [hosts, rules, tokens, users] = await Promise.all([
        db.getHosts(userId),
        db.getForwardRules(userId),
        db.getAgentTokens(userId),
        isAdmin ? db.getAllUsers() : Promise.resolve([]),
      ]);
      return {
        version: 3,
        exportedAt: new Date().toISOString(),
        scope: isAdmin ? "all" : "self",
        owner: { id: ctx.user.id, username: (ctx.user as any).username, role: ctx.user.role },
        hosts: hosts.map((h: any) => ({
          id: h.id,
          userId: h.userId,
          name: h.name,
          ip: h.ip,
          entryIp: h.entryIp,
          hostType: h.hostType,
          agentToken: h.agentToken,
          osInfo: h.osInfo,
          cpuInfo: h.cpuInfo,
          memoryTotal: h.memoryTotal,
          networkInterface: h.networkInterface,
          portRangeStart: h.portRangeStart,
          portRangeEnd: h.portRangeEnd,
          isOnline: h.isOnline,
          lastHeartbeat: h.lastHeartbeat,
          createdAt: h.createdAt,
        })),
        rules: rules.map((r: any) => ({
          id: r.id,
          userId: r.userId,
          hostId: r.hostId,
          name: r.name,
          forwardType: r.forwardType,
          protocol: r.protocol,
          sourcePort: r.sourcePort,
          targetIp: r.targetIp,
          targetPort: r.targetPort,
          isEnabled: r.isEnabled,
        })),
        agentTokens: tokens.map((t: any) => ({
          id: t.id,
          userId: t.userId,
          token: t.token,
          description: t.description,
          isUsed: t.isUsed,
          hostId: t.hostId,
          createdAt: t.createdAt,
        })),
        users: users.map((u: any) => ({
          id: u.id,
          username: u.username,
          name: u.name,
          email: u.email,
          role: u.role,
          canAddRules: u.canAddRules,
          trafficLimit: u.trafficLimit,
          trafficUsed: u.trafficUsed,
          expiresAt: u.expiresAt,
          trafficAutoReset: u.trafficAutoReset,
          trafficResetDay: u.trafficResetDay,
        })),
      };
    }),

    importAll: adminProcedure
      .input(
        z.object({
          mode: z.enum(["merge", "replace"]).default("merge"),
          payload: z.object({
            version: z.number().optional(),
            hosts: z.array(z.any()).optional(),
            rules: z.array(z.any()).optional(),
            agentTokens: z.array(z.any()).optional(),
          }),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { mode, payload } = input;
        const summary = {
          hosts: { created: 0, skipped: 0 },
          agentTokens: { created: 0, skipped: 0 },
          rules: { created: 0, skipped: 0 },
        };

        if (mode === "replace") {
          const existRules = await db.getForwardRules(ctx.user.id);
          for (const r of existRules) await db.deleteForwardRule(r.id);
          const existHosts = await db.getHosts(ctx.user.id);
          for (const h of existHosts) await db.deleteHost(h.id);
          const existTokens = await db.getAgentTokens(ctx.user.id);
          for (const t of existTokens) await db.deleteAgentToken(t.id);
        }

        const hostIdMap = new Map<number, number>();
        const existingHosts = await db.getHosts(ctx.user.id);
        const existHostByName = new Map(existingHosts.map((h: any) => [h.name, h.id] as const));
        const existHostByToken = new Map(
          existingHosts.filter((h: any) => h.agentToken).map((h: any) => [h.agentToken, h.id] as const)
        );
        for (const h of payload.hosts || []) {
          let existId: number | undefined;
          if (h.agentToken && existHostByToken.has(h.agentToken)) {
            existId = existHostByToken.get(h.agentToken);
          } else if (existHostByName.has(h.name)) {
            existId = existHostByName.get(h.name);
          }
          if (existId) {
            hostIdMap.set(Number(h.id), Number(existId));
            summary.hosts.skipped += 1;
            continue;
          }
          const newId = await db.createHost({
            name: h.name,
            ip: h.ip || "unknown",
            entryIp: h.entryIp ?? null,
            hostType: h.hostType || "slave",
            agentToken: h.agentToken ?? null,
            osInfo: h.osInfo ?? null,
            cpuInfo: h.cpuInfo ?? null,
            memoryTotal: h.memoryTotal ?? null,
            networkInterface: h.networkInterface ?? null,
            portRangeStart: h.portRangeStart ?? null,
            portRangeEnd: h.portRangeEnd ?? null,
            isOnline: false,
            userId: ctx.user.id,
          });
          hostIdMap.set(Number(h.id), Number(newId));
          summary.hosts.created += 1;
        }

        // Agent Tokens
        const existingTokens = await db.getAgentTokens(ctx.user.id);
        const existTokenSet = new Set(existingTokens.map((t: any) => t.token));
        for (const t of payload.agentTokens || []) {
          if (existTokenSet.has(t.token)) { summary.agentTokens.skipped += 1; continue; }
          await db.createAgentToken({
            token: t.token,
            description: t.description ?? null,
            userId: ctx.user.id,
          });
          if (t.isUsed && t.hostId) {
            const newHostId = hostIdMap.get(Number(t.hostId));
            if (newHostId) {
              await db.markAgentTokenUsed(t.token, Number(newHostId));
            }
          }
          summary.agentTokens.created += 1;
        }

        // 规则
        const existingRules = await db.getForwardRules(ctx.user.id);
        const ruleKey = (r: any) => `${r.hostId}|${r.sourcePort}|${r.protocol}|${r.forwardType}`;
        const existRuleKeys = new Set(existingRules.map((r: any) => ruleKey(r)));
        for (const r of payload.rules || []) {
          const newHostId = hostIdMap.get(Number(r.hostId));
          if (!newHostId) { summary.rules.skipped += 1; continue; }
          const k = ruleKey({ ...r, hostId: newHostId });
          if (existRuleKeys.has(k)) { summary.rules.skipped += 1; continue; }
          await db.createForwardRule({
            userId: ctx.user.id,
            hostId: newHostId,
            name: r.name,
            forwardType: r.forwardType,
            protocol: r.protocol,
            sourcePort: Number(r.sourcePort),
            targetIp: r.targetIp,
            targetPort: Number(r.targetPort),
            isEnabled: !!r.isEnabled,
            isRunning: false,
          });
          summary.rules.created += 1;
        }

        return { success: true, mode, summary };
      }),
  }),
});

export type AppRouter = typeof appRouter;
