import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { getPanelChangelogUrl, PANEL_UPGRADE_REFRESH_KEY, readPanelUpgradeRefresh, startPanelUpgradeRefresh } from "./panelUpgrade";

const enabledAccelerator = {
  enabled: true,
  panelUpdateEnabled: true,
  url: "https://mirror.example.com",
};

test("builds a direct changelog URL unless panel update acceleration is fully enabled", () => {
  const directUrl = "https://github.com/poouo/Forwardx/releases/tag/v2.3.275";

  assert.equal(getPanelChangelogUrl("2.3.275"), directUrl);
  assert.equal(
    getPanelChangelogUrl("2.3.275", null, { ...enabledAccelerator, panelUpdateEnabled: false }),
    directUrl,
  );
  assert.equal(
    getPanelChangelogUrl("2.3.275", null, { ...enabledAccelerator, enabled: false }),
    directUrl,
  );
  assert.equal(
    getPanelChangelogUrl("2.3.275", null, { ...enabledAccelerator, url: "not-a-url" }),
    directUrl,
  );
});

test("accelerates generated and supplied GitHub release URLs", () => {
  const releaseUrl = "https://github.com/poouo/Forwardx/releases/tag/v2.3.275";
  const acceleratedUrl = `https://mirror.example.com/${releaseUrl}`;

  assert.equal(getPanelChangelogUrl("2.3.275", null, enabledAccelerator), acceleratedUrl);
  assert.equal(getPanelChangelogUrl(null, releaseUrl, enabledAccelerator), acceleratedUrl);
});

function refreshHarness(deadline = 9000, initialNow = 1000) {
  let now = initialNow;
  let refreshed = 0;
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const countdown: number[] = [];
  const timers = {
    setInterval: (callback: () => void) => { callbacks.set(++nextId, callback); return nextId; },
    setTimeout: (callback: () => void) => { callbacks.set(++nextId, callback); return nextId; },
    clearInterval: (id: number) => { callbacks.delete(id); },
    clearTimeout: (id: number) => { callbacks.delete(id); },
  } as Pick<Window, "setInterval" | "clearInterval" | "setTimeout" | "clearTimeout">;
  const controller = startPanelUpgradeRefresh(deadline, {
    now: () => now, timers,
    onCountdown: seconds => countdown.push(seconds),
    onRefresh: () => { refreshed++; },
  });
  return { controller, callbacks, countdown, refreshed: () => refreshed, setNow: (value: number) => { now = value; } };
}

test("upgrade countdown uses elapsed wall time instead of counting timer ticks", () => {
  const h = refreshHarness();
  assert.deepEqual(h.countdown, [8]);
  h.setNow(4200);
  h.controller.check();
  assert.deepEqual(h.countdown, [8, 5]);
  assert.equal(h.refreshed(), 0);
  h.setNow(8999);
  h.controller.check();
  assert.equal(h.countdown.at(-1), 1);
  h.setNow(9000);
  h.controller.check();
  assert.equal(h.countdown.at(-1), 0);
  assert.equal(h.refreshed(), 1);
  assert.equal(h.callbacks.size, 0);
});

test("background timer or resume event refreshes once after a throttled/frozen deadline", () => {
  for (const resumeByEvent of [true, false]) {
    const h = refreshHarness();
    const staleCallbacks = [...h.callbacks.values()];
    h.setNow(75000);
    if (resumeByEvent) h.controller.check();
    else staleCallbacks[0]();
    for (const callback of staleCallbacks) callback();
    h.controller.check();
    assert.equal(h.refreshed(), 1);
    assert.deepEqual(h.countdown, [8, 0]);
  }
});

test("unmount cleanup stops callbacks; remount preserves the original deadline", () => {
  const h = refreshHarness();
  const callbacks = [...h.callbacks.values()];
  h.controller.dispose();
  h.setNow(9500);
  for (const callback of callbacks) callback();
  assert.equal(h.refreshed(), 0);
  assert.equal(h.callbacks.size, 0);
  const resumed = refreshHarness(9000, 9500);
  assert.deepEqual(resumed.countdown, [0]);
  assert.equal(resumed.refreshed(), 1);
});

test("refresh session persists both deadlines and completed job identity without accepting corrupt data", () => {
  const storage = (raw: string | null) => ({ getItem: (key: string) => { assert.equal(key, PANEL_UPGRADE_REFRESH_KEY); return raw; } });
  const pending = { jobKey: "upgrade:2.3.285:1000", deadline: 9000 };
  assert.deepEqual(readPanelUpgradeRefresh(storage(JSON.stringify(pending))), { ...pending, completed: false });
  assert.deepEqual(readPanelUpgradeRefresh(storage(JSON.stringify({ ...pending, completed: true }))), { ...pending, completed: true });
  for (const raw of [null, "not json", "{}", "null", '{"jobKey":"x","deadline":"9000"}', '{"jobKey":"","deadline":9000}']) {
    assert.equal(readPanelUpgradeRefresh(storage(raw)), null);
  }
});

test("upgrade status observers allow background polling and the layout handles resume events", () => {
  for (const file of ["client/src/components/DashboardLayout.tsx", "client/src/pages/Settings.tsx"]) {
    const source = readFileSync(file, "utf8");
    const query = source.slice(source.indexOf("trpc.system.upgradeStatus.useQuery"));
    assert.match(query.slice(0, 650), /refetchIntervalInBackground: true/);
  }
  const layout = readFileSync("client/src/components/DashboardLayout.tsx", "utf8");
  for (const event of ["focus", "pageshow", "visibilitychange"]) {
    assert.ok(layout.includes(`addEventListener("${event}", refresh.check)`));
    assert.ok(layout.includes(`removeEventListener("${event}", refresh.check)`));
  }
  assert.doesNotMatch(layout, /setUpgradeRefreshCountdown\(\(value\)/);
});
