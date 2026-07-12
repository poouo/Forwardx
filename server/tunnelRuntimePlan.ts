export type TunnelRuntimeFamily = "forwardx" | "gost" | "nginx";
export type TunnelRuntimeForwardType = "forwardx-tunnel" | "gost-tunnel" | "nginx-tunnel-exit";
export type TunnelRuleRuntimeForwardType = "forwardx" | "gost" | "nginx-tunnel";

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
