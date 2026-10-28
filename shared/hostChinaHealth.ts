import { z } from "zod";

const jsonPath = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/);
export const ipSwitchHookSchema = z.object({
  url: z.string().trim().min(1).max(4096).refine(value => {
    try { const url = new URL(value.replace(/\{\{(?:hostId|serviceId|ip|incidentId)\}\}/g, "1")); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash; } catch { return false; }
  }, "换 IP 接口必须是无内嵌账户、无片段的 HTTP 或 HTTPS 地址"),
  method: z.enum(["GET", "POST", "PUT"]).default("GET"),
  headers: z.record(z.string().max(4096)).default({}).refine(value => Object.keys(value).length <= 20 && Object.entries(value).every(([key, entry]) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && !/[\r\n]/.test(entry) && !/^(host|content-length|connection|transfer-encoding|upgrade|proxy-authorization|proxy-connection|trailer|te)$/i.test(key)), "接口请求头不合法"),
  body: z.string().max(16384).default(""),
  successMode: z.enum(["json", "http"]).default("json"),
  successPath: jsonPath.optional(),
  successValue: z.union([z.string().max(256), z.boolean(), z.number().finite()]).optional(),
  ipPath: jsonPath.optional(),
  updateAddress: z.enum(["none", "entry", "entry_and_tunnel"]).default("none"),
  timeoutSeconds: z.number().int().min(5).max(30).default(15),
}).strict().superRefine((value, ctx) => {
  if (value.successMode === "json" && (!value.successPath || value.successValue === undefined)) ctx.addIssue({ code: "custom", message: "请填写成功字段和预期值", path: ["successPath"] });
  if (value.method === "GET" && value.body) ctx.addIssue({ code: "custom", message: "GET 请求不能配置请求体", path: ["body"] });
  if (value.updateAddress !== "none" && !value.ipPath) ctx.addIssue({ code: "custom", message: "同步主机地址必须填写新 IP 的 JSON 路径", path: ["ipPath"] });
});
export const hostChinaHealthSchema = z.object({
  enabled: z.boolean().default(false),
  notify: z.boolean().default(true),
  notifyUserId: z.number().int().positive().nullable().default(null),
  autoSwitch: z.boolean().default(false),
  failureThreshold: z.number().int().min(2).max(20).default(3),
  failureSeconds: z.number().int().min(30).max(3600).default(120),
  recoveryThreshold: z.number().int().min(2).max(20).default(2),
  cooldownSeconds: z.number().int().min(300).max(86400).default(3600),
  maxSwitchesPerDay: z.number().int().min(1).max(10).default(3),
  hook: ipSwitchHookSchema.optional(),
}).strict();
export const defaultHostChinaHealth = hostChinaHealthSchema.parse({});
export type HostChinaHealthConfig = z.infer<typeof hostChinaHealthSchema>;
export type IpSwitchHook = z.infer<typeof ipSwitchHookSchema>;
export type ChinaHealthState = {
  phase: "unknown" | "healthy" | "suspect" | "unhealthy" | "recovering";
  failures: number; successes: number; failureSince: number; lastSeen: number;
  incidentId: string; actionAttempted: boolean;
  actionBlockedReason?: "agent_unavailable" | "unresolved" | "daily_limit" | "cooldown";
  actionRetryAt?: number;
};
export function advanceChinaHealth(previous: ChinaHealthState | null, success: boolean, now: number, interval: number, config: HostChinaHealthConfig) {
  const state: ChinaHealthState = previous ? { ...previous } : { phase: "unknown", failures: 0, successes: 0, failureSince: 0, lastSeen: 0, incidentId: "", actionAttempted: false };
  if (state.lastSeen && now - state.lastSeen < Math.max(3, interval * 0.8)) return { state, event: undefined };
  if (state.lastSeen && now - state.lastSeen > Math.max(120, interval * 3)) { state.failures = 0; state.successes = 0; state.failureSince = 0; }
  state.lastSeen = now;
  let event: "unhealthy" | "recovered" | undefined;
  if (success) {
    state.failures = 0; state.failureSince = 0; state.successes++;
    if (state.phase === "unhealthy" || state.phase === "recovering") {
      state.phase = "recovering";
      if (state.successes >= config.recoveryThreshold) {
        state.phase = "healthy"; event = "recovered"; state.incidentId = ""; state.actionAttempted = false;
        delete state.actionBlockedReason; delete state.actionRetryAt;
      }
    } else state.phase = "healthy";
  } else {
    state.successes = 0; state.failures++;
    if (!state.failureSince) state.failureSince = now;
    if (state.phase === "recovering") state.phase = "unhealthy";
    if (state.phase !== "unhealthy") {
      state.phase = "suspect";
      if (state.failures >= config.failureThreshold && now - state.failureSince >= config.failureSeconds) { state.phase = "unhealthy"; event = "unhealthy"; }
    }
  }
  return { state, event };
}
export function readJsonPath(value: unknown, path: string): unknown {
  return path.split(".").reduce((current: any, key) => current != null && typeof current === "object" && Object.hasOwn(current, key) ? current[key] : undefined, value);
}

export const ipSwitchReasonLabels: Record<string, string> = {
  ok: "请求完成", invalid_request: "接口配置不合法", expired: "任务已过期", duplicate: "Agent 已处理过此任务",
  state_unavailable: "Agent 无法保存防重复标记", claim_denied: "执行前配置或主机状态已变化",
  request_failed: "商家接口连接失败或超时", http_status: "商家接口返回非 2xx 状态",
  invalid_response: "商家返回的内容不是有效 JSON", success_mismatch: "商家返回值与成功条件不匹配",
  invalid_ip: "商家返回的新 IP 无效", agent_unavailable: "Agent 暂不可用",
};
export const ipSwitchBlockedLabels: Record<string, string> = {
  agent_unavailable: "等待 Agent 上报换 IP 能力", unresolved: "等待核对上次商家结果",
  daily_limit: "已达 24h 请求上限", cooldown: "商家请求间隔中",
};
