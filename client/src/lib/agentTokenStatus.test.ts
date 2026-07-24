import assert from "node:assert/strict";
import test from "node:test";
import { isTokenHostOnline } from "./agentTokenStatus";

test("agent token status follows the server-computed host state for every heartbeat representation", () => {
  const heartbeatValues = [
    new Date(),
    new Date().toISOString(),
    Math.floor(Date.now() / 1000),
    String(Math.floor(Date.now() / 1000)),
    null,
    "unparseable",
  ];

  for (const lastHeartbeat of heartbeatValues) {
    assert.equal(isTokenHostOnline({ isOnline: true, lastHeartbeat }), true);
    assert.equal(isTokenHostOnline({ isOnline: false, lastHeartbeat }), false);
  }
});

test("an unbound token host is not online", () => {
  assert.equal(isTokenHostOnline(null), false);
  assert.equal(isTokenHostOnline(undefined), false);
});
