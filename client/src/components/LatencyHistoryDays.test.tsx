import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "./ui/tooltip";
import { latencyDayHealth, latencyHistoryDays, LatencyHistoryDayStrip, LatencyHistoryTodayButton, summarizeLatencyDays } from "./LatencyHistoryDays";
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
