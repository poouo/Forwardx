import assert from "node:assert/strict";
import test from "node:test";
import { appIconKey, APP_ICON_VARIANTS } from "../../../shared/appIcons";
import { createAppIconSynchronizer, watchMobileAppIcon } from "./mobileAppIcon";

test("theme keys include every palette in both appearances, with safe fallback", () => {
  assert.equal(APP_ICON_VARIANTS.length, 12);
  assert.equal(new Set(APP_ICON_VARIANTS.map(v => v.key)).size, 12);
  assert.equal(appIconKey("teal", false), "teal-light");
  assert.equal(appIconKey("sakura", true), "sakura-dark");
  assert.equal(appIconKey("unknown", true), "ink-dark");
  assert.equal(appIconKey(null, false), "ink-light");
});

test("ordinary browsers never call the native bridge or register listeners", () => {
  assert.doesNotThrow(() => watchMobileAppIcon({} as HTMLElement, {} as Document)());
});

test("repeated refreshes with the same theme do not repeatedly change the OS icon", async () => {
  const writes: string[] = [];
  const sync = createAppIconSynchronizer(async key => { writes.push(key); return { applied: true }; }, error => assert.fail(String(error)));
  await sync("teal-light");
  await sync("teal-light");
  await sync("teal-dark");
  await sync("teal-dark");
  await sync("teal-light");
  assert.deepEqual(writes, ["teal-light", "teal-dark", "teal-light"]);
});

test("rapid theme changes skip obsolete queued requests and serialize native calls", async () => {
  const writes: string[] = [];
  let release!: () => void;
  const sync = createAppIconSynchronizer(async key => {
    writes.push(key);
    if (writes.length === 1) await new Promise<void>(resolve => { release = resolve; });
    return { applied: true };
  }, error => assert.fail(String(error)));
  const first = sync("ink-light");
  await Promise.resolve();
  const second = sync("teal-dark");
  const third = sync("forest-dark");
  assert.deepEqual(writes, ["ink-light"]);
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(writes, ["ink-light", "forest-dark"]);
});

test("requests coalesce before the first native invocation", async () => {
  const writes: string[] = [];
  const sync = createAppIconSynchronizer(async key => { writes.push(key); return { applied: true }; }, error => assert.fail(String(error)));
  await Promise.all([sync("ink-light"), sync("teal-dark"), sync("ember-dark")]);
  assert.deepEqual(writes, ["ember-dark"]);
});

test("failed and background-deferred updates retry instead of being cached as applied", async () => {
  let attempts = 0;
  const errors: unknown[] = [];
  const sync = createAppIconSynchronizer(async () => {
    if (++attempts === 1) throw new Error("OS busy");
    return { applied: attempts > 2 };
  }, error => errors.push(error));
  await sync("sakura-light");
  await sync("sakura-light");
  await sync("sakura-light");
  await sync("sakura-light");
  assert.equal(attempts, 3);
  assert.equal(errors.length, 1);
});
