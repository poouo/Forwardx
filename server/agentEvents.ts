import type { Response } from "express";
import { AGENT_VERSION } from "./_core/systemRouter";
import { encryptPayload } from "./agentCrypto";
import { invalidateAgentStableHeartbeatPlan } from "./agentHeartbeatGate";
import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";

const VERBOSE_AGENT_EVENTS = /^(1|true|yes|on)$/i.test(String(process.env.FORWARDX_VERBOSE_AGENT_EVENTS || ""));

type AgentEventClient = {
  hostId: number;
  token: string;
  res: Response;
  closed: boolean;
  backpressured: boolean;
  pendingFrames: string[];
  pendingBytes: number;
  drainTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  closeListeners: Set<() => void>;
  onDrain: () => void;
  onResponseClose: () => void;
  onResponseError: () => void;
};

export type AgentEventStreamHandle = {
  writeEvent: (event: string, data: any) => boolean;
  writeComment: (comment?: string) => boolean;
  close: () => void;
  onClose: (listener: () => void) => () => void;
};

type AgentEventStreamOptions = {
  heartbeatIntervalMs?: number;
};

type AgentRefreshOptions = {
  urgent?: boolean;
  forceMimicCheck?: boolean;
};

const agentEventClients = new Map<number, AgentEventClient>();
const hostMetricsWatchUntil = new Map<number, number>();
const hostTcpingRequestUntil = new Map<number, number>();
const hostRefreshPushedAt = new Map<number, number>();
const agentEventLogAt = new Map<string, number>();
const AGENT_REFRESH_COALESCE_MS = 1500;
const AGENT_EVENT_LOG_INTERVAL_MS = 5 * 60 * 1000;
const AGENT_EVENT_LOG_CACHE_MAX = 4096;
const AGENT_EVENT_CACHE_RETENTION_MS = 60 * 60 * 1000;

// ServerResponse starts applying backpressure at a small socket high-water mark.
// Keep a modest, explicit queue while waiting for `drain`; reconnecting the Agent
// is safer than allowing a dead connection to retain an unbounded desired state.
const AGENT_EVENT_MAX_PENDING_FRAMES = 16;
const AGENT_EVENT_MAX_PENDING_BYTES = 1024 * 1024;
const AGENT_EVENT_DRAIN_TIMEOUT_MS = 30_000;

function shouldLogAgentEventIssue(key: string, intervalMs = AGENT_EVENT_LOG_INTERVAL_MS) {
  const now = Date.now();
  const lastAt = agentEventLogAt.get(key) || 0;
  if (now - lastAt < intervalMs) return false;
  setBoundedMapValue(agentEventLogAt, key, now, AGENT_EVENT_LOG_CACHE_MAX);
  return true;
}

function logAgentEventIssue(hostId: number, event: string, reason: string) {
  if (!shouldLogAgentEventIssue(`${hostId}:${event}:${reason}`)) return;
  console.warn(`[AgentEvent] host=${hostId} event=${event} delivery issue reason=${reason}`);
}

function pruneAgentEventCaches(now = Date.now()) {
  pruneMapEntries(hostRefreshPushedAt, (lastAt) => now - lastAt >= AGENT_EVENT_CACHE_RETENTION_MS);
  pruneMapEntries(hostMetricsWatchUntil, (until) => until <= now);
  pruneMapEntries(hostTcpingRequestUntil, (until) => until <= now);
  pruneMapEntries(agentEventLogAt, (lastAt) => now - lastAt >= AGENT_EVENT_CACHE_RETENTION_MS);
}

const agentEventCacheCleanupTimer = setInterval(() => pruneAgentEventCaches(), 10 * 60 * 1000);
agentEventCacheCleanupTimer.unref?.();

function responseUnavailable(res: Response) {
  const state = res as Response & {
    destroyed?: boolean;
    writableEnded?: boolean;
    writableFinished?: boolean;
  };
  return state.destroyed === true || state.writableEnded === true || state.writableFinished === true;
}

function removeResponseListener(res: Response, event: string, listener: (...args: any[]) => void) {
  const target = res as Response & { off?: (event: string, listener: (...args: any[]) => void) => void };
  target.off?.(event, listener);
}

