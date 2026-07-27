import { performance } from "node:perf_hooks";

const DEFAULT_TIME_SOURCES = [
  "https://www.cloudflare.com/cdn-cgi/trace",
  "https://github.com/",
  "https://www.baidu.com/",
];
const DEFAULT_REQUEST_TIMEOUT_MS = 3_500;
const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const CONSENSUS_TOLERANCE_MS = 5_000;
const MAX_CLOCK_OFFSET_MS = 24 * 60 * 60 * 1000;
const MAX_SOURCE_AGE_SECONDS = 24 * 60 * 60;
const FAILURE_LOG_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface PanelClockSample {
  source: string;
  offsetMs: number;
  roundTripMs: number;
  remoteTimeMs: number;
  monotonicMidpointMs: number;
}

export interface PanelClockConsensus {
  offsetMs: number;
  samples: PanelClockSample[];
  degraded: boolean;
}

interface ClockCalibration {
  trustedAtMs: number;
  monotonicAtMs: number;
  monotonicNow: () => number;
  offsetMs: number;
  sources: string[];
  calibratedAtSystemMs: number;
}

interface PanelClockLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface RefreshPanelClockOptions {
  sources?: string[];
  fetchImpl?: typeof fetch;
  wallNow?: () => number;
  monotonicNow?: () => number;
  requestTimeoutMs?: number;
  allowSingleSource?: boolean;
  logger?: PanelClockLogger;
}

export interface InitializePanelClockOptions extends RefreshPanelClockOptions {
  enabled?: boolean;
  startRefreshTimer?: boolean;
  refreshIntervalMs?: number;
}

let calibration: ClockCalibration | null = null;
let refreshInFlight: Promise<PanelClockConsensus | null> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let lastFailureLogAt = 0;

function envFlagEnabled(value: string | undefined, fallback: boolean) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  return !["0", "false", "no", "off"].includes(normalized);
}

function normalizeTimeSources(values: string[]) {
  const unique = new Set<string>();
  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:") unique.add(url.toString());
    } catch {
      // Ignore malformed sources. An explicitly invalid list fails closed below.
    }
  }
  return Array.from(unique).slice(0, 8);
}

function configuredSources() {
  const raw = String(process.env.FORWARDX_PANEL_TIME_SOURCES || "").trim();
  return normalizeTimeSources(raw ? raw.split(/[\s,;]+/) : DEFAULT_TIME_SOURCES);
}

