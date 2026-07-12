import { z } from "zod";
import type { TrpcContext } from "./_core/context";
import { appendPanelLog } from "./_core/panelLogger";
import { dashboardRouter } from "./routers/dashboard";
import { forwardGroupsRouter } from "./routers/forwardGroups";
import { hostsRouter } from "./routers/hosts";
import { rulesRouter } from "./routers/rules";
import { tunnelsRouter } from "./routers/tunnels";
import { usersRouter } from "./routers/users";
import { sendTelegramMessage } from "./telegramBot";
import { getForwardGroupById } from "./repositories/forwardGroupRepository";
import { getTunnelById } from "./repositories/tunnelRepository";
import { getUserById } from "./repositories/userRepository";
import type {
  PluginPanelOperation,
  PluginPermissionKey,
} from "../shared/pluginTypes";

const MAX_PANEL_INPUT_BYTES = 64 * 1024;
const MAX_TELEGRAM_TEXT_LENGTH = 4096;

type PanelPlugin = {
  pluginId?: string;
  name?: string;
  trusted?: boolean | number;
  permissions?: PluginPermissionKey[];
  manifest?: { permissions?: PluginPermissionKey[] };
};

type OperationDefinition = {
  permission: PluginPermissionKey;
  intent: "read" | "write" | "execute";
  execute: (context: TrpcContext, input: Record<string, unknown>) => Promise<unknown>;
};

function panelCallers(context: TrpcContext) {
  return {
    dashboard: dashboardRouter.createCaller(context),
    forwardGroups: forwardGroupsRouter.createCaller(context),
    hosts: hostsRouter.createCaller(context),
    rules: rulesRouter.createCaller(context),
    tunnels: tunnelsRouter.createCaller(context),
    users: usersRouter.createCaller(context),
  } as any;
}