function closeAgentEventClient(
  client: AgentEventClient,
  terminateResponse: "none" | "end" | "destroy" = "none",
) {
  if (client.closed) return;
  client.closed = true;
  client.backpressured = false;
  client.pendingFrames.length = 0;
  client.pendingBytes = 0;
  if (client.drainTimer) clearTimeout(client.drainTimer);
  if (client.heartbeatTimer) clearInterval(client.heartbeatTimer);
  client.drainTimer = null;
  client.heartbeatTimer = null;
  removeResponseListener(client.res, "drain", client.onDrain);
  removeResponseListener(client.res, "close", client.onResponseClose);
  removeResponseListener(client.res, "finish", client.onResponseClose);
  removeResponseListener(client.res, "error", client.onResponseError);
  if (agentEventClients.get(client.hostId) === client) {
    agentEventClients.delete(client.hostId);
  }
  for (const listener of client.closeListeners) {
    try {
      listener();
    } catch {
      // A lifecycle observer must not prevent the connection from being released.
    }
  }
  client.closeListeners.clear();

  if (terminateResponse === "none" || responseUnavailable(client.res)) return;
  try {
    if (terminateResponse === "destroy" && typeof (client.res as any).destroy === "function") {
      (client.res as any).destroy();
    } else {
      client.res.end();
    }
  } catch {
    // The socket may already have disappeared between the state check and close.
  }
}

function armDrainTimeout(client: AgentEventClient) {
  if (client.drainTimer || client.closed) return;
  client.drainTimer = setTimeout(() => {
    client.drainTimer = null;
    if (client.closed || !client.backpressured) return;
    logAgentEventIssue(client.hostId, "stream", "drain-timeout");
    closeAgentEventClient(client, "destroy");
  }, AGENT_EVENT_DRAIN_TIMEOUT_MS);
  client.drainTimer.unref?.();
}

function writeFrameNow(client: AgentEventClient, frame: string) {
  if (client.closed || responseUnavailable(client.res)) {
    closeAgentEventClient(client);
    return false;
  }
  try {
    if (client.res.write(frame) === false) {
      client.backpressured = true;
      const response = client.res as Response & { once?: (event: string, listener: () => void) => void };
      if (typeof response.once !== "function") {
        closeAgentEventClient(client, "destroy");
        return false;
      }
      response.once("drain", client.onDrain);
      armDrainTimeout(client);
    }
    return !client.closed;
  } catch {
    closeAgentEventClient(client, "destroy");
    return false;
  }
}

function flushPendingFrames(client: AgentEventClient) {
  while (!client.closed && !client.backpressured && client.pendingFrames.length > 0) {
    const frame = client.pendingFrames.shift()!;
    client.pendingBytes = Math.max(0, client.pendingBytes - Buffer.byteLength(frame));
    if (!writeFrameNow(client, frame)) return;
  }
}

function writeAgentEventFrame(client: AgentEventClient, frame: string, queueWhenBackpressured = true) {
  if (client.closed || responseUnavailable(client.res)) {
    closeAgentEventClient(client);
    return false;
  }
  if (!client.backpressured) return writeFrameNow(client, frame);

  // Heartbeat comments carry no state and should never consume backlog space.
  if (!queueWhenBackpressured) return true;

  const frameBytes = Buffer.byteLength(frame);
  if (
    client.pendingFrames.length >= AGENT_EVENT_MAX_PENDING_FRAMES
    || client.pendingBytes + frameBytes > AGENT_EVENT_MAX_PENDING_BYTES
  ) {
    logAgentEventIssue(client.hostId, "stream", "backlog-exceeded");
    closeAgentEventClient(client, "destroy");
    return false;
  }
  client.pendingFrames.push(frame);
  client.pendingBytes += frameBytes;
  return true;
}

function encryptedEventFrame(event: string, data: any, token: string) {
  return `event: message\ndata: ${JSON.stringify(encryptPayload({ type: event, data }, token))}\n\n`;
}

export function registerAgentEventClient(
  hostId: number,
  token: string,
  res: Response,
  options: AgentEventStreamOptions = {},
): AgentEventStreamHandle {
  const previous = agentEventClients.get(hostId);
  if (previous) closeAgentEventClient(previous, previous.backpressured ? "destroy" : "end");

  let client!: AgentEventClient;
  const onDrain = () => {
    if (client.closed) return;
    client.backpressured = false;
    if (client.drainTimer) clearTimeout(client.drainTimer);
    client.drainTimer = null;
    flushPendingFrames(client);
  };
  const onResponseClose = () => closeAgentEventClient(client);
  const onResponseError = () => closeAgentEventClient(client, "destroy");
  client = {
    hostId,
    token,
    res,
    closed: false,
    backpressured: false,
    pendingFrames: [],
    pendingBytes: 0,
    drainTimer: null,
    heartbeatTimer: null,
    closeListeners: new Set(),
    onDrain,
    onResponseClose,
    onResponseError,
  };
  agentEventClients.set(hostId, client);

  const response = res as Response & {
    once?: (event: string, listener: (...args: any[]) => void) => void;
  };
  response.once?.("close", onResponseClose);
  response.once?.("finish", onResponseClose);
  response.once?.("error", onResponseError);

  const heartbeatIntervalMs = Number(options.heartbeatIntervalMs || 0);
  if (Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0) {
    client.heartbeatTimer = setInterval(() => {
      writeAgentEventFrame(client, ": ping\n\n", false);
    }, heartbeatIntervalMs);
    client.heartbeatTimer.unref?.();
  }

  return {
    writeEvent(event, data) {
      return writeAgentEventFrame(client, encryptedEventFrame(event, data, token));
    },
    writeComment(comment = "ping") {
      const normalized = String(comment).replace(/[\r\n]+/g, " ");
      return writeAgentEventFrame(client, `: ${normalized}\n\n`, false);
    },
    close() {
      closeAgentEventClient(client);
    },
    onClose(listener) {
      if (client.closed) {
        listener();
        return () => undefined;
      }
      client.closeListeners.add(listener);
      return () => client.closeListeners.delete(listener);
    },
  };
}

