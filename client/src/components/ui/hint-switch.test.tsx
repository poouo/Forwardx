import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HintSwitch, SwitchHint } from "./hint-switch";
import { OptimisticSwitch } from "./switch";

test("unavailable switches remain natively disabled with a focusable hover hint, not permanent copy", () => {
  const html = renderToStaticMarkup(<HintSwitch id="reminder" aria-label="Reminder" hint="Configure a notification channel first." checked={false} disabled onCheckedChange={() => assert.fail("disabled switch cannot change")} />);
  assert.match(html, /<button[^>]*\sdisabled=""/);
  assert.match(html, /aria-checked="false"/);
  assert.match(html, /<span[^>]*tabindex="0"[^>]*role="group"/);
  assert.match(html, /aria-label="Configure a notification channel first\."/);
  assert.match(html, /\[&amp;&gt;button\]:pointer-events-none/);
  assert.doesNotMatch(html, /<p\b|>Configure a notification channel first\.</);
});

test("available switches preserve their state and do not add a second tab stop", () => {
  for (const checked of [true, false]) {
    const html = renderToStaticMarkup(<HintSwitch hint="Only controls notifications." checked={checked} onCheckedChange={() => {}} />);
    assert.match(html, new RegExp(`aria-checked="${checked}"`));
    assert.doesNotMatch(html, /\sdisabled=""|tabindex="0"|>Only controls notifications\.</);
  }
});

test("hint wrapper preserves optimistic switches and can be omitted when there is no hint", () => {
  const html = renderToStaticMarkup(<SwitchHint hint="Channel unavailable" disabled><OptimisticSwitch checked disabled onCheckedChangeAsync={async () => {}} /></SwitchHint>);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /\sdisabled=""/);
  assert.match(html, /data-pending="false"/);
  assert.equal(renderToStaticMarkup(<SwitchHint><span>Control</span></SwitchHint>), "<span>Control</span>");
});
