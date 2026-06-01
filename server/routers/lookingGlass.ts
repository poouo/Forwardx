import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import dns from "dns";
import net from "net";
import os from "os";
import { spawn } from "child_process";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { pushAgentRefresh } from "../agentEvents";
import { enqueueLookingGlassAgentTask, type LookingGlassAgentResult } from "../lookingGlassAgentTasks";
import { requireHostAccess } from "./helpers";

const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_OUTPUT_LIMIT = 32_000;
const TCP_TIMEOUT_MS = 10_000;

const methodSchema = z.enum(["ping", "ping6", "traceroute", "traceroute6", "mtr", "mtr6", "tcp"]);

type LookingGlassMethod = z.infer<typeof methodSchema>;

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
  const resolved = literalFamily
    ? [{ address: target, family: literalFamily }]
    : await dns.promises.lookup(target, { all: true, family, verbatim: true });

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

function commandFor(method: Exclude<LookingGlassMethod, "tcp">, host: string) {
  const platform = os.platform();
  const ipv6 = method.endsWith("6");
  if (method === "ping" || method === "ping6") {
    if (platform === "win32") return { command: "ping", args: [ipv6 ? "-6" : "-4", "-n", "4", host] };
    return { command: "ping", args: [ipv6 ? "-6" : "-4", "-c", "4", "-W", "3", host] };
  }
  if (method === "traceroute" || method === "traceroute6") {
    if (platform === "win32") return { command: "tracert", args: [ipv6 ? "-6" : "-4", "-d", "-h", "20", host] };
    return { command: "traceroute", args: [ipv6 ? "-6" : "-4", "-n", "-m", "20", "-w", "2", host] };
  }
  if (platform === "win32") {
    throw new Error("当前系统未提供 MTR 命令，请在 Linux 面板环境安装 mtr 后使用");
  }
  return { command: "mtr", args: [ipv6 ? "-6" : "-4", "--report", "--report-cycles", "10", "--no-dns", host] };
}

function runCommand(command: string, args: string[]) {
  return new Promise<{ output: string; exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let output = "";
    let settled = false;
    let timedOut = false;

    const append = (chunk: Buffer) => {
      if (output.length >= COMMAND_OUTPUT_LIMIT) return;
      output += chunk.toString("utf8");
      if (output.length > COMMAND_OUTPUT_LIMIT) {
        output = `${output.slice(0, COMMAND_OUTPUT_LIMIT)}\n... 输出已截断`;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`命令不可用或执行失败：${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output: output.trim(), exitCode: code, timedOut });
    });
  });
}

function tcpConnect(host: string, port: number, family: number) {
  return new Promise<{ output: string; latencyMs: number; ok: boolean }>((resolve) => {
    const startedAt = performance.now();
    const socket = net.createConnection({ host, port, family: family === 6 ? 6 : family === 4 ? 4 : undefined });
    let settled = false;
    const finish = (ok: boolean, message: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const latencyMs = Math.round(performance.now() - startedAt);
      resolve({ ok, latencyMs, output: `${message}\n耗时: ${latencyMs} ms` });
    };
    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.on("connect", () => finish(true, `TCP ${host}:${port} 连接成功`));
    socket.on("timeout", () => finish(false, `TCP ${host}:${port} 连接超时`));
    socket.on("error", (error: any) => finish(false, `TCP ${host}:${port} 连接失败：${error?.message || "unknown error"}`));
  });
}

export const lookingGlassRouter = router({
  run: protectedProcedure
    .input(z.object({
      method: methodSchema,
      target: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535).optional(),
      hostId: z.number().int().positive().nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin") {
        const userEnabled = (await db.getSetting("lookingGlassUserEnabled")) !== "false";
        if (!userEnabled) {
          throw new TRPCError({ code: "FORBIDDEN", message: "管理员已关闭普通用户使用 Looking Glass" });
        }
      }

      const method = input.method;
      const target = normalizeTarget(input.target);
      const resolved = await resolvePublicTarget(target, method);
      const startedAt = new Date();
      const hostId = Number(input.hostId || 0);

      if (hostId > 0) {
        const host = await requireHostAccess(ctx, hostId);
        const { task, promise } = enqueueLookingGlassAgentTask(hostId, {
          method,
          target,
          resolvedAddress: resolved.address,
          resolvedAddresses: resolved.addresses,
          family: resolved.family,
          ...(method === "tcp" ? { port: input.port || 443 } : {}),
        });
        pushAgentRefresh(hostId, "looking-glass");
        const result = await promise;
        return {
          ...result,
          sourceHostId: hostId,
          sourceHostName: (host as any).name || `Host #${hostId}`,
          taskId: task.taskId,
          startedAt: new Date(result.startedAt),
          finishedAt: new Date(result.finishedAt),
        } as LookingGlassAgentResult & { sourceHostId: number; sourceHostName: string };
      }

      if (method === "tcp") {
        const port = input.port || 443;
        const result = await tcpConnect(resolved.address, port, resolved.family);
        return {
          method,
          target,
          port,
          resolvedAddress: resolved.address,
          resolvedAddresses: resolved.addresses,
          output: result.output,
          exitCode: result.ok ? 0 : 1,
          timedOut: false,
          durationMs: result.latencyMs,
          startedAt,
          finishedAt: new Date(),
        };
      }

      const { command, args } = commandFor(method, resolved.address);
      const commandStartedAt = performance.now();
      const result = await runCommand(command, args);
      return {
        method,
        target,
        resolvedAddress: resolved.address,
        resolvedAddresses: resolved.addresses,
        output: result.output || "命令没有返回输出",
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: Math.round(performance.now() - commandStartedAt),
        startedAt,
        finishedAt: new Date(),
      };
    }),
});
