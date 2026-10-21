import { z } from "zod";

export const urlProbeTargetSchema = z.string().trim().min(1).max(2048).refine(value => {
  try {
    const url = new URL(value);
    return /^https?:\/\//i.test(value) && ["http:", "https:"].includes(url.protocol)
      && !!url.hostname && !url.username && !url.password && !url.hash
      && !/[\s\u0000-\u001f\u007f\\]/.test(value);
  } catch { return false; }
}, "请输入有效的 HTTP/HTTPS URL，不含账号密码或片段");

export const urlProbeOptionsSchema = z.object({
  targetUrl: urlProbeTargetSchema.nullable().optional(),
  timeoutSeconds: z.number().int().min(1).max(30).default(5),
  expectedStatus: z.number().int().min(200).max(599).default(200),
});

export type HostProbeMethod = "tcping" | "ping" | "url";
export function normalizeHostProbeMethod(value: unknown): HostProbeMethod {
  return value === "url" ? "url" : value === "ping" ? "ping" : "tcping";
}
