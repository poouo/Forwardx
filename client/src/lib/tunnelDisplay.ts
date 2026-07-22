import { normalizeExitGroupStrategy } from "@shared/exitStrategy";

export function tunnelEndpointName(tunnel: any | null | undefined, role: "entry" | "exit", hosts: any[] | undefined) {
  const hostId = Number(role === "entry" ? tunnel?.entryHostId : tunnel?.exitHostId);
  const fromList = hosts?.find((host: any) => Number(host.id) === hostId);
  const fromTunnel = role === "entry" ? tunnel?.entryHost : tunnel?.exitHost;
  return fromList?.name || fromTunnel?.name || `主机 #${hostId}`;
}

export function tunnelHopHostName(tunnel: any | null | undefined, hostId: number, hosts: any[] | undefined) {
  const id = Number(hostId);
  const fromList = hosts?.find((host: any) => Number(host.id) === id);
  const fromTunnel = Array.isArray(tunnel?.hopHosts)
    ? tunnel.hopHosts.find((host: any) => Number(host?.id) === id)
    : null;
  if (fromList?.name || fromTunnel?.name) return fromList?.name || fromTunnel?.name;
  if (Number(tunnel?.entryHostId) === id) return tunnelEndpointName(tunnel, "entry", hosts);
  if (Number(tunnel?.exitHostId) === id) return tunnelEndpointName(tunnel, "exit", hosts);
  return `主机 #${id}`;
}

export function getTunnelLoadBalanceExitNames(tunnel: any | null | undefined, hosts: any[] | undefined) {
  if (normalizeExitGroupStrategy(tunnel?.loadBalanceStrategy) === "none") return [];
  if (!Array.isArray(tunnel?.loadBalanceExits)) return [];
  const names = tunnel.loadBalanceExits
    .map((exit: any) => Number(exit?.hostId || 0))
    .filter((hostId: number) => hostId > 0)
    .map((hostId: number) => tunnelHopHostName(tunnel, hostId, hosts))
    .map((name: string) => String(name || "").trim())
    .filter(Boolean);
  return Array.from(new Set(names));
}

export function getTunnelExitNames(tunnel: any | null | undefined, hosts: any[] | undefined) {
  const primaryExitId = Number(tunnel?.exitHostId || 0);
  const primaryName = primaryExitId > 0 ? tunnelHopHostName(tunnel, primaryExitId, hosts) : "";
  const names = [
    String(primaryName || "").trim(),
    ...getTunnelLoadBalanceExitNames(tunnel, hosts),
  ].filter(Boolean);
  return Array.from(new Set(names));
}

export function getTunnelHopIds(tunnel: any | null | undefined) {
  const hopIds = Array.isArray(tunnel?.hopHostIds)
    ? tunnel.hopHostIds.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
    : [];
  if (hopIds.length >= 2) return hopIds;
  return [Number(tunnel?.entryHostId || 0), Number(tunnel?.exitHostId || 0)].filter((id) => id > 0);
}

export function getTunnelRouteText(
  tunnel: any | null | undefined,
  hosts: any[] | undefined,
  exitGroupName?: string | null,
) {
  const hopNames = getTunnelHopIds(tunnel)
    .map((hostId: number) => tunnelHopHostName(tunnel, hostId, hosts))
    .map((name: string) => String(name || "").trim())
    .filter(Boolean);
  if (hopNames.length === 0) return "-";
  const normalizedExitGroupName = String(exitGroupName || "").trim();
  if (normalizedExitGroupName) {
    hopNames[hopNames.length - 1] = normalizedExitGroupName;
    const exitNames = getTunnelExitNames(tunnel, hosts);
    const routeText = String(tunnel?.relayMode || "").toLowerCase() === "failover" && hopNames.length >= 4
      ? `${hopNames[0]} -> 中转：${hopNames.slice(1, -1).join(" / ")} -> ${hopNames[hopNames.length - 1]}`
      : hopNames.join(" -> ");
    return `${routeText}${exitNames.length > 0 ? `\uFF1B\u51FA\u53E3\uFF1A${exitNames.join(" / ")}` : ""}`;
  }
  const routeText = String(tunnel?.relayMode || "").toLowerCase() === "failover" && hopNames.length >= 4
    ? `${hopNames[0]} -> 中转：${hopNames.slice(1, -1).join(" / ")} -> ${hopNames[hopNames.length - 1]}`
    : hopNames.join(" -> ");
  const extraExitNames = getTunnelLoadBalanceExitNames(tunnel, hosts)
    .filter((name) => !hopNames.includes(name));
  if (extraExitNames.length > 0) {
    return `${routeText}；出口：${getTunnelExitNames(tunnel, hosts).join(" / ")}`;
  }
  return routeText;
}

export function tunnelTestIndicatesTimeout(input: {
  status?: unknown;
  details?: Array<{ success?: unknown; pending?: unknown; message?: unknown; latencyMs?: unknown }>;
  latestLatencyIsTimeout?: unknown;
}) {
  const status = String(input.status || "").toLowerCase();
  if (status === "success") return false;
  if (status === "failed") return true;
  if (status === "pending" || status === "running") return false;

  const details = (input.details || []).filter((detail) => (
    detail.pending
    || detail.success
    || detail.message
    || (typeof detail.latencyMs === "number" && Number.isFinite(detail.latencyMs))
  ));
  if (details.some((detail) => detail.pending)) return false;
  if (details.length > 0) return !details.some((detail) => detail.success === true);
  return input.latestLatencyIsTimeout === true;
}
