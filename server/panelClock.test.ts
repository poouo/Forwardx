import assert from "node:assert/strict";
import test from "node:test";
import {
  getPanelClockStatus,
  panelCryptoNowMs,
  probePanelClockSource,
  refreshPanelClock,
  resetPanelClockForTests,
  selectPanelClockConsensus,
  type PanelClockSample,
} from "./panelClock";

const DATE_HEADER_MS = Date.UTC(2026, 6, 27, 13, 14, 20);
const DATE_HEADER = new Date(DATE_HEADER_MS).toUTCString();

function sequence(values: number[]) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function clockResponse(url: string, date = DATE_HEADER) {
  return {
    url,
    headers: new Headers({ date }),
    body: null,
  } as Response;
}

function responseFetch(url: string, date = DATE_HEADER): typeof fetch {
  return (async () => clockResponse(url, date)) as typeof fetch;
}

function sample(source: string, offsetMs: number): PanelClockSample {
  return {
    source,
    offsetMs,
    roundTripMs: 20,
    remoteTimeMs: 10_000 + offsetMs,
    monotonicMidpointMs: 1_000,
  };
}

test("panel clock probe calculates positive and negative offsets at the RTT midpoint", async () => {
  const cases = [
    { expectedOffsetMs: 302_000, roundTripMs: 200 },
    { expectedOffsetMs: -4_250, roundTripMs: 80 },
  ];

  for (const { expectedOffsetMs, roundTripMs } of cases) {
    const remoteTimeMs = DATE_HEADER_MS + 500;
    const startedWallMs = remoteTimeMs - expectedOffsetMs - roundTripMs / 2;
    const result = await probePanelClockSource("https://clock.example/", {
      fetchImpl: responseFetch("https://clock.example/result"),
      wallNow: sequence([startedWallMs, startedWallMs + roundTripMs]),
      monotonicNow: sequence([1_000, 1_000 + roundTripMs]),
      requestTimeoutMs: 1_000,
    });

    assert.ok(result);
    assert.equal(result.remoteTimeMs, remoteTimeMs, "HTTP-date precision is centered by 500 ms");
    assert.equal(result.roundTripMs, roundTripMs);
    assert.equal(result.offsetMs, expectedOffsetMs);
  }
});

test("panel clock consensus keeps agreeing sources and excludes an outlier", () => {
  const result = selectPanelClockConsensus([
    sample("https://clock-a.example/", 301_800),
    sample("https://clock-b.example/", 302_200),
    sample("https://outlier.example/", -60_000),
  ]);

  assert.ok(result);
  assert.equal(result.offsetMs, 302_000);
  assert.equal(result.degraded, false);
  assert.deepEqual(result.samples.map((item) => item.source), [
    "https://clock-a.example/",
    "https://clock-b.example/",
  ]);
});

test("panel clock rejects a single source by default and only accepts an explicit fallback", () => {
  const onlySample = sample("https://clock.example/", 302_000);
  assert.equal(selectPanelClockConsensus([onlySample]), null);
  assert.deepEqual(selectPanelClockConsensus([onlySample], 5_000, true), {
    offsetMs: 302_000,
    samples: [onlySample],
    degraded: true,
  });
});

test("panel clock rejects an HTTPS probe redirected to HTTP", async () => {
  const result = await probePanelClockSource("https://clock.example/", {
    fetchImpl: responseFetch("http://clock.example/result"),
    wallNow: sequence([10_000, 10_010]),
    monotonicNow: sequence([1_000, 1_010]),
  });
  assert.equal(result, null);
});

test("panel clock rejects a sample when wall time jumps during the request", async () => {
  const result = await probePanelClockSource("https://clock.example/", {
    fetchImpl: responseFetch("https://clock.example/result"),
    wallNow: sequence([10_000, 13_000]),
    monotonicNow: sequence([1_000, 1_100]),
  });
  assert.equal(result, null);
});

test("failed refresh keeps the previous trusted monotonic anchor", async () => {
  resetPanelClockForTests();
  const remoteTimeMs = DATE_HEADER_MS + 500;
  const systemTimeMs = remoteTimeMs - 302_000;
  let monotonicMs = 1_000;
  const silentLogger = { info() {}, warn() {} };

  try {
    const calibrated = await refreshPanelClock({
      sources: ["https://clock-a.example/", "https://clock-b.example/"],
      fetchImpl: responseFetch("https://clock.example/result"),
      wallNow: () => systemTimeMs,
      monotonicNow: () => monotonicMs,
      logger: silentLogger,
    });
    assert.ok(calibrated);
    assert.equal(calibrated.offsetMs, 302_000);

    monotonicMs += 1_234;
    const statusBeforeFailure = getPanelClockStatus();
    const trustedNowBeforeFailure = panelCryptoNowMs();
    const failed = await refreshPanelClock({
      sources: ["https://clock-a.example/", "https://clock-b.example/"],
      fetchImpl: (async () => {
        throw new Error("time source unavailable");
      }) as typeof fetch,
      wallNow: () => systemTimeMs,
      monotonicNow: () => monotonicMs,
      logger: silentLogger,
    });

    assert.equal(failed, null);
    assert.deepEqual(getPanelClockStatus(), statusBeforeFailure);
    assert.equal(panelCryptoNowMs(), trustedNowBeforeFailure);
    assert.equal(panelCryptoNowMs(), remoteTimeMs + 1_234);
  } finally {
    resetPanelClockForTests();
  }
});
