import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { initializeLanguage, setLanguagePreference } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { latencyHistoryDays } from "@/components/LatencyHistoryDays";
import { HostAvailabilityHistory, availabilityHealth, availabilityDuration } from "./HostAvailabilityHistory";
import type { AvailabilityDay } from "@shared/hostAvailability";

test("host availability colors use uptime, not probe loss, and support no/partial coverage", async () => {
  const days = latencyHistoryDays(new Date(2026, 9, 12, 12));
  const summaries = [100, 99.5, 98, null].map((uptimePercent, index): AvailabilityDay => ({ startAt: days[index].startAt.getTime() / 1000, endAt: days[index].endAt.getTime() / 1000, onlineSeconds: 80000, offlineSeconds: 100, unknownSeconds: 6300, observedSeconds: uptimePercent == null ? 0 : 80100, offlineCount: 1, uptimePercent, coveragePercent: 92.7 }));
  summaries[0].trend = [{ from: 0, to: 0.5, health: "good" }, { from: 0.5, to: 0.52, health: "bad" }, { from: 0.52, to: 1, health: "none" }];
  assert.equal(availabilityHealth({ ...summaries[0], uptimePercent: 99.9 }), "good");
  assert.equal(availabilityHealth({ ...summaries[0], uptimePercent: 99 }), "warning");
  assert.equal(availabilityHealth(summaries[2]), "bad");
  assert.equal(availabilityHealth(summaries[3]), "none");
  assert.equal(availabilityDuration(3661), "1h 1m 1s");
  for (const language of ["en", "zh-CN"] as const) {
    setLanguagePreference(language);
    await initializeLanguage();
    const start = days[0].startAt.getTime() / 1000;
    const intervals = Array.from({ length: 60 }, (_, index) => ({ observationKey: String(index), hostId: 1, startAt: start + index * 60, endAt: start + (index + 1) * 60, online: index % 2 === 0, offlineIncident: index % 2 !== 0 }));
    const html = renderToStaticMarkup(<TooltipProvider><HostAvailabilityHistory days={days} summaries={summaries} selectedDay={days[0].date} onSelect={() => {}} detail={{ days: [summaries[0]], intervals }} /></TooltipProvider>);
    assert.equal((html.match(/aria-pressed=/g) || []).length, 30);
    for (const health of ["good", "warning", "bad", "none"]) assert.match(html, new RegExp(`data-health="${health}"`));
    assert.match(html, /data-partial="true"/);
    assert.match(html, /repeating-linear-gradient/);
    assert.match(html, /100\.000%/);
    assert.match(html, /#ef444470 50%/, "the noon outage preview needs no additional detail request");
    if (language === "en") {
      assert.doesNotMatch(html, /\p{Script=Han}/u);
      assert.match(html, /More periods/);
    }
    const error = renderToStaticMarkup(<TooltipProvider><HostAvailabilityHistory days={days} summaries={summaries} selectedDay={days[0].date} onSelect={() => {}} error detailError /></TooltipProvider>);
    assert.doesNotMatch(error, /data-health="good"/);
    assert.doesNotMatch(error, /#ef444470/, "failed summary queries must not display cached trends");
    assert.match(error, /role="alert"/);
  }
});
