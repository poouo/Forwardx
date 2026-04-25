import { COOKIE_NAME } from "../shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, adminProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { nanoid } from "nanoid";
import jwt from "jsonwebtoken";
import { ENV } from "./env";
import * as db from "./db";
import { generateFullInstallScript } from "./agentRoutes";

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(({ ctx }) => {
      if (!ctx.user) return null;
      // Return user info without password
      const { password, ...safeUser } = ctx.user;
      return safeUser;
    }),

    login: publicProcedure
      .input(z.object({
        username: z.string().min(1, "请输入用户名"),
        password: z.string().min(1, "请输入密码"),
      }))
      .mutation(async ({ input, ctx }) => {
        const user = await db.authenticateUser(input.username, input.password);
        if (!user) {
          throw new Error("用户名或密码错误");
        }

        // Create JWT token
        const token = jwt.sign({ userId: user.id }, ENV.cookieSecret, { expiresIn: "365d" });
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, token, cookieOptions);

        const { password, ...safeUser } = user;
        return safeUser;
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
        role: z.enum(["user", "admin"]).default("user"),
      }))
      .mutation(async ({ input }) => {
        // Check if username already exists
        const existing = await db.getUserByUsername(input.username);
        if (existing) {
          throw new Error("用户名已存在");
        }
        const id = await db.createUser(input);
        return { id };
      }),
    updateRole: adminProcedure
      .input(z.object({ userId: z.number(), role: z.enum(["user", "admin"]) }))
      .mutation(async ({ input }) => {
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
        await db.deleteUser(input.userId);
        return { success: true };
      }),
  }),

  // ==================== Host Management ====================
  hosts: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getHosts(isAdmin ? undefined : ctx.user.id);
    }),
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) return null;
        if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) return null;
        return host;
      }),
    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(128),
        ip: z.string().min(1).max(64),
        // 端口可选：前端在 agent 连接下禁用输入不会传 port，这里允许 null/undefined
        port: z.number().int().min(1).max(65535).nullable().optional(),
        hostType: z.enum(["master", "slave"]).default("slave"),
        connectionType: z.enum(["ssh", "agent"]).default("agent"),
        sshUser: z.string().optional(),
        sshPassword: z.string().optional(),
        sshKeyContent: z.string().optional(),
        networkInterface: z.string().max(32).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // 非 SSH 连接的主机不依赖业务端口，统一强制为 22，以避免误导
        const safePort = input.connectionType === "ssh" ? (input.port ?? 22) : 22;
        const agentToken = input.connectionType === "agent" ? nanoid(32) : undefined;
        const id = await db.createHost({
          ...input,
          port: safePort,
          agentToken: agentToken ?? null,
          networkInterface: input.networkInterface || null,
          userId: ctx.user.id,
        });
        return { id, agentToken };
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).max(128).optional(),
        ip: z.string().min(1).max(64).optional(),
        // 端口可选、可为 null：避免 agent 连接下端口被重置为 undefined 又被 Zod min(1) 抦截
        port: z.number().int().min(1).max(65535).nullable().optional(),
        hostType: z.enum(["master", "slave"]).optional(),
        connectionType: z.enum(["ssh", "agent"]).optional(),
        sshUser: z.string().nullable().optional(),
        sshPassword: z.string().nullable().optional(),
        sshKeyContent: z.string().nullable().optional(),
        networkInterface: z.string().max(32).nullable().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) throw new Error("Host not found");
        if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) throw new Error("Forbidden");
        const { id, ...data } = input;
        // 连接方式与端口联动：取补丁后的连接方式，非 SSH 一律强制 22
        const effectiveType = data.connectionType ?? host.connectionType;
        if (effectiveType !== "ssh") {
          data.port = 22;
        } else if (data.port == null) {
          // SSH 却未传 port：保留库中原值，不覆盖
          delete (data as any).port;
        }
        await db.updateHost(id, data as any);
        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const host = await db.getHostById(input.id);
        if (!host) throw new Error("Host not found");
        if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) throw new Error("Forbidden");
        await db.deleteHost(input.id);
        return { success: true };
      }),
    metrics: protectedProcedure
      .input(z.object({ hostId: z.number(), limit: z.number().default(60) }))
      .query(async ({ input }) => {
        return db.getLatestHostMetrics(input.hostId, input.limit);
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
    create: protectedProcedure
      .input(z.object({
        hostId: z.number(),
        name: z.string().min(1).max(128),
        forwardType: z.enum(["iptables", "realm", "socat"]).default("iptables"),
        protocol: z.enum(["tcp", "udp", "both"]).default("tcp"),
        sourcePort: z.number().min(1).max(65535),
        targetIp: z.string().min(1).max(64),
        targetPort: z.number().min(1).max(65535),
        uploadLimit: z.number().min(0).default(0),
        downloadLimit: z.number().min(0).default(0),
      }))
      .mutation(async ({ input, ctx }) => {
        const host = await db.getHostById(input.hostId);
        if (!host) throw new Error("Host not found");
        if (ctx.user.role !== "admin" && host.userId !== ctx.user.id) throw new Error("Forbidden");
        const id = await db.createForwardRule({ ...input, userId: ctx.user.id });
        return { id };
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).max(128).optional(),
        forwardType: z.enum(["iptables", "realm", "socat"]).optional(),
        protocol: z.enum(["tcp", "udp", "both"]).optional(),
        sourcePort: z.number().min(1).max(65535).optional(),
        targetIp: z.string().min(1).max(64).optional(),
        targetPort: z.number().min(1).max(65535).optional(),
        uploadLimit: z.number().min(0).optional(),
        downloadLimit: z.number().min(0).optional(),
        isEnabled: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const rule = await db.getForwardRuleById(input.id);
        if (!rule) throw new Error("Rule not found");
        if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("Forbidden");
        const { id, ...data } = input;
        // 关键字段变更时重置 isRunning，以便 agent 下次心跳重新下发并应用
        const watchedFields: Array<keyof typeof data> = [
          "sourcePort",
          "targetIp",
          "targetPort",
          "forwardType",
          "protocol",
        ];
        const keyFieldChanged = watchedFields.some((f) => {
          const v = data[f];
          return v !== undefined && v !== (rule as any)[f];
        });
        if (keyFieldChanged) {
          (data as any).isRunning = false;
        }
        await db.updateForwardRule(id, data);
        return { success: true, reset: keyFieldChanged };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const rule = await db.getForwardRuleById(input.id);
        if (!rule) throw new Error("Rule not found");
        if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("Forbidden");
        await db.deleteForwardRule(input.id);
        return { success: true };
      }),
    toggle: protectedProcedure
      .input(z.object({ id: z.number(), isEnabled: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        const rule = await db.getForwardRuleById(input.id);
        if (!rule) throw new Error("Rule not found");
        if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) throw new Error("Forbidden");
        // 启用时允许 agent 重新下发；禁用时仅改 isEnabled，保留 isRunning=true 作为“需要清理”的信号
        // 心跳逻辑依赖 isEnabled=false && isRunning=true 这种组合下发删除命令
        if (input.isEnabled) {
          await db.updateForwardRule(input.id, { isEnabled: true, isRunning: false });
        } else {
          await db.toggleForwardRule(input.id, false);
        }
        return { success: true };
      }),
    traffic: protectedProcedure
      .input(z.object({ ruleId: z.number(), limit: z.number().default(60) }))
      .query(async ({ input }) => {
        return db.getTrafficStats(input.ruleId, input.limit);
      }),
    // 按规则汇总所有可见范围内的流量（默认近 24小时）
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
    // 按时间分桶返回单条规则的流量序列，用于前端画图
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
        if (!rule) throw new Error("Rule not found");
        if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
          throw new Error("Forbidden");
        }
        const since = new Date(Date.now() - input.hours * 3600 * 1000);
        return db.getTrafficSeriesByRule(input.ruleId, {
          bucketMinutes: input.bucketMinutes,
          since,
        });
      }),

    // 启动一次转发自测：写入 forward_tests 为 pending，心跳返回后 Agent 取走并执行
    startSelfTest: protectedProcedure
      .input(z.object({ ruleId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const rule = await db.getForwardRuleById(input.ruleId);
        if (!rule) throw new Error("规则不存在");
        if (ctx.user.role !== "admin" && rule.userId !== ctx.user.id) {
          throw new Error("Forbidden");
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

  // ==================== Agent Tokens ====================
  agentTokens: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const isAdmin = ctx.user.role === "admin";
      return db.getAgentTokens(isAdmin ? undefined : ctx.user.id);
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
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteAgentToken(input.id);
        return { success: true };
      }),
    getInstallScript: protectedProcedure
      .input(z.object({ token: z.string(), panelUrl: z.string().optional() }))
      .query(({ input, ctx }) => {
        // 返回真正的安装脚本，而不是 token 字符串
        // 优先使用调用方传入的 panelUrl（面板实际访问地址）
        const reqAny = ctx.req as any;
        const fallbackHost = reqAny?.get?.("host") || "localhost:3000";
        const fallbackProto = reqAny?.protocol || "http";
        const panelUrl = input.panelUrl || `${fallbackProto}://${fallbackHost}`;
        const script = generateFullInstallScript(panelUrl, input.token);
        return { script, token: input.token };
      }),
  }),

  // ==================== Config Backup / Restore ====================
  config: router({
    // 导出面板配置（主机 / 规则 / Agent Token / 非 admin 用户只导出自己的）
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
        version: 2,
        exportedAt: new Date().toISOString(),
        scope: isAdmin ? "all" : "self",
        owner: { id: ctx.user.id, username: (ctx.user as any).username, role: ctx.user.role },
        hosts: hosts.map((h: any) => ({
          id: h.id,
          userId: h.userId,
          name: h.name,
          ip: h.ip,
          port: h.port,
          hostType: h.hostType,
          connectionType: h.connectionType,
          sshUser: h.sshUser,
          // 凭证以明文导出，调用者应负责保护备份文件
          sshPassword: h.sshPassword,
          sshKeyContent: h.sshKeyContent,
          // Agent 全量字段，避免导入后丢失被控机心跳上下文
          agentToken: h.agentToken,
          osInfo: h.osInfo,
          cpuInfo: h.cpuInfo,
          memoryTotal: h.memoryTotal,
          networkInterface: h.networkInterface,
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
          uploadLimit: r.uploadLimit,
          downloadLimit: r.downloadLimit,
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
          usedAt: t.usedAt,
        })),
        users: users.map((u: any) => ({
          id: u.id,
          username: u.username,
          name: u.name,
          email: u.email,
          role: u.role,
        })),
      };
    }),

    // 导入配置文件。默认 mode="merge"：同名跳过；可选 mode="replace"：先清理现有后全量导入
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
          // 仅清理当前用户作为拥有人的主机与规则，避免跨账号误删
          const existRules = await db.getForwardRules(ctx.user.id);
          for (const r of existRules) await db.deleteForwardRule(r.id);
          const existHosts = await db.getHosts(ctx.user.id);
          for (const h of existHosts) await db.deleteHost(h.id);
          const existTokens = await db.getAgentTokens(ctx.user.id);
          for (const t of existTokens) await db.deleteAgentToken(t.id);
        }

        // 主机导入：agent 主机优先按 agentToken 判重，其他按名称判重

        // 建立原 hostId -> 新 hostId 映射
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
            port: h.connectionType === "ssh" ? Number(h.port || 22) : 22,
            hostType: h.hostType || "slave",
            connectionType: h.connectionType || "agent",
            sshUser: h.sshUser ?? h.username ?? null,
            sshPassword: h.sshPassword ?? h.password ?? null,
            sshKeyContent: h.sshKeyContent ?? h.privateKey ?? null,
            agentToken: h.agentToken ?? null,
            osInfo: h.osInfo ?? null,
            cpuInfo: h.cpuInfo ?? null,
            memoryTotal: h.memoryTotal ?? null,
            networkInterface: h.networkInterface ?? null,
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
          const newTokenId = await db.createAgentToken({
            token: t.token,
            description: t.description ?? null,
            userId: ctx.user.id,
          });
          // 如果导出时 token 已绑定某台主机，导入后同步标记已使用
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
            uploadLimit: Number(r.uploadLimit || 0),
            downloadLimit: Number(r.downloadLimit || 0),
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
