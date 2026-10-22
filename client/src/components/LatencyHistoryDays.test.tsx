import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "./ui/tooltip";
import { latencyDayHealth, latencyHistoryDayDomain, latencyHistoryDays, LatencyHistoryDayStrip, LatencyHistoryTodayButton, summarizeLatencyDays } from "./LatencyHistoryDays";
import { getLatencyStabilityStats } from "@/lib/latencyChart";
import { initializeLanguage, setLanguagePreference } from "@/i18n";

test("day strip spans the latest 30 calendar days across month/year boundaries", () => {
  const days = latencyHistoryDays(new Date(2027, 0, 5, 12));
  assert.equal(days.length, 30);
  assert.equal(days[0].date, "2026-12-07");
  assert.equal(days[29].date, "2027-01-05");
  assert.equal(days[29].index, 30);
  assert.equal(days[0].startAt.getHours(), 0);
  for (let index = 1; index < days.length; index++) assert.equal(days[index].startAt.getTime(), days[index - 1].endAt.getTime());
});

test("today's chart fills midnight to now, while historical charts retain a full calendar day", () => {
  const now = new Date(2026, 9, 22, 11, 30).getTime();
  const days = latencyHistoryDays(new Date(now));
  const today = days[29];
  assert.deepEqual(latencyHistoryDayDomain(today, now), [today.startAt.getTime(), now]);
  assert.deepEqual(latencyHistoryDayDomain(today, now + 30_000), [today.startAt.getTime(), now + 30_000],
    "the axis advances even if a service has not produced another sample");
  const yesterday = days[28];
  assert.deepEqual(latencyHistoryDayDomain(yesterday, now), [yesterday.startAt.getTime(), yesterday.endAt.getTime()]);
  assert.equal(latencyHistoryDayDomain(undefined, now), null, "rolling ranges keep their existing behavior");
  assert.equal(today.endAt.getHours(), 0, "the API query's day boundaries are not shortened to now");
});

test("day domains remain nondegenerate at midnight and honor actual calendar boundaries", () => {
  const midnight = new Date(2027, 0, 1).getTime();
  const days = latencyHistoryDays(new Date(midnight));
  assert.deepEqual(latencyHistoryDayDomain(days[29], midnight), [midnight, midnight + 1]);
  assert.deepEqual(latencyHistoryDayDomain(days[28], midnight), [days[28].startAt.getTime(), midnight]);
  for (const hours of [23, 25]) {
    const startAt = new Date("2026-03-29T00:00:00Z");
    const endAt = new Date(startAt.getTime() + hours * 3600_000);
    assert.deepEqual(latencyHistoryDayDomain({ startAt, endAt }, endAt.getTime() + 1), [startAt.getTime(), endAt.getTime()],
      "do not assume a calendar day is always 24 hours across DST transitions");
  }
});

test("daily health uses weighted counters and preserves raw delay extrema", () => {
  const at = new Date(2026, 9, 12).getTime();
  const summaries = summarizeLatencyDays([
    { dayStart: at, recordedAt: new Date(at), latencyMs: 20, minLatencyMs: 2, maxLatencyMs: 200, probeCount: 10_000, probeSuccesses: 9900 },
    { dayStart: at, recordedAt: new Date(at), latencyMs: 100, probeCount: 5, probeSuccesses: 0 },
  ]);
  assert.equal(summaries.get("2026-10-12")?.total, 10_005);
  assert.equal(summaries.get("2026-10-12")?.max, 200);
  assert.equal(latencyDayHealth(0, 0), "none");
  assert.equal(latencyDayHealth(100, 100), "good");
  assert.equal(latencyDayHealth(100, 99), "good");
  assert.equal(latencyDayHealth(100, 95), "warning");
  assert.equal(latencyDayHealth(100, 94), "bad");
  const stats = getLatencyStabilityStats([{ latency: 20, minLatencyMs: 2, maxLatencyMs: 200, probeCount: 10_000, probeSuccesses: 9900 }]);
  assert.equal(stats.min, 2);
  assert.equal(stats.max, 200);
  assert.equal(stats.lossRate, 1);
});

