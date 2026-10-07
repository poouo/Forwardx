export const MANUAL_PROBE_QUERY_PATHS = new Set(["tunnels.test", "tunnels.getById"]);
export const MANUAL_PROBE_UI_TIMEOUT_MS = 95_000;

export function manualProbeDeadline(raw: unknown, localStartedAt: number): number {
  if (localStartedAt > 0) return localStartedAt + MANUAL_PROBE_UI_TIMEOUT_MS;
  try {
    const parsed = JSON.parse(String(raw || "{}"));
    if (Number.isFinite(parsed.deadlineAt)) return parsed.deadlineAt + 5_000;
    const started = Date.parse(parsed.generatedAt || "");
    if (Number.isFinite(started)) return started + MANUAL_PROBE_UI_TIMEOUT_MS;
  } catch { /* legacy plain-text result */ }
  return 0;
}

/** Isolated, bounded requests, including stalled response bodies. */
export async function fetchManualProbe(fetcher: typeof fetch, input: RequestInfo | URL, init?: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const source = init?.signal || (input instanceof Request ? input.signal : undefined);
  const abort = () => controller.abort(source?.reason);
  if (source?.aborted) abort();
  else source?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Probe request timed out", "TimeoutError")), timeoutMs);
  try {
    const response = await fetcher(input, { ...init, signal: controller.signal, cache: "no-store" });
    const body = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
    source?.removeEventListener("abort", abort);
  }
}
