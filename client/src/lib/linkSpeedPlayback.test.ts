import assert from "node:assert/strict";
import test from "node:test";
import type { LinkSpeedSample, LinkSpeedStatus } from "../../../shared/linkSpeed";
import { LinkSpeedPlayback } from "./linkSpeedPlayback";

const points = (n: number, direction: "upload" | "download" = "upload"): LinkSpeedSample[] =>
  Array.from({ length: n }, (_, i) => ({ direction, elapsedMs: (i + 1) * 100, bytes: (i + 1) * 1000, mbps: i + 1 }));
const job = (samples: LinkSpeedSample[], state = "upload", id = "one") =>
  ({ id, samples, state } as LinkSpeedStatus);

test("plays each measured point in a batch, without replaying repeated polls", () => {
  const p = new LinkSpeedPlayback();
  const s = job(points(5));
  p.receive(s, 0);
  assert.equal(p.count, 0);
  p.advance(100); assert.equal(p.count, 1);
  p.receive(s, 200); assert.equal(p.count, 2);
  p.advance(400); assert.equal(p.count, 4);
  p.advance(500); assert.equal(p.count, 5);
  assert.equal(p.pending, false);
  p.receive(job(points(10)), 500);
  p.advance(600); assert.equal(p.count, 6);
  p.advance(1000); assert.equal(p.count, 10);
});

test("phase reset uses a short transition and completion drains its tail", () => {
  const p = new LinkSpeedPlayback();
  p.receive(job(points(5)), 0); p.advance(500);
  const samples = [...points(5), ...points(5, "download")];
  p.receive(job(samples, "completed"), 500);
  p.advance(600); assert.equal(p.count, 6);
  assert.equal(samples[p.count - 1].direction, "download");
  p.advance(1000); assert.equal(p.count, 10);
  assert.equal(p.pending, false);
});

test("bounds backlog on reopen/stall and flushes for cancellation/reduced motion", () => {
  const p = new LinkSpeedPlayback();
  p.receive(job(points(300)), 1000);
  assert.ok(p.count >= 294);
  p.advance(1600); assert.equal(p.count, 300);
  p.receive(job(points(305)), 1700);
  p.receive(job(points(305), "cancelled"), 1701);
  assert.equal(p.count, 305); assert.equal(p.pending, false);
  p.receive(job(points(310)), 1800, false);
  assert.equal(p.count, 310); assert.equal(p.pending, false);
  p.receive(job(points(5), "upload", "two"), 1900);
  assert.equal(p.count, 0);
  p.receive(job(points(5), "completed", "three"), 2000);
  assert.equal(p.count, 5); assert.equal(p.pending, false);
});
