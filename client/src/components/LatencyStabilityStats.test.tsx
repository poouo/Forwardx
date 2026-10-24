import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { LatencyStabilityStats } from "./LatencyStabilityStats";
import { getLatencyStabilityStats } from "../lib/latencyChart";

test("legacy health rows show latency without claiming accurate loss or serious unavailability", () => {
  const stats = getLatencyStabilityStats([{ latency: 8, probeCount: 3, probeSuccesses: 2 }], null);
  const html = renderToStaticMarkup(<LatencyStabilityStats stats={stats} failureLabel="TCP 连接失败率" counterStatistics={null} />);
  assert.match(html, /8 ms/);
  assert.match(html, /TCP 连接失败率/);
  assert.match(html, /请升级 Agent/);
  assert.doesNotMatch(html, /33\.33%|严重不可用|探测严重异常|10\/100/);
});

test("cumulative summary clearly labels independent per-hop probes and latest report coverage", () => {
  const counters = { total: 3000, successes: 2997, available: true, observedSince: new Date(), latestAt: new Date() };
  const stats = getLatencyStabilityStats([{ latency: 8 }], counters);
  const html = renderToStaticMarkup(<LatencyStabilityStats stats={stats} sampleLabel="逐跳探测次数"
    failureLabel="逐跳探测失败率" counterStatistics={counters} description="不是端到端业务丢包" />);
  assert.match(html, /3000/);
  assert.match(html, /0\.10%/);
  assert.match(html, /逐跳探测失败率/);
  assert.match(html, /不是端到端业务丢包/);
  assert.match(html, /截至/);
});

test("uniform Ping services keep the explicit Ping loss label", () => {
  const stats = getLatencyStabilityStats([{ latency: 8, probeCount: 5, probeSuccesses: 4 }]);
  const html = renderToStaticMarkup(<LatencyStabilityStats stats={stats} failureLabel="Ping 丢包率" />);
  assert.match(html, /Ping 丢包率/);
  assert.match(html, /20\.00%/);
  assert.doesNotMatch(html, /请升级 Agent/);
});

test("latency cards adapt to their width and retain complete values in native apps", () => {
  const stats = getLatencyStabilityStats([{ latency: 12345.67, probeCount: 570000, probeSuccesses: 570000 }]);
  const html = renderToStaticMarkup(<LatencyStabilityStats stats={stats} />);
  assert.match(html, /grid-cols-\[repeat\(auto-fit,minmax\(min\(100%,6\.5rem\),1fr\)\)\]/);
  assert.match(html, /570000/);
  assert.match(html, /12345\.67 ms/);
  assert.doesNotMatch(html, /truncate|text-ellipsis|line-clamp/);
  const css = readFileSync("client/src/index.css", "utf8");
  assert.doesNotMatch(css, /html\.capacitor-native \[data-latency-stats="true"\]/);
});
