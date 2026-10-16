import assert from "node:assert/strict";
import test from "node:test";
import { FORWARDX_VERSIONS, normalizeForwardXVersion } from "./forwardTypes";

test("keeps every supported ForwardX version", () => {
  assert.deepEqual([...FORWARDX_VERSIONS], ["v1", "v2", "v3"]);
  for (const version of ["v1", "v2", "v3"] as const) {
    assert.equal(normalizeForwardXVersion(version), version);
  }
});

test("normalizes case and whitespace without downgrading V3", () => {
  assert.equal(normalizeForwardXVersion(" V3 "), "v3");
  assert.equal(normalizeForwardXVersion("V2"), "v2");
});

test("still downgrades unknown versions to V1", () => {
  assert.equal(normalizeForwardXVersion("v4"), "v1");
  assert.equal(normalizeForwardXVersion(""), "v1");
  assert.equal(normalizeForwardXVersion(null), "v1");
  assert.equal(normalizeForwardXVersion(undefined), "v1");
  assert.equal(normalizeForwardXVersion({ version: "v3" }), "v1");
});
