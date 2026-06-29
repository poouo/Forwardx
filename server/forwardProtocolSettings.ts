import {
  FORWARD_PROTOCOL_LABELS,
  FORWARD_TYPES,
  TUNNEL_PROTOCOLS,
  type ForwardProtocolKey,
  type ForwardProtocolSettings,
  normalizeForwardProtocolSettings,
} from "../shared/forwardTypes";
import { getSetting } from "./repositories/settingsRepository";
import { getTunnelById } from "./repositories/tunnelRepository";

export const UNSUPPORTED_FORWARD_PROTOCOL_MESSAGE = "当前不支持，请联系管理员";

function parseSettings(value: string | null | undefined) {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function getForwardProtocolSettings(): Promise<ForwardProtocolSettings> {
  return normalizeForwardProtocolSettings(parseSettings(await getSetting("forwardProtocols")));
}

export function getTunnelProtocolKey(tunnel: any): ForwardProtocolKey | null {
  const mode = String(tunnel?.mode || "").toLowerCase();
  if (mode === "nginx_tls") return "nginx_stream";
  return (TUNNEL_PROTOCOLS as readonly string[]).includes(mode) ? mode as ForwardProtocolKey : null;
}

export function getRuleProtocolKey(rule: any, tunnel?: any | null): ForwardProtocolKey | null {
  if (rule?.forwardType === "gost" && rule?.tunnelId && tunnel) {
    return getTunnelProtocolKey(tunnel);
  }
  const forwardType = String(rule?.forwardType || "").toLowerCase();
  return (FORWARD_TYPES as readonly string[]).includes(forwardType) ? forwardType as ForwardProtocolKey : null;
}

export function isForwardProtocolKeyEnabled(settings: ForwardProtocolSettings, key: ForwardProtocolKey | null) {
  if (!key) return true;
  return settings[key] !== false;
}

export function isTunnelProtocolEnabled(settings: ForwardProtocolSettings, tunnel: any) {
  return isForwardProtocolKeyEnabled(settings, getTunnelProtocolKey(tunnel));
}

export function isRuleProtocolEnabled(settings: ForwardProtocolSettings, rule: any, tunnel?: any | null) {
  return isForwardProtocolKeyEnabled(settings, getRuleProtocolKey(rule, tunnel));
}

export function disabledProtocolError(key: ForwardProtocolKey | null) {
  const label = key ? FORWARD_PROTOCOL_LABELS[key] : "该协议";
  return `${label} ${UNSUPPORTED_FORWARD_PROTOCOL_MESSAGE}`;
}

export async function requireTunnelProtocolEnabled(tunnel: any) {
  const settings = await getForwardProtocolSettings();
  const key = getTunnelProtocolKey(tunnel);
  if (!isForwardProtocolKeyEnabled(settings, key)) {
    throw new Error(disabledProtocolError(key));
  }
}

export async function requireRuleProtocolEnabled(rule: any, tunnel?: any | null) {
  const settings = await getForwardProtocolSettings();
  const selectedTunnel = tunnel ?? (rule?.tunnelId ? await getTunnelById(Number(rule.tunnelId)) : null);
  const key = getRuleProtocolKey(rule, selectedTunnel);
  if (!isForwardProtocolKeyEnabled(settings, key)) {
    throw new Error(disabledProtocolError(key));
  }
}
