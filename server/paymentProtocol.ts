import crypto from "node:crypto";
import { importPaymentPublicKey } from "./paymentCrypto";

/** Keep the timeout active until the response body has also been consumed. */
export async function fetchPaymentText(url: string, options: RequestInit = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { response, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

export function alipayTimestamp(date = new Date()) {
  // The gateway requires Beijing time, independently of the panel's timezone.
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export function normalizePaymentLink(value: unknown, gateway: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const link = value.trim();
  // QR contents can be opaque tokens or weixin:// URIs, not necessarily URLs.
  return link.startsWith("/") ? new URL(link, `${gateway}/`).href : link;
}

/** Extract the exact signed bytes, not a JSON re-serialization. */
export function rawJsonMember(raw: string, member: string): string | undefined {
  JSON.parse(raw); // Validate before scanning; do not accept partial JSON.
  let i = raw.search(/\S/);
  if (raw[i++] !== "{") throw new Error("Expected a JSON object");
  const seen = new Set<string>();
  let result: string | undefined;
  const skipSpace = () => { while (/\s/.test(raw[i] || "") && i < raw.length) i++; };
  const stringEnd = (start: number) => {
    let cursor = start + 1;
    while (cursor < raw.length) {
      if (raw[cursor] === "\\") cursor += 2;
      else if (raw[cursor++] === '"') return cursor;
    }
    throw new Error("Unterminated JSON string");
  };
  for (;;) {
    skipSpace();
    if (raw[i] === "}") break;
    const endKey = stringEnd(i);
    const key = JSON.parse(raw.slice(i, endKey)) as string;
    if (seen.has(key)) throw new Error("Duplicate JSON response member");
    seen.add(key);
    i = endKey;
    skipSpace();
    i++; // colon (already validated)
    skipSpace();
    const start = i;
    let depth = 0;
    for (; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '"') { i = stringEnd(i) - 1; continue; }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) break;
    }
    if (key === member) result = raw.slice(start, i).trimEnd();
    if (raw[i] === "}") break;
    i++; // comma
  }
  return result;
}

export function verifyAlipayResponse(raw: string, responseKey: string, publicKey: string) {
  const data = JSON.parse(raw);
  const content = rawJsonMember(raw, responseKey);
  return !!content && typeof data.sign === "string" && crypto.verify(
    "RSA-SHA256", Buffer.from(content), importPaymentPublicKey(publicKey, "alipay"), Buffer.from(data.sign, "base64"),
  );
}
