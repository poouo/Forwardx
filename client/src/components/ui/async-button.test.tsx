import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AsyncButton } from "./async-button";
import { createPendingFeedback } from "@/lib/pendingFeedback";

test("fast saves never flash a loading indicator", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const changes: boolean[] = [];
  const feedback = createPendingFeedback(value => changes.push(value));
  feedback.setPending(true);
  t.mock.timers.tick(199);
  assert.deepEqual(changes, []);
  feedback.setPending(false);
  t.mock.timers.tick(1000);
  assert.deepEqual(changes, []);
  feedback.dispose();
});

test("slow saves show feedback after 200ms and keep it visible for at least 300ms", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const changes: boolean[] = [];
  const feedback = createPendingFeedback(value => changes.push(value));
  feedback.setPending(true);
  t.mock.timers.tick(200);
  assert.deepEqual(changes, [true]);
  t.mock.timers.tick(50);
  feedback.setPending(false);
  t.mock.timers.tick(249);
  assert.deepEqual(changes, [true]);
  t.mock.timers.tick(1);
  assert.deepEqual(changes, [true, false]);
  feedback.dispose();
});

test("long saves do not add another minimum wait after completion", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const changes: boolean[] = [];
  const feedback = createPendingFeedback(value => changes.push(value));
  feedback.setPending(true);
  t.mock.timers.tick(200);
  t.mock.timers.tick(2000);
  feedback.setPending(false);
  t.mock.timers.tick(0);
  assert.deepEqual(changes, [true, false]);
  feedback.dispose();
});

test("retries cancel a stale hide timer and repeated pending updates do not restart the delay", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const changes: boolean[] = [];
  const feedback = createPendingFeedback(value => changes.push(value));
  feedback.setPending(true);
  t.mock.timers.tick(100);
  feedback.setPending(true);
  t.mock.timers.tick(100);
  assert.deepEqual(changes, [true]);
  feedback.setPending(false);
  t.mock.timers.tick(100);
  feedback.setPending(true);
  t.mock.timers.tick(1000);
  assert.deepEqual(changes, [true]);
  feedback.setPending(false);
  t.mock.timers.tick(0);
  assert.deepEqual(changes, [true, false]);
  feedback.dispose();
});

test("unmount cancels both delayed show and delayed hide without callbacks", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const shown of [false, true]) {
    const changes: boolean[] = [];
    const feedback = createPendingFeedback(value => changes.push(value));
    feedback.setPending(true);
    if (shown) { t.mock.timers.tick(200); feedback.setPending(false); }
    feedback.dispose();
    feedback.setPending(true);
    t.mock.timers.tick(1000);
    assert.deepEqual(changes, shown ? [true] : []);
  }
});

test("pending buttons immediately block repeat submissions without replacing or resizing the label", () => {
  for (const label of ["保存配色", "Save color theme"]) {
    const idle = renderToStaticMarkup(<AsyncButton pending={false}>{label}</AsyncButton>);
    const busy = renderToStaticMarkup(<AsyncButton pending>{label}</AsyncButton>);
    assert.doesNotMatch(idle, /disabled=""/);
    assert.match(busy, /disabled=""/);
    assert.match(busy, /aria-busy="true"/);
    assert.match(busy, /data-pending="true"/);
    assert.match(busy, /data-\[pending=true\]:disabled:opacity-100/);
    for (const html of [idle, busy]) {
      assert.ok(html.includes(label));
      assert.match(html, /pointer-events-none absolute inset-0/);
      assert.doesNotMatch(html, /animate-spin|Saving|保存中/);
    }
  }
  assert.match(renderToStaticMarkup(<AsyncButton pending={false} disabled>Save</AsyncButton>), /disabled=""/);
});

test("personalization save buttons keep their labels and block duplicate section submissions", () => {
  const settings = readFileSync("client/src/pages/Settings.tsx", "utf8");
  const themeButton = settings.match(/<Button\s+type="button"\s+onClick=\{handleSaveThemePreset\}[\s\S]*?<\/Button>/)?.[0] || "";
  assert.match(themeButton, /disabled=\{isSavingPersonalization\("theme"\) \|\| !themeDirty\}/);
  assert.match(themeButton, /translateText\("保存配色"\)/);
  assert.doesNotMatch(themeButton, /\? translateText|保存中/);
  assert.match(settings, /if \(personalizationSaving\) return;/);
});