function noCacheUrl(source: string) {
  const url = new URL(source);
  url.searchParams.set("forwardx_clock_probe", `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  return url.toString();
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function selectPanelClockConsensus(
  samples: PanelClockSample[],
  toleranceMs = CONSENSUS_TOLERANCE_MS,
  allowSingleSource = false,
): PanelClockConsensus | null {
  const valid = samples
    .filter((sample) => Number.isFinite(sample.offsetMs)
      && Number.isFinite(sample.roundTripMs)
      && sample.roundTripMs >= 0
      && Math.abs(sample.offsetMs) <= MAX_CLOCK_OFFSET_MS)
    .sort((left, right) => left.offsetMs - right.offsetMs);
  if (valid.length === 0) return null;
  if (valid.length === 1) {
    return allowSingleSource ? { offsetMs: valid[0].offsetMs, samples: valid, degraded: true } : null;
  }

  let best: PanelClockSample[] = [];
  let ambiguous = false;
  for (let start = 0; start < valid.length; start += 1) {
    let end = start;
    while (end + 1 < valid.length && valid[end + 1].offsetMs - valid[start].offsetMs <= toleranceMs) end += 1;
    const candidate = valid.slice(start, end + 1);
    if (candidate.length > best.length) {
      best = candidate;
      ambiguous = false;
      continue;
    }
    if (candidate.length === best.length && best.length > 0) {
      const bestMedian = median(best.map((sample) => sample.offsetMs));
      const candidateMedian = median(candidate.map((sample) => sample.offsetMs));
      if (Math.abs(bestMedian - candidateMedian) > toleranceMs) ambiguous = true;
    }
  }

  if (best.length < 2 || ambiguous) return null;
  return {
    offsetMs: median(best.map((sample) => sample.offsetMs)),
    samples: best,
    degraded: false,
  };
}

export async function probePanelClockSource(
  source: string,
  options: Omit<RefreshPanelClockOptions, "sources" | "logger"> = {},
): Promise<PanelClockSample | null> {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const wallNow = options.wallNow || Date.now;
  const monotonicNow = options.monotonicNow || performance.now.bind(performance);
  const requestTimeoutMs = Math.max(250, options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const startedWallMs = wallNow();
  const startedMonotonicMs = monotonicNow();
  let response: Response | null = null;
  try {
    response = await fetchImpl(noCacheUrl(source), {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "text/plain, */*;q=0.1",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "User-Agent": "ForwardX-Panel-Clock/1",
      },
    });
    if (!response.url || new URL(response.url).protocol !== "https:") return null;
    const endedMonotonicMs = monotonicNow();
    const endedWallMs = wallNow();
    const roundTripMs = Math.max(0, endedMonotonicMs - startedMonotonicMs);
    if (roundTripMs > requestTimeoutMs) return null;
    if (Math.abs((endedWallMs - startedWallMs) - roundTripMs) > 1_000) return null;
    const dateMs = Date.parse(String(response.headers.get("date") || ""));
    if (!Number.isFinite(dateMs)) return null;
    const rawAge = Number.parseInt(String(response.headers.get("age") || "0"), 10);
    const ageSeconds = Number.isFinite(rawAge)
      ? Math.min(Math.max(rawAge, 0), MAX_SOURCE_AGE_SECONDS)
      : 0;
    // HTTP-date has one-second precision. Half a second centers its rounding error.
    const remoteTimeMs = dateMs + ageSeconds * 1000 + 500;
    const localMidpointMs = startedWallMs + roundTripMs / 2;
    const monotonicMidpointMs = startedMonotonicMs + roundTripMs / 2;
    const offsetMs = remoteTimeMs - localMidpointMs;
    if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > MAX_CLOCK_OFFSET_MS) return null;
    return { source, offsetMs, roundTripMs, remoteTimeMs, monotonicMidpointMs };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    if (response?.body) void response.body.cancel().catch(() => undefined);
  }
}

function formatOffset(offsetMs: number) {
  const sign = offsetMs >= 0 ? "+" : "";
  return `${sign}${(offsetMs / 1000).toFixed(3)}s`;
}

function shouldLogFailure(nowMs: number) {
  if (lastFailureLogAt === 0 || nowMs - lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS) {
    lastFailureLogAt = nowMs;
    return true;
  }
  return false;
}

async function performPanelClockRefresh(options: RefreshPanelClockOptions) {
  const logger = options.logger || console;
  const wallNow = options.wallNow || Date.now;
  const monotonicNow = options.monotonicNow || performance.now.bind(performance);
  const sources = options.sources ? normalizeTimeSources(options.sources) : configuredSources();
  if (sources.length === 0) {
    if (shouldLogFailure(wallNow())) logger.warn("[PanelClock] no valid HTTPS time sources configured; using the existing protocol clock");
    return null;
  }

  const results = await Promise.all(sources.map((source) => probePanelClockSource(source, {
    fetchImpl: options.fetchImpl,
    wallNow,
    monotonicNow,
    requestTimeoutMs: options.requestTimeoutMs,
  })));
  const samples = results.filter((sample): sample is PanelClockSample => sample !== null);
  const allowSingleSource = options.allowSingleSource
    ?? envFlagEnabled(process.env.FORWARDX_PANEL_TIME_ALLOW_SINGLE_SOURCE, false);
  const consensus = selectPanelClockConsensus(samples, CONSENSUS_TOLERANCE_MS, allowSingleSource);
  if (!consensus) {
    if (shouldLogFailure(wallNow())) {
      logger.warn(`[PanelClock] calibration failed (${samples.length}/${sources.length} usable sources); using the existing protocol clock`);
    }
    return null;
  }

  const monotonicAtMs = monotonicNow();
  const trustedAtMs = median(consensus.samples.map((sample) => (
    sample.remoteTimeMs + (monotonicAtMs - sample.monotonicMidpointMs)
  )));
  const calibratedAtSystemMs = wallNow();
  const appliedOffsetMs = trustedAtMs - calibratedAtSystemMs;
  calibration = {
    trustedAtMs,
    monotonicAtMs,
    monotonicNow,
    offsetMs: appliedOffsetMs,
    sources: consensus.samples.map((sample) => sample.source),
    calibratedAtSystemMs,
  };
  lastFailureLogAt = 0;
  const sourceSummary = `${consensus.samples.length}/${sources.length}`;
  logger.info(
    `[PanelClock] Agent protocol clock calibrated offset=${formatOffset(appliedOffsetMs)} sources=${sourceSummary}`
      + (consensus.degraded ? " (single-source fallback)" : ""),
  );
  return { ...consensus, offsetMs: appliedOffsetMs };
}

export function refreshPanelClock(options: RefreshPanelClockOptions = {}) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = performPanelClockRefresh(options).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export async function initializePanelClock(options: InitializePanelClockOptions = {}) {
  if (initialized) return getPanelClockStatus();
  initialized = true;
  const logger = options.logger || console;
  const enabled = options.enabled ?? envFlagEnabled(process.env.FORWARDX_PANEL_TIME_SYNC, true);
  if (!enabled) {
    logger.info("[PanelClock] external calibration disabled; Agent protocol uses system time");
    return getPanelClockStatus();
  }

  await refreshPanelClock(options);
  if (options.startRefreshTimer !== false) {
    const refreshIntervalMs = Math.max(60_000, options.refreshIntervalMs || DEFAULT_REFRESH_INTERVAL_MS);
    refreshTimer = setInterval(() => {
      void refreshPanelClock(options);
    }, refreshIntervalMs);
    refreshTimer.unref?.();
  }
  return getPanelClockStatus();
}

export function panelCryptoNowMs() {
  if (!calibration) return Date.now();
  return Math.round(calibration.trustedAtMs + (calibration.monotonicNow() - calibration.monotonicAtMs));
}

export function getPanelClockStatus() {
  return calibration ? {
    calibrated: true as const,
    offsetMs: calibration.offsetMs,
    sources: [...calibration.sources],
    calibratedAtSystemMs: calibration.calibratedAtSystemMs,
  } : {
    calibrated: false as const,
    offsetMs: 0,
    sources: [] as string[],
    calibratedAtSystemMs: null,
  };
}

export function resetPanelClockForTests() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  refreshInFlight = null;
  calibration = null;
  initialized = false;
  lastFailureLogAt = 0;
}
