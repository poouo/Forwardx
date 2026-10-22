import assert from "node:assert/strict";
import test from "node:test";
import { historyTrendGradient, probeDayTrend } from "./historyDayTrend";

const start = new Date(2026, 9, 21).getTime();
const day = { startAt: new Date(start), endAt: new Date(start + 86400_000) };
const row = (hour: number, count: number, successes: number, seriesKey = "total") => ({ recordedAt: new Date(start + hour * 3600_000), probeCount: count, probeSuccesses: successes, isTimeout: successes === 0, seriesKey });

test("probe trends place noon failures centrally and retain unknown slots", () => {
  const trend = probeDayTrend(day, [row(6, 100, 100), row(10, 100, 97), row(12, 5, 0), row(15, 100, 100)], day.endAt.getTime());
  assert.equal(trend.length, 48);
  assert.equal(trend[12].health, "good");
  assert.equal(trend[20].health, "warning");
  assert.equal(trend[24].health, "bad");
  assert.equal(trend[30].health, "good");
  assert.equal(trend[0].health, "none");
  const today = probeDayTrend(day, [row(12, 5, 0), row(21, 100, 100)], start + 18 * 3600_000);
  assert.equal(today[32].health, "bad");
  assert.equal(today[47].health, "none", "future samples must not invent a healthy tail");
});

test("probe trends use weighted counters and total series without double counting hops", () => {
  const trend = probeDayTrend(day, [row(12, 1000, 990), row(12.1, 5, 0), row(12, 10000, 10000, "hop-1")], day.endAt.getTime());
  assert.equal(trend[24].health, "warning");
  assert.equal(probeDayTrend(day, [], day.endAt.getTime()).every(segment => segment.health === "none"), true);
});

test("trend backgrounds compact adjacent colors without changing timestamps or mutating input", () => {
  const segments = [{ from: 0, to: 0.25, health: "good" as const }, { from: 0.25, to: 0.5, health: "good" as const }, { from: 0.5, to: 1, health: "bad" as const }];
  const gradient = historyTrendGradient(segments)!;
  assert.match(gradient, /#10b98140 0%, #10b98140 50%, #ef444470 50%, #ef444470 100%/);
  assert.equal(segments[0].to, 0.25);
  assert.equal(historyTrendGradient([]), undefined);
});
