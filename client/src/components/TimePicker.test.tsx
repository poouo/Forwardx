import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import TimePicker from "./TimePicker";

test("time picker shows the exact 24-hour value, links its label and respects disabled state", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      for (const value of ["00:00", "08:30", "23:59"]) {
        const html = renderToStaticMarkup(<><label htmlFor="report-time">Time</label><TimePicker id="report-time" value={value} onChange={() => {}} disabled /></>);
        assert.match(html, /for="report-time"/);
        assert.match(html, /id="report-time"/);
        assert.match(html, /disabled=""/);
        const [hour, minute] = value.split(":");
        assert.ok(html.includes(`value="${hour}"`));
        assert.ok(html.includes(`value="${minute}"`));
        assert.equal((html.match(/role="combobox"/g) || []).length, 2);
        assert.match(html, /id="report-time-minute"/);
        assert.equal((html.match(/inputmode="numeric"/gi) || []).length, 2);
        assert.doesNotMatch(html, /type="time"/);
      }
    }
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

test("time picker uses separate hour/minute selects and bounded themed overlays", () => {
  const picker = readFileSync("client/src/components/TimePicker.tsx", "utf8");
  const settings = readFileSync("client/src/components/OperationsSettingsDialog.tsx", "utf8");
  assert.match(picker, /count: 24/);
  assert.match(picker, /count: 60/);
  assert.match(picker, /<Select value=\{value\}/);
  assert.match(picker, /<SelectTrigger[^>]+aria-label=\{label\}/);
  assert.match(picker, /<SelectContent/);
  assert.doesNotMatch(picker, /Popover|type="radio"/);
  assert.match(picker, /collisionPadding=\{12\}/);
  assert.match(picker, /--radix-select-content-available-height/);
  assert.match(picker, /Number\(next\) >= count/);
  assert.match(picker, /next.padStart\(2, "0"\)/);
  assert.match(picker, /showIndicator=\{false\}/);
  assert.match(picker, /time-picker-options/);
  assert.match(picker, /data-\[state=checked\]:bg-accent/);
  assert.match(settings, /<TimePicker id="operations-report-time"/);
  assert.doesNotMatch(settings, /type="time"/);
});

test("time dropdown scrollbar stays in a stable right gutter without changing other selects", () => {
  const css = readFileSync("client/src/index.css", "utf8");
  const select = readFileSync("client/src/components/ui/select.tsx", "utf8");
  assert.match(css, /\.time-picker-options \{[^}]*padding: 8px 4px;/);
  assert.match(css, /\.time-picker-options \[data-radix-select-viewport\] \{[^}]*scrollbar-width: auto;[^}]*scrollbar-gutter: stable;/);
  assert.match(css, /\.time-picker-options \[data-radix-select-viewport\]::-webkit-scrollbar \{[^}]*display: block;/);
  assert.match(select, /showIndicator = true/);
  assert.match(select, /showIndicator && <span/);
});
