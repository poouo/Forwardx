import test from "node:test";
import assert from "node:assert/strict";
import { isRetryableTransactionConflict, retryTransactionConflicts } from "./transactionRetry";

test("only explicit transaction conflicts, including wrapped driver errors, qualify", () => {
  for (const error of [{ code: "ER_LOCK_DEADLOCK" }, { errno: 1213 }, { code: "40P01" }, { cause: { code: "40001" } }]) assert.equal(isRetryableTransactionConflict(error), true);
  for (const code of ["ER_LOCK_WAIT_TIMEOUT", "ECONNRESET", "23505", "SQLITE_BUSY"]) assert.equal(isRetryableTransactionConflict({ code }), false);
  const cyclic: any = {}; cyclic.cause = cyclic;
  assert.equal(isRetryableTransactionConflict(cyclic), false);
});

test("opt-in retries a rolled-back transaction, with fresh per-attempt state", async () => {
  let calls = 0;
  const states = new Set();
  const result = await retryTransactionConflicts(async state => {
    assert.equal(state.rolledBack, false); states.add(state);
    if (++calls < 3) { state.rolledBack = true; throw { code: "ER_LOCK_DEADLOCK" }; }
    return 42;
  }, true);
  assert.equal(result, 42); assert.equal(calls, 3); assert.equal(states.size, 3);
});

test("default transactions, ambiguous failures and post-commit errors never replay", async () => {
  for (const [enabled, rolledBack, code] of [[false, true, "40P01"], [true, false, "40P01"], [true, true, "ECONNRESET"]] as const) {
    let calls = 0;
    await assert.rejects(retryTransactionConflicts(async state => {
      calls++; state.rolledBack = rolledBack; throw Object.assign(new Error(code), { code });
    }, enabled), new RegExp(code));
    assert.equal(calls, 1);
  }
});

test("conflict retries are bounded to three total attempts", async () => {
  let calls = 0;
  await assert.rejects(retryTransactionConflicts(async state => {
    calls++; state.rolledBack = true; throw Object.assign(new Error("deadlock"), { code: "40P01" });
  }, true), /deadlock/);
  assert.equal(calls, 3);
});
