import {
  LINK_PROBE_FRESH_MS,
  LINK_PROBE_MAX_FUTURE_SKEW_MS,
} from "@shared/linkProbePolicy";

export type ForwardRuleVisualState = "disabled" | "running" | "pending" | "error";

export type ForwardGroupConfigStatus = "available" | "pending" | "unavailable" | "error" | "disabled";

export type ForwardRuleVisualStatus = {
  state: ForwardRuleVisualState;
  title: string;
};

function timestampMillis(value: unknown) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const timestamp = new Date(String(value || "")).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function resolveForwardRuleVisualStatus(input: {
  ruleEnabled: boolean;
  ruleRunning?: boolean;
  resourceAccessAllowed?: boolean;
  groupEnabled: boolean;
  groupConfigStatus: ForwardGroupConfigStatus;
  runtimeStatus?: string | null;
  runningCount?: number;
  expectedCount?: number;
  latestLatencyMs?: number | null;
  latestLatencyIsTimeout?: boolean;
  latestLatencyAt?: Date | string | number | null;
}, now = Date.now()): ForwardRuleVisualStatus {
  if (input.resourceAccessAllowed === false) {
    return { state: "error", title: "资源授权失效" };
  }
  if (!input.ruleEnabled || !input.groupEnabled || input.groupConfigStatus === "disabled") {
    return { state: "disabled", title: "规则已停用" };
  }

  const runtimeStatus = String(input.runtimeStatus || "").toLowerCase();
  if (runtimeStatus === "disabled") {
    return { state: "disabled", title: "托管规则已停用" };
  }
  const probeAt = timestampMillis(input.latestLatencyAt);
  const probeIsRecent = probeAt > 0
    && probeAt <= now + LINK_PROBE_MAX_FUTURE_SKEW_MS
    && now - probeAt <= LINK_PROBE_FRESH_MS;
  if (probeIsRecent && input.latestLatencyIsTimeout) {
    return { state: "error", title: "最近一次端到端探测超时" };
  }
  if (input.groupConfigStatus === "error" || input.groupConfigStatus === "unavailable") {
    return { state: "error", title: "转发资源配置不可用" };
  }
  const hasLatency = input.latestLatencyMs !== null && input.latestLatencyMs !== undefined;
  const latencyMs = Number(input.latestLatencyMs);
  if (probeIsRecent && hasLatency && !input.latestLatencyIsTimeout && Number.isFinite(latencyMs) && latencyMs >= 0) {
    return { state: "running", title: `最近一次端到端探测可达（${Math.round(latencyMs)}ms）` };
  }

  const running = Math.max(0, Number(input.runningCount) || 0);
  const expected = Math.max(0, Number(input.expectedCount) || 0);
  if (runtimeStatus === "running") {
    return { state: "running", title: `全部 ${running || expected} 个托管监听均已确认运行` };
  }
  if (runtimeStatus === "degraded") {
    return { state: "pending", title: `已有 ${running} / ${expected} 个托管监听确认运行，其余状态待确认` };
  }
  if (runtimeStatus === "pending") {
    return { state: "pending", title: `等待 Agent 确认托管监听（${running} / ${expected}）` };
  }
  if (input.groupConfigStatus === "pending") {
    return { state: "pending", title: "等待转发资源完成检测" };
  }
  if (input.ruleRunning) return { state: "running", title: "Agent 已确认规则运行" };
  if (input.groupConfigStatus === "available") {
    return { state: "pending", title: "转发资源可用，等待 Agent 确认规则监听" };
  }
  return { state: "pending", title: "等待 Agent 上报运行状态" };
}
