export const AGENT_REVERSE_GOST_VERSION = "2.2.216";

export function isReverseTunnel(tunnel: { connectionDirection?: unknown } | null | undefined) {
  return tunnel?.connectionDirection === "reverse";
}

export function supportsReverseTunnel(mode: unknown, forwardxVersion: unknown) {
  return mode === "tls" || (mode === "forwardx" && forwardxVersion === "v2");
}
