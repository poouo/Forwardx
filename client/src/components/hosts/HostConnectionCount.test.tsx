import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import type { HostConnectionStats, HostSocketCount } from "@shared/hostConnections";
import HostConnectionCount from "./HostConnectionCount";

const now = 1_700_000_000_000;
const stats: HostConnectionStats = {
  version: 1, scope: "network-namespace", source: "proc-sockstat", sampledAt: now / 1000,
  tcp: { status: "ok", total: 12345, inUse: 12000, timeWait: 345, ipv6Included: true },
  udp: { status: "ok", total: 0, inUse: 0, ipv6Included: true },
};
const snapshot = { stats, receivedAt: now };
const render = (props: Partial<Parameters<typeof HostConnectionCount>[0]> = {}) =>
  renderToStaticMarkup(<HostConnectionCount protocol="tcp" isOnline now={now} snapshot={snapshot} {...props} />);

test("connection cells display exact totals, including a real UDP zero, with sample definitions", () => {
  const tcp = render();
  assert.match(tcp, />12,345<\/span>/);
  assert.match(tcp, /12,000/);
  assert.match(tcp, /TIME_WAIT/);
  assert.match(tcp, /IPv4 \/ IPv6/);
  assert.match(tcp, /采样时间/);
  assert.match(render({ protocol: "udp" }), />0<\/span>/);
  assert.match(render({ protocol: "udp" }), /不代表远端客户端数量/);
});

test("offline, absent and expired reports never look like live zero connections", () => {
  for (const props of [
    { isOnline: false }, { snapshot: null }, { snapshot: undefined },
    { now: now + 15 * 60_000 },
    { snapshot: { ...snapshot, stats: { ...stats, sampledAt: stats.sampledAt - 901 } } },
    { snapshot: { ...snapshot, receivedAt: now - 901_000 } },
  ]) assert.match(render(props), />—<\/span>/);
  assert.match(render({ isOnline: false }), /主机离线/);
  assert.match(render({ snapshot: null }), /Agent 已更新/);
  assert.match(render({ now: now + 900_000 }), /已过期/);
});

test("unavailable counters show a localized reason while the other protocol still works", () => {
  for (const reason of ["unsupported-platform", "permission-denied", "summary-missing", "summary-unreadable", "summary-invalid", "ipv6-summary-missing"] as const) {
    const sample = { ...snapshot, stats: { ...stats, tcp: { status: "unavailable", reason, ipv6Included: false } as HostSocketCount } };
    const html = render({ snapshot: sample });
    assert.match(html, />—<\/span>/);
    assert.doesNotMatch(html, new RegExp(reason));
    assert.match(render({ snapshot: sample, protocol: "udp" }), />0<\/span>/);
  }
});

test("connection cells and all failure reasons support English without Chinese fallback", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en"); await initializeLanguage();
    assert.match(render(), /TCP total: 12,345/);
    assert.match(render({ protocol: "udp" }), /UDP sockets: 0/);
    for (const html of [render(), render({ protocol: "udp" }), render({ isOnline: false }), render({ snapshot: null }), render({ now: now + 900_000 }),
      ...["unsupported-platform", "permission-denied", "summary-missing", "summary-unreadable", "summary-invalid", "ipv6-summary-missing"].map(reason => render({ snapshot: { ...snapshot, stats: { ...stats, tcp: { status: "unavailable", ipv6Included: false, reason: reason as HostSocketCount["reason"] } } } })),
    ]) assert.doesNotMatch(html, /\p{Script=Han}/u);
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("both host connection columns use the shared counter component and existing status refresh", () => {
  const page = readFileSync("client/src/pages/Hosts.tsx", "utf8");
  assert.match(page, /case "tcpConnections": return <HostConnectionCount snapshot=\{host.connectionStats\} protocol="tcp"/);
  assert.match(page, /case "udpConnections": return <HostConnectionCount snapshot=\{host.connectionStats\} protocol="udp"/);
  assert.match(page, /return status \? \{ \.\.\.host, \.\.\.status \} : host/);
});
