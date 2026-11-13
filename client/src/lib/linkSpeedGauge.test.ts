import assert from "node:assert/strict";
import test from "node:test";
import { gaugeFraction, gaugeStopLabel, gaugeStops, peakOfSamples } from "./linkSpeedGauge";

test("gauge scale gives low speeds room and clamps out-of-range values", () => {
  const stops = gaugeStops(300);
  assert.deepEqual(stops, [0, 5, 10, 50, 100, 250, 500, 1000]);
  assert.equal(gaugeFraction(0, stops), 0);
  assert.equal(gaugeFraction(-3, stops), 0);
  assert.equal(gaugeFraction(undefined, stops), 0);
  assert.equal(gaugeFraction(5, stops), 1 / 7);
  assert.equal(gaugeFraction(75, stops), 3.5 / 7);
  assert.equal(gaugeFraction(1000, stops), 1);
  assert.equal(gaugeFraction(4000, stops), 1);
});

test("gauge switches to the wide scale above 1 Gbps", () => {
  const stops = gaugeStops(2400);
  assert.equal(stops.at(-1), 10000);
  assert.equal(gaugeFraction(1000, stops), 5 / 8);
  assert.deepEqual([500, 1000, 2500].map(gaugeStopLabel), ["500", "1G", "2.5G"]);
});

test("peak is tracked per direction", () => {
  const samples = [
    { direction: "upload" as const, elapsedMs: 500, bytes: 1, mbps: 40 },
    { direction: "upload" as const, elapsedMs: 1000, bytes: 1, mbps: 62 },
    { direction: "download" as const, elapsedMs: 500, bytes: 1, mbps: 91 },
  ];
  assert.equal(peakOfSamples(samples, "upload"), 62);
  assert.equal(peakOfSamples(samples, "download"), 91);
  assert.equal(peakOfSamples([], "download"), 0);
});
