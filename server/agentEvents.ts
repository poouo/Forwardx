import type { Response } from "express";
import { AGENT_VERSION } from "./_core/systemRouter";
import { encryptPayload } from "./agentCrypto";

const VERBOSE_AGENT_EVENTS = /^(1|true|yes|on)$/i.test(String(process.env.FORWARDX_VERBOSE_AGENT_EVENTS || ""));

type AgentEventClient = {
  hostId: number;
  token: string;
  res: Response;
};

type AgentRefreshOptions = {
  urgent?: boolean;
};

const agentEventClients = new Map<number, AgentEventClient>();
const hostMetricsWatchUntil = new Map<number, number>();
const hostTcpingRequestUntil = new Map<number, number>();
const hostRefreshPushedAt = new Map<number, number>();
const AGENT_REFRESH_COALESCE_MS = 1500;

export function registerAgentEventClient(hostId: number, token: string, res: Response) {
  const previous = agentEventClients.get(hostId);
  previous?.res.end();
  agentEventClients.set(hostId, { hostId, token, res });
}

export function unregisterAgentEventClient(hostId: number, res: Response) {
  const current = agentEventClients.get(hostId);
  if (current?.res === res) {
    agentEventClients.delete(hostId);
  }
}

function sendAgentEvent(hostId: number, event: string, data: any) {
  const client = agentEventClients.get(hostId);
  if (!client) {
    if (event !== "agent-refresh" && VERBOSE_AGENT_EVENTS) {
      console.warn(`[AgentEvent] host=${hostId} event=${event} no active event stream`);
    }
    return false;
  }
  client.res.write(`event: message\n`);
  client.res.write(`data: ${JSON.stringify(encryptPayload({ type: event, data }, client.token))}\n\n`);
  if (event !== "agent-refresh" || VERBOSE_AGENT_EVENTS) {
    console.info(`[AgentEvent] host=${hostId} event=${event} pushed`);
  }
  return true;
}

export function pushAgentRefresh(hostId: number, reason: string, options: AgentRefreshOptions = {}) {
  const id = Number(hostId);
  const now = Date.now();
  const urgent = options.urgent === true;
  const last = hostRefreshPushedAt.get(id) || 0;
  if (!urgent && now - last < AGENT_REFRESH_COALESCE_MS) {
    if (VERBOSE_AGENT_EVENTS) {
      console.info(`[AgentEvent] host=${id} event=agent-refresh coalesced reason=${reason}`);
    }
    return true;
  }
  hostRefreshPushedAt.set(id, now);
  return sendAgentEvent(hostId, "agent-refresh", { reason, ts: Date.now(), urgent });
}

export function pushAgentUpgrade(hostId: number, targetVersion: string | null, panelUrl: string, releaseVersion?: string | null) {
  return sendAgentEvent(hostId, "agent-upgrade", {
    targetVersion: targetVersion || AGENT_VERSION,
    panelUrl,
    releaseVersion: releaseVersion || null,
  });
}

export function markHostMetricsWatching(hostIds: number[], ttlMs = 6000) {
  const newlyWatched: number[] = [];
  const now = Date.now();
  const until = Date.now() + ttlMs;
  for (const id of hostIds) {
    if (Number.isFinite(id) && id > 0) {
      if ((hostMetricsWatchUntil.get(id) || 0) <= now) newlyWatched.push(id);
      hostMetricsWatchUntil.set(id, until);
    }
  }
  return newlyWatched;
}

export function isHostMetricsWatching(hostId: number) {
  const until = hostMetricsWatchUntil.get(hostId) || 0;
  if (until <= Date.now()) {
    hostMetricsWatchUntil.delete(hostId);
    return false;
  }
  return true;
}

export function requestHostTcping(hostId: number, ttlMs = 60_000) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return false;
  hostTcpingRequestUntil.set(id, Date.now() + ttlMs);
  return true;
}

export function hasHostTcpingRequest(hostId: number) {
  const id = Number(hostId);
  const until = hostTcpingRequestUntil.get(id) || 0;
  if (until <= Date.now()) {
    hostTcpingRequestUntil.delete(id);
    return false;
  }
  return true;
}

export function clearHostTcpingRequest(hostId: number) {
  hostTcpingRequestUntil.delete(Number(hostId));
}

// pushAgentDesiredState 将 desiredState + runningRules 直接经 SSE 推送给 Agent，
// 使其无需等待下一个心跳周期即可立即执行转发规则变更。
// 与心跳 response 里的 desiredState 共享同一幂等性机制（签名 + desired_state_records.json），
// 两路同时触发也不会重复执行。
export function pushAgentDesiredState(
  hostId: number,
  payload: {
    desiredState?: unknown;
    runningRules?: unknown[];
    stateSignatures?: Record<string, string>;
  }
) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return false;
  return sendAgentEvent(id, "agent-desired-state", payload);
}
