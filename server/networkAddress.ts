import { isIP } from "net";

type HostOrIpValidationOptions = {
  allowUnderscore?: boolean;
  allowLooseIpLiteral?: boolean;
};

export function unwrapBracketedHost(value: unknown) {
  const text = String(value || "").trim();
  return text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1).trim() : text;
}

export function isValidHostOrIp(value: unknown, options: HostOrIpValidationOptions = {}) {
  const text = String(value || "").trim();
  if (!text || text.length > 253) return false;
  const unwrapped = unwrapBracketedHost(text);
  if (isIP(unwrapped)) return true;
  if (options.allowLooseIpLiteral && /^[a-fA-F0-9:.]+$/.test(text)) return true;
  const hostPattern = options.allowUnderscore
    ? /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$/
    : /^[a-zA-Z0-9]([a-zA-Z0-9\-.]*[a-zA-Z0-9])?$/;
  return hostPattern.test(text);
}
