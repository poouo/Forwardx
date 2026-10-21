import { createHash } from "node:crypto";

/** Binds reports to the complete URL settings, so in-flight old probes are ignored. */
export function urlProbeKey(service: { serviceId: number; targetUrl: string; timeoutSeconds: number; expectedStatus: number }) {
  const hash = createHash("sha256").update(`${service.targetUrl}\n${service.timeoutSeconds}\n${service.expectedStatus}`).digest("hex");
  return `service:${service.serviceId}:url:${hash}`;
}

export function matchesUrlProbeReport(report: { method?: string; probeKey?: string }, expected: any) {
  return report.method === "url" && report.probeKey === urlProbeKey(expected);
}
