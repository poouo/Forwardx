import { isReverseTunnel } from "../shared/tunnelDirection";
import { tunnelProbeTopologyKey } from "./probeTopology";

const observations = new Map<number, { topologyKey: string; everConnected: boolean; connected: boolean; at: number }>();
const maxAgeMs = 150_000;

export function reverseTunnelProbeKey(tunnel: any) {
  return `reverse:${tunnelProbeTopologyKey(tunnel)}`;
}

export function observeReverseTunnelConnection(tunnel: any, connected: boolean, now = Date.now()) {
  const tunnelId = Number(tunnel.id);
  const topologyKey = tunnelProbeTopologyKey(tunnel);
  const previous = observations.get(tunnelId);
  observations.set(tunnelId, {
    topologyKey,
    everConnected: connected || (previous?.topologyKey === topologyKey && previous.everConnected),
    connected,
    at: now,
  });
}

export function clearReverseTunnelConnection(tunnelId: number) {
  observations.delete(tunnelId);
}

export function getReverseTunnelConnectionStatus(tunnel: any, now = Date.now()) {
  if (!isReverseTunnel(tunnel) || !tunnel.isEnabled) return null;
  const observation = observations.get(Number(tunnel.id));
  if (!observation?.everConnected || observation.topologyKey !== tunnelProbeTopologyKey(tunnel)) return "waiting";
  return observation.connected && now - observation.at <= maxAgeMs ? "connected" : "reconnecting";
}
