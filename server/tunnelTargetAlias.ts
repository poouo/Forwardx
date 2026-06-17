import { hostIngressAddress } from "./hostAddressRuntime";

const TUNNEL_EXIT_TARGET_ALIASES = new Set([
  "forwardx_exit_host",
  "forwardx-exit-host",
  "exit_host",
  "exit-host",
]);

export function isTunnelExitTargetAlias(value: unknown) {
  const text = String(value || "").trim().toLowerCase();
  return TUNNEL_EXIT_TARGET_ALIASES.has(text);
}

export function tunnelExitTargetAddress(hostLike: any) {
  return hostIngressAddress(hostLike);
}

