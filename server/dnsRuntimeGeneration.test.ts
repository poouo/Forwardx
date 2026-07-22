import assert from "node:assert/strict";
import test from "node:test";
import { DnsRuntimeGenerationTracker } from "./dnsRuntimeGeneration";

test("DNS runtime generations remain stable between confirmed address changes", () => {
  const tracker = new DnsRuntimeGenerationTracker();
  assert.equal(tracker.generation("tunnel-connect", 7), 0);
  assert.equal(tracker.generation("tunnel-connect", 7, "ddns.example:192.0.2.10"), 1);
  assert.equal(tracker.generation("tunnel-connect", 7), 1);
  assert.equal(tracker.generation("tunnel-connect", 7, "ddns.example:192.0.2.10"), 1);
  assert.equal(tracker.generation("tunnel-connect", 7, "ddns.example:192.0.2.20"), 2);
  assert.equal(tracker.generation("tunnel-connect", 7), 2);
  assert.equal(tracker.generation("tunnel-connect", 8), 0);
});