test("day strip has bilingual, accessible dates and health colors, plus a Today action", async () => {
  const days = latencyHistoryDays(new Date(2026, 9, 12, 12));
  const samples = [100, 97, 80].map((successes, index) => ({ dayStart: days[index].startAt.getTime(), recordedAt: days[index].startAt, probeCount: 100, probeSuccesses: successes }));
  for (const language of ["zh-CN", "en"] as const) {
    setLanguagePreference(language);
    await initializeLanguage();
    const html = renderToStaticMarkup(<TooltipProvider><LatencyHistoryDayStrip days={days} selectedDay={days[29].date} onSelect={() => {}} samples={samples} /><LatencyHistoryTodayButton onClick={() => {}} /></TooltipProvider>);
    assert.equal((html.match(/aria-pressed=/g) || []).length, 30);
    assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
    assert.match(html, /data-health="good"/);
    assert.match(html, /data-health="warning"/);
    assert.match(html, /data-health="bad"/);
    assert.match(html, /data-health="none"/);
    if (language === "en") {
      assert.doesNotMatch(html, /\p{Script=Han}/u);
      assert.match(html, />Today</);
    }
  }
});

test("history dates share a compact expanding desktop strip and a mobile select", () => {
  const days = latencyHistoryDays(new Date(2026, 9, 22, 12));
  const html = renderToStaticMarkup(<TooltipProvider><LatencyHistoryDayStrip days={days} selectedDay={days[29].date} onSelect={() => {}} samples={[]} /></TooltipProvider>);
  const blocks = [...html.matchAll(/<button[^>]*data-history-day="([^"]+)"[^>]*>(.*?)<\/button>/g)];
  assert.deepEqual(blocks.map(block => block[1]), days.map(day => day.date));
  for (const block of blocks) {
    assert.match(block[0], /rounded-\[4px\]/);
    assert.match(block[0], /flex-1/);
    assert.match(block[0], /hover:basis-12/);
    assert.match(block[0], /focus-visible:basis-12/);
    assert.match(block[0], /transition-none/, "animation-disabled rendering remains interactive without transitions");
    assert.match(block[2], /aria-hidden="true"/);
    assert.match(block[2], /opacity-0/);
    assert.match(block[2], /group-hover\/day:opacity-100/);
    assert.match(block[2], /group-focus-visible\/day:opacity-100/);
    assert.ok(block[2].includes(block[1].slice(5).replace("-", "/")));
  }
  assert.match(html, /data-history-day-mobile="true"/);
  const previews = [...html.matchAll(/data-history-trend-preview="true" class="([^"]+)"/g)];
  assert.equal(previews.length, 30);
  for (const preview of previews) {
    assert.match(preview[1], /\bopacity-0\b/, "the resting state displays overall health, not intraday details");
    assert.match(preview[1], /group-hover\/day:opacity-100/);
    assert.match(preview[1], /group-focus-visible\/day:opacity-100/);
    assert.match(preview[1], /transition-none/, "personal animation-off settings still apply to trend reveals");
  }
  assert.match(html, /role="combobox"/);
  assert.doesNotMatch(html, /overflow-x-auto|min-w-10|grid-template-columns/);
});

test("loading and failed history do not show cached healthy blocks", () => {
  const days = latencyHistoryDays(new Date(2026, 9, 22, 12));
  const samples = [{ dayStart: days[29].startAt.getTime(), recordedAt: days[29].startAt, probeCount: 100, probeSuccesses: 100 }];
  for (const state of [{ loading: true }, { error: true }]) {
    const html = renderToStaticMarkup(<TooltipProvider><LatencyHistoryDayStrip days={days} selectedDay={days[29].date} onSelect={() => {}} samples={samples} {...state} /></TooltipProvider>);
    assert.equal((html.match(/data-health="none"/g) || []).length, 30);
    assert.doesNotMatch(html, /data-health="good"/);
  }
});
