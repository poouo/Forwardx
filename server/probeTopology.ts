import { createHash } from "node:crypto";

function text(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function digest(prefix: string, parts: unknown[]) {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24)}`;
}

export function tunnelProbeTopologyKey(tunnel: any, hops: any[] = [], exitNodes: any[] = []) {
  const hopParts = [...(hops || [])]
    .sort((a, b) => Number(a?.seq || 0) - Number(b?.seq || 0))
    .map((hop) => [
      Number(hop?.seq || 0),
      Number(hop?.hostId || 0),
      Number(hop?.listenPort || 0),
      Number(hop?.mimicPort || 0),
      text(hop?.connectHost),
      hop?.isEnabled !== false,
    ]);
  const exitParts = [...(exitNodes || [])]
    .filter((node) => node?.isEnabled !== false)
    .sort((a, b) => Number(a?.seq || 0) - Number(b?.seq || 0))
    .map((node) => [
      Number(node?.seq || 0),
      Number(node?.hostId || 0),
      Number(node?.listenPort || 0),
      Number(node?.mimicPort || 0),
      text(node?.connectHost),
    ]);
  return digest(`tunnel:${Number(tunnel?.id || 0)}`, [
    tunnel?.isEnabled !== false,
    text(tunnel?.mode),
    text(tunnel?.forwardxVersion),
    Number(tunnel?.entryHostId || 0),
    Number(tunnel?.exitHostId || 0),
    Number(tunnel?.entryGroupId || 0),
    Number(tunnel?.exitGroupId || 0),
    Number(tunnel?.listenPort || 0),
    Number(tunnel?.mimicPort || 0),
    !!tunnel?.loadBalanceEnabled,
    hopParts,
    exitParts,
  ]);
}

export function forwardGroupProbeTopologyKey(groupId: number, probes: any[] = []) {
  const probeParts = [...(probes || [])]
    .sort((a, b) => (
      Number(a?.hopIndex || 0) - Number(b?.hopIndex || 0)
      || Number(a?.fromHostId || 0) - Number(b?.fromHostId || 0)
    ))
    .map((probe) => [
      Number(probe?.fromHostId || 0),
      Number(probe?.hopIndex || 0),
      Number(probe?.hopCount || 0),
      text(probe?.targetIp),
      Number(probe?.targetPort || 0),
      text(probe?.method),
    ]);
  return digest(`forward-group:${Number(groupId || 0)}`, probeParts);
}
