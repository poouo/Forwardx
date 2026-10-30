import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ADMIN_VISIT_CHECK_INTERVAL_MS as INTERVAL } from "../shared/visitChecks";

// Exercise the actual cache function without opening a real database/GitHub.
const text = fs.readFileSync("server/_core/systemRouter.ts", "utf8");
const source = ts.createSourceFile("systemRouter.ts", text, ts.ScriptTarget.Latest, true);
const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "getLatestUpdateInfoCached");
assert.ok(fn);
const program = ts.transpileModule(`(() => {
  let lastUpdateInfo = null, updateCheckInFlight = null;
  ${fn.getText(source)}
  return getLatestUpdateInfoCached;
})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture() {
  let now = 1000, calls = 0, enabled = true, fail = false;
  let gate: Promise<void> | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const check = runInNewContext(program, {
    Date: class extends Date { static now() { return now; } },
    ADMIN_VISIT_CHECK_INTERVAL_MS: INTERVAL,
    db: { getSetting: async () => enabled ? "true" : "false" },
    isUpdateAutoCheckEnabled: (settings: any) => settings.updateAutoCheckEnabled !== "false",
    makeUpdateInfo: () => ({ latestVersion: null }),
    fetchLatestUpdateInfo: async () => {
      calls++;
      markStarted();
      await gate;
      return { latestVersion: fail ? null : "2.3.999", checkedAt: new Date(now).toISOString(), ...(fail ? { error: "GitHub unavailable" } : {}) };
    },
  }) as (force?: boolean) => Promise<any>;
  return { check, started, calls: () => calls, advance: (ms: number) => { now += ms; },
    enabled: (value: boolean) => { enabled = value; }, fail: () => { fail = true; }, gate: (value: Promise<void>) => { gate = value; } };
}

test("automatic update checks are lazy and share a 30-minute panel-wide cooldown", async () => {
  const f = fixture();
  f.advance(10 * INTERVAL); assert.equal(f.calls(), 0);
  await f.check(); assert.equal(f.calls(), 1);
  f.advance(INTERVAL - 1);
  await Promise.all(Array.from({ length: 30 }, () => f.check()));
  assert.equal(f.calls(), 1);
  f.advance(1);
  assert.equal(f.calls(), 1, "expiry alone does not schedule a request");
  await Promise.all(Array.from({ length: 30 }, () => f.check()));
  assert.equal(f.calls(), 2);
});

test("concurrent visits coalesce; failed checks also back off for 30 minutes", async () => {
  const f = fixture();
  let unblock!: () => void;
  f.gate(new Promise<void>(resolve => { unblock = resolve; }));
  f.fail();
  const visits = Array.from({ length: 20 }, () => f.check());
  await f.started; assert.equal(f.calls(), 1);
  unblock();
  const results = await Promise.all(visits);
  assert.ok(results.every(result => result.error === "GitHub unavailable"));
  f.advance(INTERVAL - 1); await f.check(); assert.equal(f.calls(), 1);
  f.advance(1); await f.check(); assert.equal(f.calls(), 2);
});

test("disabling automatic checks prevents remote requests but manual checks still work", async () => {
  const f = fixture();
  f.enabled(false); await f.check(); assert.equal(f.calls(), 0);
  await f.check(true); assert.equal(f.calls(), 1);
  f.enabled(true); await f.check(); assert.equal(f.calls(), 1);
  await f.check(true); assert.equal(f.calls(), 2, "manual checks bypass the visit cooldown");
});