function positiveId(input: Record<string, unknown>, key: string) {
  const value = Number(input[key]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} 必须是正整数`);
  return value;
}

const OPERATIONS: Record<PluginPanelOperation, OperationDefinition> = {
  "system.summary": {
    permission: "read:system",
    intent: "read",
    execute: async (context) => {
      const callers = panelCallers(context);
      const [users, hosts, tunnels, forwardGroups] = await Promise.all([
        callers.users.summary(),
        callers.hosts.listAll(),
        callers.tunnels.listAll(),
        callers.forwardGroups.list(),
      ]);
      return {
        ...users,
        totalHosts: Array.isArray(hosts) ? hosts.length : 0,
        onlineHosts: Array.isArray(hosts) ? hosts.filter((host: any) => host?.isOnline).length : 0,
        totalTunnels: Array.isArray(tunnels) ? tunnels.length : 0,
        totalForwardGroups: Array.isArray(forwardGroups) ? forwardGroups.length : 0,
      };
    },
  },
  "users.list": { permission: "read:users", intent: "read", execute: async (context) => panelCallers(context).users.list() },
  "users.get": { permission: "read:users", intent: "read", execute: async (_context, input) => getUserById(positiveId(input, "userId")) },
  "users.create": { permission: "write:users", intent: "write", execute: async (context, input) => panelCallers(context).users.create(input) },
  "users.updateAccount": { permission: "write:users", intent: "write", execute: async (context, input) => panelCallers(context).users.resetPassword(input) },
  "users.updateLimits": { permission: "write:users", intent: "write", execute: async (context, input) => panelCallers(context).users.updateTrafficSettings(input) },
  "users.setAccountEnabled": { permission: "write:users", intent: "write", execute: async (context, input) => panelCallers(context).users.setAccountEnabled(input) },
  "users.setForwardAccess": { permission: "write:users", intent: "write", execute: async (context, input) => panelCallers(context).users.setForwardAccess(input) },
  "users.delete": { permission: "write:users", intent: "write", execute: async (context, input) => panelCallers(context).users.delete(input) },
  "users.permissions.get": {
    permission: "read:users",
    intent: "read",
    execute: async (context, input) => {
      const userId = positiveId(input, "userId");
      const callers = panelCallers(context).users;
      const [hostIds, tunnelIds, forwardGroupIds, trafficBilling] = await Promise.all([
        callers.getHostPermissions({ userId }),
        callers.getTunnelPermissions({ userId }),
        callers.getForwardGroupPermissions({ userId }),
        callers.getTrafficBillingPermissions({ userId }),
      ]);
      return { userId, hostIds, tunnelIds, forwardGroupIds, trafficBilling };
    },
  },
  "users.permissions.set": {
    permission: "write:users",
    intent: "write",
    execute: async (context, input) => {
      const userId = positiveId(input, "userId");
      const callers = panelCallers(context).users;
      const tasks: Promise<unknown>[] = [];
      if (Array.isArray(input.hostIds)) tasks.push(callers.setHostPermissions({ userId, hostIds: input.hostIds }));
      if (Array.isArray(input.tunnelIds)) tasks.push(callers.setTunnelPermissions({ userId, tunnelIds: input.tunnelIds }));
      if (Array.isArray(input.forwardGroupIds)) tasks.push(callers.setForwardGroupPermissions({ userId, forwardGroupIds: input.forwardGroupIds }));
      if (input.trafficBilling && typeof input.trafficBilling === "object" && !Array.isArray(input.trafficBilling)) {
        tasks.push(callers.setTrafficBillingPermissions({ ...(input.trafficBilling as object), userId }));
      }
      if (!tasks.length) throw new Error("至少提供一种需要更新的用户权限");
      await Promise.all(tasks);
      return { success: true, updated: tasks.length };
    },
  },
  "hosts.list": { permission: "read:hosts", intent: "read", execute: async (context) => panelCallers(context).hosts.listAll() },
  "hosts.get": { permission: "read:hosts", intent: "read", execute: async (context, input) => panelCallers(context).hosts.getById({ id: positiveId(input, "id") }) },
  "hosts.create": { permission: "write:hosts", intent: "write", execute: async (context, input) => panelCallers(context).hosts.create(input) },
  "hosts.update": { permission: "write:hosts", intent: "write", execute: async (context, input) => panelCallers(context).hosts.update(input) },
  "hosts.delete": { permission: "write:hosts", intent: "write", execute: async (context, input) => panelCallers(context).hosts.delete(input) },
  "rules.list": {
    permission: "read:rules",
    intent: "read",
    execute: async (context, input) => panelCallers(context).rules.list({ scope: "all", ...input }),
  },
  "rules.get": { permission: "read:rules", intent: "read", execute: async (context, input) => panelCallers(context).rules.getById({ id: positiveId(input, "id") }) },
  "rules.create": { permission: "write:rules", intent: "write", execute: async (context, input) => panelCallers(context).rules.create(input) },
  "rules.update": { permission: "write:rules", intent: "write", execute: async (context, input) => panelCallers(context).rules.update(input) },
  "rules.toggle": { permission: "write:rules", intent: "write", execute: async (context, input) => panelCallers(context).rules.toggle(input) },
  "rules.delete": { permission: "write:rules", intent: "write", execute: async (context, input) => panelCallers(context).rules.delete(input) },
  "tunnels.list": { permission: "read:tunnels", intent: "read", execute: async (context) => panelCallers(context).tunnels.listAll() },
  "tunnels.get": { permission: "read:tunnels", intent: "read", execute: async (_context, input) => getTunnelById(positiveId(input, "id")) },
  "tunnels.create": { permission: "write:tunnels", intent: "write", execute: async (context, input) => panelCallers(context).tunnels.create(input) },
  "tunnels.update": { permission: "write:tunnels", intent: "write", execute: async (context, input) => panelCallers(context).tunnels.update(input) },
  "tunnels.delete": { permission: "write:tunnels", intent: "write", execute: async (context, input) => panelCallers(context).tunnels.delete(input) },
  "tunnels.test": { permission: "write:tunnels", intent: "execute", execute: async (context, input) => panelCallers(context).tunnels.test(input) },
  "forwardGroups.list": { permission: "read:forward-groups", intent: "read", execute: async (context) => panelCallers(context).forwardGroups.list() },
  "forwardGroups.get": { permission: "read:forward-groups", intent: "read", execute: async (_context, input) => getForwardGroupById(positiveId(input, "id")) },
  "forwardGroups.create": { permission: "write:forward-groups", intent: "write", execute: async (context, input) => panelCallers(context).forwardGroups.create(input) },
  "forwardGroups.update": { permission: "write:forward-groups", intent: "write", execute: async (context, input) => panelCallers(context).forwardGroups.update(input) },
  "forwardGroups.delete": { permission: "write:forward-groups", intent: "write", execute: async (context, input) => panelCallers(context).forwardGroups.delete(input) },
  "forwardGroups.sync": { permission: "write:forward-groups", intent: "execute", execute: async (context, input) => panelCallers(context).forwardGroups.sync(input) },
  "forwardGroups.test": { permission: "write:forward-groups", intent: "execute", execute: async (context, input) => panelCallers(context).forwardGroups.test(input) },
  "traffic.summary": {
    permission: "read:traffic",
    intent: "read",
    execute: async (context) => {
      const callers = panelCallers(context);
      const [summary, totals] = await Promise.all([callers.users.summary(), callers.dashboard.trafficTotals()]);
      return { ...summary, ...totals };
    },
  },
  "telegram.send": {
    permission: "telegram:send",
    intent: "execute",
    execute: async (_context, input) => {
      const parsed = z.object({
        chatId: z.union([z.string().trim().min(1).max(128), z.number().int()]),
        text: z.string().trim().min(1).max(MAX_TELEGRAM_TEXT_LENGTH),
      }).parse(input);
      await sendTelegramMessage(parsed.chatId, parsed.text);
      return { success: true };
    },
  },
};

const SENSITIVE_KEYS = new Set([
  "password",
  "newpassword",
  "twofactorsecret",
  "browsersessiontoken",
  "mobilesessiontoken",
  "telegramsessiontoken",
  "telegrambindcode",
  "telegramlogincode",
  "agenttoken",
  "token",
  "secret",
  "tunnelsecret",
  "certkeypem",
  "privatekey",
  "cookie",
  "authorization",
]);

export function redactPluginPanelResult(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => redactPluginPanelResult(item, depth + 1));
  if (typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
    if (SENSITIVE_KEYS.has(normalizedKey) || /(?:password|passwd|privatekey|sessiontoken|twofactorsecret|agenttoken|tunnelsecret|certkeypem|authorization|cookie|secret|token)$/i.test(normalizedKey)) {
      continue;
    }
    result[key] = redactPluginPanelResult(item, depth + 1);
  }
  return result;
}

function normalizePanelInput(value: unknown) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("面板 API 参数必须是对象");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PANEL_INPUT_BYTES) throw new Error("面板 API 参数不能超过 64KB");
  return value as Record<string, unknown>;
}

function pluginPermissions(plugin: PanelPlugin) {
  return new Set<PluginPermissionKey>([
    ...(Array.isArray(plugin.permissions) ? plugin.permissions : []),
    ...(Array.isArray(plugin.manifest?.permissions) ? plugin.manifest.permissions : []),
  ]);
}

export function getPluginPanelOperationCapabilities() {
  return Object.entries(OPERATIONS).map(([operation, definition]) => ({
    operation: operation as PluginPanelOperation,
    permission: definition.permission,
    intent: definition.intent,
  }));
}

export async function executePluginPanelRequest(input: {
  plugin: PanelPlugin;
  actionId: string;
  operation: PluginPanelOperation;
  actionInput?: unknown;
  context?: TrpcContext;
}) {
  const pluginId = String(input.plugin.pluginId || "unknown");
  const actorId = Number(input.context?.user?.id || 0);
  const operation = OPERATIONS[input.operation];
  const startedAt = Date.now();
  const audit = (result: "success" | "denied" | "failed") => {
    const level = result === "success" ? "info" : "warn";
    appendPanelLog(level, `[PluginAudit] plugin=${pluginId} action=${input.actionId} operation=${input.operation} actor=${actorId || "-"} result=${result} durationMs=${Date.now() - startedAt}`);
  };

  if (!operation) {
    audit("denied");
    throw new Error("插件请求了不受支持的面板 API 操作");
  }
  if (input.plugin.trusted !== true && Number(input.plugin.trusted || 0) !== 1) {
    audit("denied");
    throw new Error("该插件尚未设为信任，不能调用面板高权限 API");
  }
  if (!input.context?.user || input.context.user.role !== "admin") {
    audit("denied");
    throw new Error("只有管理员可以执行插件面板 API");
  }
  if (!pluginPermissions(input.plugin).has(operation.permission)) {
    audit("denied");
    throw new Error(`插件未声明所需权限 ${operation.permission}`);
  }

  try {
    const result = await operation.execute(input.context, normalizePanelInput(input.actionInput));
    audit("success");
    return {
      ok: true,
      message: "面板操作已执行",
      result: {
        type: "panel.request",
        actionId: input.actionId,
        operation: input.operation,
        body: redactPluginPanelResult(result),
      },
    };
  } catch (error) {
    audit("failed");
    throw error;
  }
}
