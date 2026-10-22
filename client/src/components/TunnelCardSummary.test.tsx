import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TunnelCardLatency, TunnelCardRoute, TunnelLatencyDetails, type TunnelLatencyItem } from "./TunnelCardSummary";

const item = (key: string, latencyMs: number | null, isTimeout = false): TunnelLatencyItem => ({ key, label: `route-${key}`, latencyMs, isTimeout });

test("single, multi-path and untested latency cards have the same bounded summary row", () => {
  for (const items of [[], [item("total", 8)], [item("total", 10), ...Array.from({ length: 50 }, (_, i) => item(`hop-${i}`, i))]]) {
    const html = renderToStaticMarkup(<TunnelCardLatency items={items} />);
    assert.match(html, /data-tunnel-card-latency="" class="flex h-8 /);
    assert.doesNotMatch(html, /route-hop-/);
    assert.equal((html.match(/aria-label="延迟明细"/g) || []).length, items.length > 1 ? 1 : 0);
  }
});

test("missing totals show individual/range latency without inventing an aggregate or hiding timeouts", () => {
  assert.match(renderToStaticMarkup(<TunnelCardLatency items={[item("hop", 8)]} />), />8ms</);
  const mixed = renderToStaticMarkup(<TunnelCardLatency items={[item("a", 8), item("b", 20), item("c", null, true)]} />);
  assert.match(mixed, />8–20ms</);
  assert.match(mixed, /aria-label="1 项超时"/);
  assert.match(mixed, /3 条明细/);
  assert.match(renderToStaticMarkup(<TunnelCardLatency items={[item("a", null, true), item("b", null, true)]} />), /超时/);
  assert.match(renderToStaticMarkup(<TunnelCardLatency items={[]} />), /未测试/);
});

test("popover details retain every route, unknown value and timeout", () => {
  const html = renderToStaticMarkup(<TunnelLatencyDetails items={[item("total", 10), item("one", 6), item("two", null, true), item("unknown", null)]} />);
  for (const key of ["total", "one", "two", "unknown"]) assert.match(html, new RegExp(`route-${key}`));
  assert.match(html, /超时/);
  assert.match(html, /暂无数据/);
  assert.match(html, />6ms</);
});

test("route summaries use one compact line with the protocol and open a real dialog", () => {
  const html = renderToStaticMarkup(<TunnelCardRoute summary="entry → 3 exits" name="Example" mode="GOST TLS">full route</TunnelCardRoute>);
  assert.match(html, /class="flex h-10 w-full /);
  assert.match(html, /truncate/);
  assert.match(html, /GOST TLS/);
  assert.doesNotMatch(html, /full route|line-clamp-2/);
  assert.match(html, /aria-haspopup="dialog"/);
  const source = readFileSync("client/src/pages/Tunnels.tsx", "utf8");
  assert.equal((source.match(/<TunnelCardLatency items=/g) || []).length, 2);
  assert.equal((source.match(/<TunnelCardRoute summary=/g) || []).length, 2);
});
