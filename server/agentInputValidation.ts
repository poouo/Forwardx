const HOST_OR_IP_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-_.]*[a-zA-Z0-9])?$|^[a-fA-F0-9:.]+$/;

export function normalizeAgentAddress(value: unknown): string {
  const text = String(value || "").trim();
  if (!text || text.toLowerCase() === "unknown") return "";
  if (text.length > 253) return "";
  return HOST_OR_IP_RE.test(text) ? text : "";
}

export function normalizeAgentText(value: unknown, maxLength: number): string {
  const max = Math.max(1, maxLength);
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

export function normalizeNetworkInterface(value: unknown): string {
  const text = normalizeAgentText(value, 32);
  return /^[a-zA-Z0-9_.:@-]+$/.test(text) ? text : "";
}
