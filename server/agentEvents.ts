import type { Response } from "express";
import { AGENT_VERSION } from "./_core/systemRouter";
import { encryptPayload } from "./agentCrypto";

type AgentEventClient = {
  hostId: number;
  token: string;
  res: Response;
};

const agentEventClients = new Map<number, AgentEventClient>();
const hostMetricsWatchUntil = new Map<number, number>();
const hostTcpingRequestUntil = new Map<number, number>();

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
    console.warn(`[AgentEvent] host=${hostId} event=${event} no active event stream`);
    return false;
  }
  client.res.write(`event: message\n`);
  client.res.write(`data: ${JSON.stringify(encryptPayload({ type: event, data }, client.token))}\n\n`);
  console.info(`[AgentEvent] host=${hostId} event=${event} pushed`);
  return true;
}

export function pushAgentRefresh(hostId: number, reason: string) {
  return sendAgentEvent(hostId, "agent-refresh", { reason, ts: Date.now() });
}

export function pushAgentUpgrade(hostId: number, targetVersion: string | null, panelUrl: string) {
  return sendAgentEvent(hostId, "agent-upgrade", {
    targetVersion: targetVersion || AGENT_VERSION,
    panelUrl,
  });
}

export function markHostMetricsWatching(hostIds: number[], ttlMs = 6000) {
  const until = Date.now() + ttlMs;
  for (const id of hostIds) {
    if (Number.isFinite(id) && id > 0) {
      hostMetricsWatchUntil.set(id, until);
    }
  }
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
