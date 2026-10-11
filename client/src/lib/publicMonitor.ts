import { t as translateText } from "@/i18n";
export const PUBLIC_MONITOR_QUERY_PATHS = new Set([
  "hosts.publicMonitor",
  "hosts.publicMonitorHostDetail",
]);

export const PUBLIC_MONITOR_REFRESH_OPTIONS = {
  retry: false,
  refetchOnWindowFocus: "always",
  refetchOnReconnect: "always",
  staleTime: 0,
} as const;

// Keep the deadline alive until the body is read, not only until headers arrive.
// These read-only queries use an isolated link so a slow request cannot hold up
// the other monitor query (or unrelated API calls) in a shared batch.
export async function fetchPublicMonitor(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const sourceSignal = init?.signal || (input instanceof Request ? input.signal : undefined);
  const abort = () => controller.abort(sourceSignal?.reason);
  if (sourceSignal?.aborted) abort();
  else sourceSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException(translateText("监控刷新请求超时"), "TimeoutError")), timeoutMs);
  try {
    const response = await fetcher(input, { ...init, signal: controller.signal, cache: "no-store" });
    const body = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
    sourceSignal?.removeEventListener("abort", abort);
  }
}

export function isMonitorNotFound(error: unknown): boolean {
  return (error as { data?: { code?: string } } | null)?.data?.code === "NOT_FOUND";
}

export function latestMonitorMetric<T extends { recordedAt?: unknown }>(live?: T | null, detail?: T | null): T | null {
  if (!live) return detail || null;
  if (!detail) return live;
  const timestamp = (value: unknown) => value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return timestamp(detail.recordedAt) > timestamp(live.recordedAt) ? detail : live;
}

export function monitorLatencyYMax(chart: ReadonlyArray<Record<string, unknown>>, serviceIds: readonly number[]): number {
  let max = 0;
  for (const point of chart) {
    for (const id of serviceIds) {
      const value = Number(point[`service_${id}`]);
      if (Number.isFinite(value) && value > max) max = value;
    }
  }
  return max > 0 ? Math.ceil(max * 1.2) : 120;
}
