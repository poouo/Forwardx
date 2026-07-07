import dns from "dns";
import net from "net";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import * as db from "../db";
import { pushAgentRefresh } from "../agentEvents";
import {
  enqueueLookingGlassAgentTask,
  getLookingGlassAgentTaskStatus,
  hasActiveLookingGlassTask,
  type LookingGlassTaskStatus,
} from "../lookingGlassAgentTasks";
import {
  AUTO_IPERF3_SERVER_PORT,
  enqueueIperf3AgentTask,
  getIperf3Status,
  hasActiveIperf3Task,
  type Iperf3Status,
} from "../iperf3AgentTasks";
import { requireHostAccess } from "./helpers";

const methodSchema = z.enum(["ping", "ping6", "traceroute", "traceroute6", "mtr", "mtr6", "tcp"]);

type LookingGlassMethod = z.infer<typeof methodSchema>;

async function assertNetworkTestAllowed(ctx: { user: { role: string } }) {
  if (ctx.user.role === "admin") return;
  const userEnabled = (await db.getSetting("lookingGlassUserEnabled")) !== "false";
  if (!userEnabled) {
    throw new TRPCError({ code: "FORBIDDEN", message: "管理员已关闭普通用户使用网络测试" });
  }
}

function getRequestIp(req: any) {
  const headerIp =
    String(req.headers?.["cf-connecting-ip"] || "").trim() ||
    String(req.headers?.["x-real-ip"] || "").trim() ||
    String(req.headers?.["x-forwarded-for"] || "").split(",")[0]?.trim();
  const raw = headerIp || String(req.ip || req.socket?.remoteAddress || "").trim() || "unknown";
  return raw.replace(/^::ffff:/, "");
}

