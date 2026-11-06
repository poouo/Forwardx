import assert from "node:assert/strict";
import test from "node:test";
import { THEME_FIELDS, hostThemeValues } from "./themeFields";
import { themeViewsSchema, themeHostCardExample, themeText, type ThemeNode } from "./themeViews";

test("layout contracts reject unknown bindings, executable properties, excessive nesting and duplicate sections", () => {
  const field = { type: "field", field: "host.cpuUsage", display: "progress" };
  assert.ok(themeViewsSchema.safeParse({ hosts: { card: themeHostCardExample() } }).success);
  for (const card of [
    { ...field, field: "host.agentToken" }, { ...field, field: "__proto__.x" }, { ...field, onclick: "fetch('/api')" },
    { ...field, field: "host.name" }, { ...field, span: 99 }, { ...field, precision: -1 },
    { type: "group", children: [{ ...field, id: "same" }, { ...field, id: "same" }] },
  ]) assert.equal(themeViewsSchema.safeParse({ hosts: { card } }).success, false);
  let nested: ThemeNode = { type: "field", field: "host.name" };
  for (let level = 0; level < 7; level++) nested = { type: "group", children: [nested] };
  assert.equal(themeViewsSchema.safeParse({ hosts: { card: nested } }).success, false);
  const many = { type: "group", children: Array.from({ length: 12 }, () => ({ type: "group", children: Array.from({ length: 12 }, () => ({ type: "field", field: "host.name" })) })) };
  assert.equal(themeViewsSchema.safeParse({ hosts: { card: many } }).success, false);
  assert.equal(themeViewsSchema.safeParse({ hosts: { intro: field } }).success, false);
  assert.equal(themeViewsSchema.safeParse({ login: { beforeForm: { type: "field", field: "fleet.total" } } }).success, false);
  assert.equal(themeViewsSchema.safeParse({ hosts: { sections: ["intro", "summary", "groups", "list", "list"] } }).success, false);
  assert.equal(themeViewsSchema.safeParse({ shell: { sidebarWidth: 20 } }).success, false);
});

test("host models expose only documented fields and distinguish missing samples, zero, unlimited and offline", () => {
  const now = 1_800_000_000_000;
  const host = { id: 7, name: "Example", isOnline: true, agentToken: "secret", sshPassword: "secret", trafficLimit: 1000, trafficMeasureMode: "outbound", stoppedAt: now + 2 * 86_400_000, memoryTotal: 8000 };
  const values = hostThemeValues(host, [{ cpuUsage: 0, load1: 0, memoryUsed: 0, recordedAt: now }], { bytesIn: 200, bytesOut: 500 }, now);
  assert.equal(values["host.cpuUsage"], 0);
  assert.equal(values["host.load1"], 0);
  assert.equal(values["host.diskUsage"], null);
  assert.equal(values["host.trafficUsed"], 500);
  assert.equal(values["host.trafficPercent"], 50);
  assert.equal(values["host.trafficRemaining"], 500);
  assert.equal(values["host.remainingDays"], 2);
  assert.equal(JSON.stringify(values).includes("secret"), false);
  assert.ok(Object.keys(values).every(key => Object.hasOwn(THEME_FIELDS, key)));
  const offline = hostThemeValues({ ...host, isOnline: false }, [{ cpuUsage: 42, networkSpeedIn: 9000 }], null, now);
  assert.equal(offline["host.cpuUsage"], null);
  assert.equal(offline["host.networkInSpeed"], null);
  assert.equal(offline["host.memoryTotal"], 8000);
  const noQuota = hostThemeValues({ ...host, trafficLimit: 0 }, [], { bytesIn: 0, bytesOut: 0 }, now);
  assert.equal(noQuota["host.trafficPercent"], null);
  assert.equal(noQuota["host.trafficRemaining"], null);
  assert.equal(hostThemeValues(host, null, null)["host.trafficUsed"], null);
});

test("network speeds and traffic billing modes preserve the existing units and connection expiry", () => {
  const now = 1_800_000_000_000;
  const host = { isOnline: true, trafficLimit: 100, trafficMeasureMode: "max", connectionStats: { receivedAt: now, stats: { sampledAt: now / 1000, tcp: { status: "ok", total: 3, inUse: 2, timeWait: 1 }, udp: { status: "unavailable" } } } };
  const metrics = [{ recordedAt: now, networkIn: 3000, networkOut: 1500 }, { recordedAt: now - 2000, networkIn: 1000, networkOut: 500 }];
  const values = hostThemeValues(host, metrics, { bytesIn: 20, bytesOut: 70 }, now);
  assert.equal(values["host.networkInSpeed"], 1000);
  assert.equal(values["host.networkOutSpeed"], 500);
  assert.equal(values["host.trafficUsed"], 70);
  assert.equal(values["host.tcpConnections"], 3);
  assert.equal(values["host.tcpInUse"], 2);
  assert.equal(values["host.udpConnections"], null);
  assert.equal(hostThemeValues(host, metrics, null, now + 900_000)["host.tcpConnections"], null);
  assert.equal(hostThemeValues({ ...host, trafficMeasureMode: "both" }, [], { bytesIn: 20, bytesOut: 70 })["host.trafficUsed"], 90);
});

test("theme text honors locale and explicit empty copy", () => {
  assert.equal(themeText({ "zh-CN": "你好", en: "Hello" }, "en"), "Hello");
  assert.equal(themeText({ en: "Hello" }, "zh-CN"), "Hello");
  assert.equal(themeText("", "en", "fallback"), "");
  assert.equal(themeText(undefined, "en", "fallback"), "fallback");
});