export function unregisterAgentEventClient(hostId: number, res: Response) {
  const current = agentEventClients.get(hostId);
  if (current?.res === res) {
    closeAgentEventClient(current);
  }
}

function sendAgentEvent(hostId: number, event: string, data: any) {
  const client = agentEventClients.get(hostId);
  if (!client) {
    const important = event === "agent-upgrade"
      || event === "agent-panel-migration"
      || event === "agent-support-bundle"
      || (event === "agent-desired-state" && !!data?.desiredState);
    if (important) {
      logAgentEventIssue(hostId, event, "no-active-stream");
    } else if (event !== "agent-refresh" && VERBOSE_AGENT_EVENTS) {
      console.warn(`[AgentEvent] host=${hostId} event=${event} no active event stream`);
    }
    return false;
  }
  if (!writeAgentEventFrame(client, encryptedEventFrame(event, data, client.token))) {
    return false;
  }
  const logPush = event === "agent-upgrade"
    || event === "agent-panel-migration"
    || event === "agent-support-bundle"
    || (event === "agent-desired-state" && VERBOSE_AGENT_EVENTS);
  if (logPush) {
    console.info(`[AgentEvent] host=${hostId} event=${event} pushed`);
  }
  return true;
}

export function pushAgentRefresh(hostId: number, reason: string, options: AgentRefreshOptions = {}) {
  const id = Number(hostId);
  invalidateAgentStableHeartbeatPlan(id);
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
  return sendAgentEvent(hostId, "agent-refresh", {
    reason,
    ts: Date.now(),
    urgent,
    forceMimicCheck: options.forceMimicCheck === true,
  });
}

export function pushAgentUpgrade(hostId: number, targetVersion: string | null, panelUrl: string, releaseVersion?: string | null) {
  invalidateAgentStableHeartbeatPlan(hostId);
  return sendAgentEvent(hostId, "agent-upgrade", {
    targetVersion: targetVersion || AGENT_VERSION,
    panelUrl,
    releaseVersion: releaseVersion || null,
  });
}

export function pushAgentPanelMigration(
  hostId: number,
  data: {
    id: string;
    state: "preparing" | "committing" | "committed" | "aborted";
    targetPanelUrl?: string;
    fallbackPanelUrl?: string;
    startedAt?: number;
  },
) {
  invalidateAgentStableHeartbeatPlan(hostId);
  return sendAgentEvent(hostId, "agent-panel-migration", data);
}

export function pushAgentSupportBundle(hostId: number, taskId: string) {
  return sendAgentEvent(hostId, "agent-support-bundle", { taskId, requestedAt: new Date().toISOString() });
}

export function markHostMetricsWatching(hostIds: number[], ttlMs = 6000, now = Date.now()) {
  const newlyWatched: number[] = [];
  const until = now + ttlMs;
  for (const id of hostIds) {
    if (Number.isFinite(id) && id > 0) {
      if ((hostMetricsWatchUntil.get(id) || 0) <= now) newlyWatched.push(id);
      hostMetricsWatchUntil.set(id, until);
    }
  }
  return newlyWatched;
}

export function isHostMetricsWatching(hostId: number, now = Date.now()) {
  const until = hostMetricsWatchUntil.get(hostId) || 0;
  if (until <= now) {
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
    ruleLatencyProbes?: unknown[];
    stateSignatures?: Record<string, string>;
  }
) {
  const id = Number(hostId);
  if (!Number.isFinite(id) || id <= 0) return false;
  return sendAgentEvent(id, "agent-desired-state", payload);
}
