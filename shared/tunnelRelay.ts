export const TUNNEL_RELAY_MODES = ["chain", "failover"] as const;

export type TunnelRelayMode = (typeof TUNNEL_RELAY_MODES)[number];

export const AGENT_FORWARDX_RELAY_FAILOVER_VERSION = "2.2.160";

export function normalizeTunnelRelayMode(value: unknown): TunnelRelayMode {
  return String(value || "").trim().toLowerCase() === "failover" ? "failover" : "chain";
}

export function tunnelRelayFailoverSupported(mode: unknown) {
  const normalized = String(mode || "").trim().toLowerCase();
  return normalized === "forwardx" || ["tls", "wss", "tcp", "mtls", "mwss", "mtcp"].includes(normalized);
}

export function tunnelRelayCandidates<T>(hops: T[]) {
  return Array.isArray(hops) && hops.length >= 3 ? hops.slice(1, -1) : [];
}

export function isTunnelRelayFailover(tunnel: any, hops: any[]) {
  return normalizeTunnelRelayMode(tunnel?.relayMode) === "failover"
    && tunnelRelayFailoverSupported(tunnel?.mode)
    && tunnelRelayCandidates(hops).length >= 2;
}
