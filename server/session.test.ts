import assert from "node:assert/strict";
import test from "node:test";
import { encodeSessionLease, parseSessionLease } from "./session";

test("session leases accept only the current JSON shape", () => {
  const activeAt = 1_725_000_000_000;
  assert.deepEqual(
    parseSessionLease(encodeSessionLease("session-id", activeAt)),
    { sid: "session-id", activeAt },
  );
  assert.equal(parseSessionLease("legacy-plain-session-id"), null);
  assert.equal(parseSessionLease(`{"sid":"session-id"}`), null);
  assert.equal(parseSessionLease(`{"sid":"","activeAt":${activeAt}}`), null);
  assert.equal(parseSessionLease(`{"sid":"session-id","activeAt":0}`), null);
  assert.equal(parseSessionLease("{invalid"), null);
  assert.equal(parseSessionLease(null), null);
});
