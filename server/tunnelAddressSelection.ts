function normalizeAddress(value: unknown) {
  return String(value || "").trim();
}

export function defaultTunnelHostAddress(host: any) {
  return normalizeAddress(host?.entryIp || host?.ipv4 || host?.ipv6 || host?.ip);
}

function privateTunnelHostAddress(host: any) {
  return normalizeAddress(host?.tunnelEntryIp);
}

export function selectTunnelDialAddress(tunnel: any, exitHost: any) {
  const configured = normalizeAddress(tunnel?.connectHost);
  if (configured) return configured;
  if (String(tunnel?.networkType || "").toLowerCase() === "private") {
    const privateAddress = privateTunnelHostAddress(exitHost);
    if (privateAddress) return privateAddress;
  }
  return defaultTunnelHostAddress(exitHost);
}

export function selectTunnelHopDialAddress(hop: any, hopHost: any, tunnel?: any) {
  const configured = normalizeAddress(hop?.connectHost);
  if (configured) return configured;
  if (String(tunnel?.networkType || "").toLowerCase() === "private") {
    const privateAddress = privateTunnelHostAddress(hopHost);
    if (privateAddress) return privateAddress;
  }
  return defaultTunnelHostAddress(hopHost);
}

export function selectEntryGroupTunnelTestAddress(tunnel: any, nextHop: any, nextHost: any) {
  return nextHop
    ? selectTunnelHopDialAddress(nextHop, nextHost, tunnel) || selectTunnelDialAddress(tunnel, nextHost)
    : selectTunnelDialAddress(tunnel, nextHost);
}
