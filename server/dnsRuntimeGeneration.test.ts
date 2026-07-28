import assert from "node:assert/strict";
import test from "node:test";
import { DnsRuntimeGenerationTracker } from "./dnsRuntimeGeneration";
import { selectResolvedTargetIp } from "./dnsTargetResolution";

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

test("DNS target resolution uses a newly resolved address instead of the cached address", () => {
  assert.equal(selectResolvedTargetIp(
    "edge.example.com",
    "192.0.2.20",
    { raw: "edge.example.com", ip: "192.0.2.10" },
  ), "192.0.2.20");
});

test("DNS target resolution keeps the last known good IPv4 address on failure", () => {
  assert.equal(selectResolvedTargetIp(
    "edge.example.com",
    "edge.example.com",
    { raw: "EDGE.EXAMPLE.COM.", ip: "192.0.2.10" },
  ), "192.0.2.10");
});

test("DNS target resolution keeps the last known good IPv6 address on failure", () => {
  assert.equal(selectResolvedTargetIp(
    "edge.example.com",
    "edge.example.com",
    { raw: "edge.example.com", ip: "2001:db8::10" },
  ), "2001:db8::10");
});

test("DNS target resolution does not reuse an address from a different hostname", () => {
  assert.equal(selectResolvedTargetIp(
    "new.example.com",
    "new.example.com",
    { raw: "old.example.com", ip: "192.0.2.10" },
  ), "new.example.com");
});

test("DNS target resolution returns the hostname without a valid cached address", () => {
  assert.equal(selectResolvedTargetIp(
    "edge.example.com",
    "edge.example.com",
    { raw: "edge.example.com", ip: "edge.example.com" },
  ), "edge.example.com");
});
