import { normalizeForwardXVersion } from "../shared/forwardTypes";

function validPort(value: unknown) {
  const port = Number(value || 0);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

export type ForwardXRuntimeTransportVersion = "v1" | "v2";

export function resolveLocalForwardXTransportVersion(input: {
  reportedTransportVersion?: unknown;
  tunnel?: any;
}): ForwardXRuntimeTransportVersion | undefined {
  const reported = String(input.reportedTransportVersion || "").trim().toLowerCase();
  if (reported === "v1" || reported === "v2") return reported;
  if (!input.tunnel) return undefined;
  const mode = String(input.tunnel?.mode || "").trim().toLowerCase();
  if (mode !== "forwardx") return undefined;
  return normalizeForwardXVersion(input.tunnel?.forwardxVersion) === "v2" ? "v2" : "v1";
}

export function resolveRuleTrafficPortForHost(input: {
  sourcePort: unknown;
  usesTunnelRuntime: boolean;
  isEntry: boolean;
  exitPorts?: unknown[];
}) {
  const sourcePort = validPort(input.sourcePort);
  if (!input.usesTunnelRuntime || input.isEntry) return sourcePort;
  for (const value of input.exitPorts || []) {
    const port = validPort(value);
    if (port > 0) return port;
  }
  return 0;
}
