import { isForwardXForwardxV3, isForwardXWireGuardV2 } from "./forwardXWireGuard";
import type { ForwardXRuntimeTransportVersion } from "./agentRuntimeRuleState";

export const FORWARDX_V3_TRANSPORTS = ["http", "ws", "tls"] as const;
export type ForwardXV3Transport = (typeof FORWARDX_V3_TRANSPORTS)[number];

export type ForwardXV3SpecOptions = {
  v3Transport: ForwardXV3Transport;
  v3Host?: string;
  v3Path?: string;
  v3UserAgent?: string;
  v3ServerName?: string;
  v3Multiplex?: boolean;
};

export function isForwardXTransportTunnel(tunnel: any) {
  return String(tunnel?.mode || "").trim().toLowerCase() === "forwardx";
}

export function normalizeForwardXV3Transport(value: unknown): ForwardXV3Transport | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  return (FORWARDX_V3_TRANSPORTS as readonly string[]).includes(normalized)
    ? normalized as ForwardXV3Transport
    : undefined;
}

// Database adapters return booleans as native booleans, 0/1 numbers, or
// strings depending on the backend. A null/empty value means "not persisted"
// and must stay omitted so the runtime keeps its own default.
export function normalizeForwardXV3Multiplex(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return undefined;
}

/**
 * V3 outer-transport options of one tunnel row. Every entry rule of a tunnel
 * reads the same row, so all entries of one entry-group emit an identical V3
 * options signature as required by the FXP runtime. Returns null when the row
 * carries no usable V3 transport; callers must skip the tunnel instead of
 * silently downgrading it to V1.
 */
export function forwardXV3SpecOptions(tunnel: any): ForwardXV3SpecOptions | null {
  // V3 options are only meaningful for a v3 ForwardX tunnel; a stale row must
  // never leak them onto a v1/v2 spec.
  if (!isForwardXForwardxV3(tunnel)) return null;
  const v3Transport = normalizeForwardXV3Transport(tunnel?.v3Transport);
  if (!v3Transport) return null;
  const options: ForwardXV3SpecOptions = { v3Transport };
  const v3Host = String(tunnel?.v3Host || "").trim();
  if (v3Host) options.v3Host = v3Host;
  const v3Path = String(tunnel?.v3Path || "").trim();
  if (v3Path) options.v3Path = v3Path;
  const v3UserAgent = String(tunnel?.v3UserAgent || "").trim();
  if (v3UserAgent) options.v3UserAgent = v3UserAgent;
  const v3ServerName = v3Transport === "tls" ? String(tunnel?.v3ServerName || "").trim() : "";
  if (v3ServerName) options.v3ServerName = v3ServerName;
  const v3Multiplex = normalizeForwardXV3Multiplex(tunnel?.v3Multiplex);
  if (v3Multiplex !== undefined) options.v3Multiplex = v3Multiplex;
  return options;
}

export function applyForwardXV3Transport(fxpSpec: any, tunnel: any) {
  const options = forwardXV3SpecOptions(tunnel);
  if (!options) return null;
  fxpSpec.transportVersion = "v3";
  Object.assign(fxpSpec, options);
  return fxpSpec;
}

export function forwardXTransportVersionForTunnel(tunnel: any): ForwardXRuntimeTransportVersion {
  if (isForwardXForwardxV3(tunnel)) return "v3";
  if (isForwardXWireGuardV2(tunnel)) return "v2";
  return "v1";
}

export function expectedForwardXTransportVersion(input: {
  tunnelId?: unknown;
  expectedForwardType?: unknown;
  tunnel?: any;
}): ForwardXRuntimeTransportVersion | undefined {
  const normalizedType = String(input.expectedForwardType || "").trim();
  if (normalizedType !== "forwardx" && normalizedType !== "forwardx-tunnel") return undefined;
  if (!isForwardXTransportTunnel(input.tunnel)) return undefined;
  return forwardXTransportVersionForTunnel(input.tunnel);
}

export function localForwardXTransportCompatible(
  local: { transportVersion?: ForwardXRuntimeTransportVersion },
  expected: ForwardXRuntimeTransportVersion | undefined,
) {
  if (!expected) return true;
  // V2 and V3 must never adopt an older runtime, and a newer runtime must
  // never satisfy a V1 expectation. For V1, tolerate an omitted field from
  // older Agents while still rejecting a clearly stale V2/V3 process.
  if (expected === "v1") return local.transportVersion !== "v2" && local.transportVersion !== "v3";
  return local.transportVersion === expected;
}

/**
 * Applies the transport version (and, for V3, its outer-transport options) of
 * one tunnel to an FXP spec. V2 additionally needs the WireGuard node plan of
 * the current host; the caller supplies that lookup because the plan depends
 * on the heartbeat host.
 */
export async function applyForwardXTransport(
  fxpSpec: any,
  tunnel: any,
  resolveWireGuardPlan: () => Promise<unknown>,
) {
  if (isForwardXForwardxV3(tunnel)) return applyForwardXV3Transport(fxpSpec, tunnel);
  if (!isForwardXWireGuardV2(tunnel)) {
    fxpSpec.transportVersion = "v1";
    return fxpSpec;
  }
  const plan = await resolveWireGuardPlan();
  if (!plan) return null;
  fxpSpec.transportVersion = "v2";
  return fxpSpec;
}
