import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeSessionLease,
  isSessionLeaseOwnedByAnother,
  parseSessionLease,
  SESSION_ACTIVE_LEASE_TTL_MS,
} from "./session";

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

test("session lease blocks only another currently active device", () => {
  const now = 1_725_000_000_000;
  const active = parseSessionLease(encodeSessionLease("device-a", now - 1_000));
  assert.equal(isSessionLeaseOwnedByAnother(active, "device-a", now), false);
  assert.equal(isSessionLeaseOwnedByAnother(active, "device-b", now), true);

  const stale = parseSessionLease(encodeSessionLease("device-a", now - SESSION_ACTIVE_LEASE_TTL_MS - 1));
  assert.equal(isSessionLeaseOwnedByAnother(stale, "device-b", now), false);
});
