import { normalizeForwardXVersion } from "../shared/forwardTypes";

function validPort(value: unknown) {
  const port = Number(value || 0);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

export type ForwardXRuntimeTransportVersion = "v1" | "v2" | "v3";

const REPORTED_FORWARDX_TRANSPORT_VERSIONS: ReadonlySet<string> = new Set(["v1", "v2", "v3"]);

/** Keeps a reported transport version and drops anything the panel cannot trust. */
export function normalizeForwardXRuntimeTransportVersion(value: unknown): ForwardXRuntimeTransportVersion | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  return REPORTED_FORWARDX_TRANSPORT_VERSIONS.has(normalized)
    ? normalized as ForwardXRuntimeTransportVersion
    : undefined;
}

export function resolveLocalForwardXTransportVersion(input: {
  reportedTransportVersion?: unknown;
  tunnel?: any;
}): ForwardXRuntimeTransportVersion | undefined {
  const reported = normalizeForwardXRuntimeTransportVersion(input.reportedTransportVersion);
  if (reported) return reported;
  if (!input.tunnel) return undefined;
  const mode = String(input.tunnel?.mode || "").trim().toLowerCase();
  if (mode !== "forwardx") return undefined;
  return normalizeForwardXVersion(input.tunnel?.forwardxVersion);
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
