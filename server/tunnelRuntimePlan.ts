export type TunnelRuntimeFamily = "forwardx" | "gost" | "nginx";
export type TunnelRuntimeForwardType = "forwardx-tunnel" | "gost-tunnel" | "nginx-tunnel-exit";
export type TunnelRuleRuntimeForwardType = "forwardx" | "gost" | "nginx-tunnel";

export type GostTunnelProbeListener = {
  tunnelId: number;
  mode: string;
  listenPort: number;
  name: string;
};

type GostTunnelProbeInput = {
  id?: unknown;
  mode?: unknown;
  isEnabled?: unknown;
  protocolEnabled?: unknown;
  exitHostId?: unknown;
  listenPort?: unknown;
  loadBalanceEnabled?: unknown;
};

type GostTunnelProbeExitInput = {
  id?: unknown;
  seq?: unknown;
  hostId?: unknown;
  listenPort?: unknown;
  isEnabled?: unknown;
};

export function tunnelRuntimeFamily(tunnel: any): TunnelRuntimeFamily {
  const mode = String(tunnel?.mode || "").trim().toLowerCase();
  if (mode === "forwardx") return "forwardx";
  if (mode === "nginx_stream" || mode === "nginx_tls") return "nginx";
  return "gost";
}

export function tunnelExitRuntimeForwardType(tunnel: any): TunnelRuntimeForwardType {
  const family = tunnelRuntimeFamily(tunnel);
  if (family === "forwardx") return "forwardx-tunnel";
  if (family === "nginx") return "nginx-tunnel-exit";
  return "gost-tunnel";
}

export function tunnelHopRuntimeForwardType(tunnel: any): Exclude<TunnelRuntimeForwardType, "nginx-tunnel-exit"> | null {
  const family = tunnelRuntimeFamily(tunnel);
  if (family === "nginx") return null;
  return family === "forwardx" ? "forwardx-tunnel" : "gost-tunnel";
}

export function tunnelRuleRuntimeForwardType(tunnel: any): TunnelRuleRuntimeForwardType {
  const family = tunnelRuntimeFamily(tunnel);
  if (family === "forwardx") return "forwardx";
  if (family === "nginx") return "nginx-tunnel";
  return "gost";
}

export function planGostTunnelProbeListeners(
  hostIdValue: unknown,
  tunnels: readonly GostTunnelProbeInput[],
  exitNodesByTunnelId: ReadonlyMap<number, readonly GostTunnelProbeExitInput[]>,
  businessListenKeys: ReadonlySet<string>,
): GostTunnelProbeListener[] {
  const hostId = Number(hostIdValue);
  if (!Number.isFinite(hostId) || hostId <= 0) return [];

  const listeners: GostTunnelProbeListener[] = [];
  const plannedKeys = new Set<string>();
  const addListener = (tunnel: GostTunnelProbeInput, listenPortValue: unknown, name: string) => {
    const tunnelId = Number(tunnel.id);
    const listenPort = Number(listenPortValue);
    if (!Number.isFinite(tunnelId) || tunnelId <= 0 || !Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65535) return;
    const listenKey = `${hostId}:${listenPort}`;
    if (businessListenKeys.has(listenKey) || plannedKeys.has(listenKey)) return;
    plannedKeys.add(listenKey);
    listeners.push({
      tunnelId,
      mode: String(tunnel.mode || "tls").trim().toLowerCase() || "tls",
      listenPort,
      name,
    });
  };

  for (const tunnel of tunnels || []) {
    const tunnelEnabled = tunnel?.isEnabled === true || Number(tunnel?.isEnabled) === 1;
    const protocolEnabled = tunnel?.protocolEnabled === true || Number(tunnel?.protocolEnabled) === 1;
    if (!tunnel || !tunnelEnabled || !protocolEnabled || tunnelRuntimeFamily(tunnel) !== "gost") continue;
    const tunnelId = Number(tunnel.id);
    if (!Number.isFinite(tunnelId) || tunnelId <= 0) continue;
    if (Number(tunnel.exitHostId) === hostId) {
      addListener(tunnel, tunnel.listenPort, `fwx-tunnel-probe-${tunnelId}`);
    }
    if (tunnel.loadBalanceEnabled !== true && Number(tunnel.loadBalanceEnabled) !== 1) continue;
    for (const exitNode of exitNodesByTunnelId.get(tunnelId) || []) {
      if (!exitNode || exitNode.isEnabled === false || Number(exitNode.isEnabled) === 0 || Number(exitNode.hostId) !== hostId) continue;
      const listenPort = Number(exitNode.listenPort);
      const exitKey = Number(exitNode.id) || Number(exitNode.seq) || listenPort;
      addListener(tunnel, listenPort, `fwx-tunnel-probe-${tunnelId}-exit-${exitKey}`);
    }
  }
  return listeners;
}

export type SharedRuntimeReconcileInput = {
  configChanged: boolean;
  serviceUnhealthy: boolean;
  bootstrap: boolean;
  desiredRelevant: boolean;
  reportedHasWork: boolean;
};

function shouldReconcileSharedRuntime(input: SharedRuntimeReconcileInput) {
  return input.configChanged
    || input.serviceUnhealthy
    || input.bootstrap
    || input.desiredRelevant
    || input.reportedHasWork;
}

export function shouldReconcileNginxRuntime(input: SharedRuntimeReconcileInput) {
  return shouldReconcileSharedRuntime(input);
}

export function shouldReconcileGostRuntime(input: SharedRuntimeReconcileInput) {
  return shouldReconcileSharedRuntime(input);
}
