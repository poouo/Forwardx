import assert from "node:assert/strict";
import test from "node:test";
import { adaptivePollingInterval, isAuthCheckPending, isAuthenticationFailure, retryAuthCheck, shouldRetryQuery } from "./queryPolicy";
import { ACCOUNT_DISABLED_ERR_MSG, SESSION_REPLACED_ERR_MSG, UNAUTHED_ERR_MSG } from "../../../shared/const";

test("busy responses do not immediately retry or become logouts", () => {
  const busy = { message: "服务繁忙，请稍后重试", data: { code: "SERVICE_UNAVAILABLE", httpStatus: 503 } };
  assert.equal(shouldRetryQuery(0, busy), false);
  assert.equal(shouldRetryQuery(0, { data: { httpStatus: 429 } }), false);
  assert.equal(isAuthenticationFailure(busy), false);
  assert.equal(isAuthCheckPending(undefined, false, busy), true);
  assert.equal(isAuthCheckPending({ id: 1 }, false, busy), false);
  assert.equal(isAuthCheckPending(null, false, null), false);
  assert.equal(shouldRetryQuery(0, new Error("network error")), true);
  assert.equal(shouldRetryQuery(1, new Error("network error")), false);
  for (const message of [ACCOUNT_DISABLED_ERR_MSG, SESSION_REPLACED_ERR_MSG, UNAUTHED_ERR_MSG]) {
    assert.equal(isAuthenticationFailure({ message }), true);
    assert.equal(isAuthCheckPending(undefined, false, { message }), false);
    assert.equal(shouldRetryQuery(0, { message }), false);
  }
});

test("polling backs off across refetches and renders; recovery resets it", () => {
  const query = { state: { status: "success", error: null as unknown, errorUpdateCount: 0 } };
  assert.equal(adaptivePollingInterval(2000)(query), 2000);
  query.state.status = "error"; query.state.error = new Error("busy");
  for (const expected of [5000, 10000, 20000, 30000, 30000]) {
    query.state.errorUpdateCount++;
    assert.equal(adaptivePollingInterval(2000)(query), expected);
    assert.equal(adaptivePollingInterval(2000)(query), expected, "renders do not increase backoff");
  }
  assert.equal(adaptivePollingInterval(false)(query), false);
  const other = { state: { ...query.state } };
  assert.equal(adaptivePollingInterval(2000)(other), 5000, "queries do not affect each other");
  query.state.status = "success";
  assert.equal(adaptivePollingInterval(2000)(query), 2000);
  assert.equal(retryAuthCheck(query), false);
  query.state.status = "error";
  assert.equal(retryAuthCheck(query), 5000);
  query.state.errorUpdateCount++;
  assert.equal(retryAuthCheck(query), 10000);
  query.state.status = "success";
  assert.equal(retryAuthCheck(query), false);
  query.state.status = "error"; query.state.errorUpdateCount++;
  assert.equal(retryAuthCheck(query), 5000, "auth recovery resets the retry delay too");
  query.state.error = { message: SESSION_REPLACED_ERR_MSG };
  assert.equal(retryAuthCheck(query), false);
});