function normalizeTarget(target: string) {
  const value = target.trim();
  if (!value || value.length > 253) throw new Error("请输入有效的目标地址");
  if (/[\s'"`<>|;&$\\]/.test(value)) throw new Error("目标地址包含不支持的字符");
  return value.replace(/^\[|\]$/g, "");
}

function isPrivateIpv4(ip: string) {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(ip: string) {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fec0:") ||
    normalized.startsWith("ff")
  );
}

function isPrivateAddress(address: string) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

async function resolvePublicTarget(target: string, method: LookingGlassMethod) {
  const family = method.endsWith("6") ? 6 : method === "tcp" ? 0 : 4;
  const literalFamily = net.isIP(target);
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = literalFamily
      ? [{ address: target, family: literalFamily }]
      : await dns.promises.lookup(target, { all: true, family, verbatim: true });
  } catch (error: any) {
    if (method.endsWith("6")) {
      throw new Error(`目标 ${target} 没有可用 IPv6 地址，无法执行 IPv6 网络测试`);
    }
    throw new Error(`目标 ${target} 无法解析：${error?.message || "DNS 查询失败"}`);
  }

  if (resolved.length === 0) throw new Error("目标无法解析");
  const invalid = resolved.find((entry) => isPrivateAddress(entry.address));
  if (invalid) throw new Error(`目标解析到内网或保留地址，已拒绝执行：${invalid.address}`);

  const preferred = resolved.find((entry) => family === 0 || entry.family === family) || resolved[0];
  return {
    host: target,
    address: preferred.address,
    family: preferred.family,
    addresses: resolved.map((entry) => entry.address),
  };
}

function normalizeAgentPublicAddress(host: any) {
  const raw = String(host?.ipv4 || host?.ipv6 || host?.ip || host?.entryIp || "").trim();
  if (!raw || raw.toLowerCase() === "unknown") {
    throw new Error("该主机缺少可用于 iperf3 测试的公网地址");
  }

  let value = raw.replace(/^https?:\/\//i, "");
  value = value.split(/[/?#]/)[0].trim();
  if (value.startsWith("[") && value.includes("]")) {
    value = value.slice(1, value.indexOf("]"));
  } else if (!net.isIP(value) && value.includes(":")) {
    value = value.split(":")[0];
  }
  if (!value || value.toLowerCase() === "unknown") {
    throw new Error("该主机缺少可用于 iperf3 测试的公网地址");
  }
  return value;
}

function hostHasIpv6(host: any) {
  const candidates = [host?.ipv6, host?.ip, host?.entryIp, host?.tunnelEntryIp]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return candidates.some((value) => {
    let normalized = value.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].trim();
    if (normalized.startsWith("[") && normalized.includes("]")) {
      normalized = normalized.slice(1, normalized.indexOf("]"));
    }
    return net.isIP(normalized) === 6;
  });
}

function decorateStatus(status: LookingGlassTaskStatus, host: any) {
  return {
    ...status,
    sourceHostId: Number(host.id),
    sourceHostName: String(host.name || `Host #${host.id}`),
  };
}

function decorateIperf3Status(status: Iperf3Status, host: any) {
  const address = normalizeAgentPublicAddress(host);
  const port = Number(status.port || AUTO_IPERF3_SERVER_PORT);
  const hasPort = port > 0;
  return {
    ...status,
    port,
    hostId: Number(host.id),
    hostName: String(host.name || `Host #${host.id}`),
    hostAddress: address,
    commands: {
      upload: hasPort ? `iperf3 -c ${address} -p ${port}` : "",
      download: hasPort ? `iperf3 -c ${address} -p ${port} -R` : "",
    },
  };
}

export const lookingGlassRouter = router({
  clientInfo: protectedProcedure.query(({ ctx }) => {
    return { ip: getRequestIp(ctx.req) };
  }),

  start: protectedProcedure
    .input(z.object({
      method: methodSchema,
      target: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535).optional(),
      hostId: z.number().int().positive(),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertNetworkTestAllowed(ctx);

      const method = input.method;
      const target = normalizeTarget(input.target);
      const host = await requireHostAccess(ctx, input.hostId);
      if (hasActiveIperf3Task(input.hostId)) {
        throw new Error("该测试主机已有 iperf3 服务端测试正在执行，请停止或等待结束后再开始新的网络测试");
      }
      if (method.endsWith("6") && !hostHasIpv6(host)) {
        throw new Error(`测试主机「${(host as any).name || `Host #${input.hostId}`}」未检测到 IPv6 地址，无法执行 ${methodMetaLabel(method)} 测试`);
      }
      const resolved = await resolvePublicTarget(target, method);
      const { task, status } = enqueueLookingGlassAgentTask(input.hostId, {
        method,
        target,
        resolvedAddress: resolved.address,
        resolvedAddresses: resolved.addresses,
        family: resolved.family,
        ...(method === "tcp" ? { port: input.port || 443 } : {}),
      });
      pushAgentRefresh(input.hostId, "looking-glass");
      return decorateStatus({ ...status, taskId: task.taskId }, host);
    }),

  status: protectedProcedure
    .input(z.object({
      hostId: z.number().int().positive(),
      taskId: z.string().min(8).max(128),
    }))
    .query(async ({ input, ctx }) => {
      await assertNetworkTestAllowed(ctx);
      const host = await requireHostAccess(ctx, input.hostId);
      const status = getLookingGlassAgentTaskStatus(input.hostId, input.taskId);
      if (!status) {
        throw new TRPCError({ code: "NOT_FOUND", message: "网络测试任务不存在或已过期" });
      }
      return decorateStatus(status, host);
    }),

  iperf3Start: protectedProcedure
    .input(z.object({
      hostId: z.number().int().positive(),
      port: z.number().int().min(1).max(65535).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertNetworkTestAllowed(ctx);
      const host = await requireHostAccess(ctx, input.hostId) as any;
      if (!String(host?.agentToken || "")) throw new Error("该主机未绑定 Agent，无法启动 iperf3 服务端");
      if (hasActiveLookingGlassTask(input.hostId)) {
        throw new Error("该测试主机已有网络测试正在执行，请等待完成后再启动 iperf3 服务端");
      }
      normalizeAgentPublicAddress(host);
      const { status } = enqueueIperf3AgentTask(input.hostId, {
        op: "start",
        port: input.port,
      });
      pushAgentRefresh(input.hostId, "iperf3-start");
      return decorateIperf3Status(status, host);
    }),

  iperf3Stop: protectedProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await assertNetworkTestAllowed(ctx);
      const host = await requireHostAccess(ctx, input.hostId) as any;
      if (!String(host?.agentToken || "")) throw new Error("该主机未绑定 Agent，无法停止 iperf3 服务端");
      const current = getIperf3Status(input.hostId);
      const { status } = enqueueIperf3AgentTask(input.hostId, {
        op: "stop",
        port: current.port || AUTO_IPERF3_SERVER_PORT,
      });
      pushAgentRefresh(input.hostId, "iperf3-stop");
      return decorateIperf3Status(status, host);
    }),

  iperf3Status: protectedProcedure
    .input(z.object({ hostId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      await assertNetworkTestAllowed(ctx);
      const host = await requireHostAccess(ctx, input.hostId) as any;
      return decorateIperf3Status(getIperf3Status(input.hostId), host);
    }),
});

function methodMetaLabel(method: LookingGlassMethod) {
  if (method === "ping6") return "Ping IPv6";
  if (method === "traceroute6") return "Traceroute IPv6";
  if (method === "mtr6") return "MTR IPv6";
  return method;
}
