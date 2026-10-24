import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { advanceResourceAlert, resourceAlertPolicySchema, resourceAlertIncludesHost, resourceAlertServiceSchema } from "../shared/operationsMonitor";
import { networkTestSummary } from "../shared/networkTestSummary";
import { preciseQuery } from "./ai/preciseQuery";
import { trafficQuerySchema, trafficRange } from "./ai/analytics";
import { mcpInputSchema, mcpTools } from "./mcpRoutes";
import { PANEL_TOOLS } from "./ai/panelTools";

test("precise questions preserve requested top N and never guess counts from a resource list", () => {
  assert.deepEqual(preciseQuery("当前有几个用户"), { intent: "panel_query", tool: "users.summary", input: {} });
  assert.equal(preciseQuery("当前流量排行前三个")?.input.limit, 3);
  assert.equal(preciseQuery("最近7天规则流量前五个")?.input.entity, "rules");
  assert.equal(preciseQuery("我的流量排行前三个")?.input.scope, "self");
  for (const text of ["删除流量排行前三个用户", "张三有几个用户", "用户当前在线有几个", "用户本月流量前三个", "规则流量前四十个", "主机2流量前三个"]) assert.equal(preciseQuery(text), null, text);
});
test("traffic time ranges use Beijing calendar days and reject missing custom dates", () => {
  const now = Date.parse("2026-10-19T01:00:00+08:00");
  const value = trafficRange(trafficQuerySchema.parse({ period: "7d" }), now);
  assert.equal(value.end - value.start, 7 * 86400);
  assert.equal(value.from, "2026-10-13"); assert.equal(value.to, "2026-10-19");
  assert.throws(() => trafficRange(trafficQuerySchema.parse({ period: "custom" })), /日期/);
  assert.throws(() => trafficRange(trafficQuerySchema.parse({ period: "today", from: "2026-10-10" })), /日期/);
});
test("resource alerts require sustained samples and hysteresis, not transient spikes or monitoring gaps", () => {
  let state = advanceResourceAlert(null, 95, 90, 1000, 60, 30).state;
  assert.equal(state?.phase, "pending");
  assert.equal(advanceResourceAlert(state, 89, 90, 1030, 60, 30).state, null);
  state = advanceResourceAlert(state, 95, 90, 1030, 60, 30).state;
  let next = advanceResourceAlert(state, 95, 90, 1060, 60, 30);
  assert.equal(next.event, "triggered");
  next = advanceResourceAlert(next.state, 88, 90, 1090, 60, 30);
  assert.equal(next.state?.phase, "active");
  next = advanceResourceAlert(next.state, 80, 90, 1120, 60, 30);
  assert.equal(next.state?.phase, "recovering");
  assert.equal(advanceResourceAlert(next.state, 80, 90, 1150, 60, 30).event, "recovered");
  assert.equal(advanceResourceAlert(state, 95, 90, 2000, 60, 30).state?.since, 2000);
  assert.equal(advanceResourceAlert(next.state, 80, 90, 2000, 60, 30).event, undefined);
});
test("resource alert scope validates specific hosts and dynamically includes all/excluded host sets", () => {
  const all = resourceAlertPolicySchema.parse({ settings: { enabled: true } });
  assert.equal(resourceAlertIncludesHost(all, 999), true);
  const specific = resourceAlertPolicySchema.parse({ hostScope: "specific", hostIds: [1, 2, 2] });
  assert.deepEqual(specific.hostIds, [1, 2]);
  assert.equal(resourceAlertIncludesHost(specific, 1), true);
  assert.equal(resourceAlertIncludesHost(specific, 999), false);
  const exclude = resourceAlertPolicySchema.parse({ hostScope: "exclude", excludeHostIds: [2] });
  assert.equal(resourceAlertIncludesHost(exclude, 1), true);
  assert.equal(resourceAlertIncludesHost(exclude, 2), false);
  assert.equal(resourceAlertIncludesHost(exclude, 999), true);
  assert.throws(() => resourceAlertPolicySchema.parse({ hostScope: "specific" }), /请选择/);
  assert.throws(() => resourceAlertPolicySchema.parse({ hostScope: "invalid" }));
});
test("network summaries preserve unknown hops and do not equate intermediate nonresponse with destination loss", () => {
  const ping = networkTestSummary("ping", "4 packets transmitted, 3 received, 25% packet loss\nrtt min/avg/max/mdev = 1.00/2.00/3.00/0.50 ms");
  assert.equal(ping.lossPercent, 25); assert.equal(ping.avgMs, 2); assert.equal(ping.jitterMs, 0.5);
  const trace = networkTestSummary("traceroute", "traceroute to example.com\n 1 * * *\n 2 192.0.2.1 10.1 ms 10.3 ms 10.2 ms");
  assert.equal(trace.hops.length, 2); assert.equal(trace.hops[0].timedOut, true); assert.equal(trace.lossPercent, undefined);
  const mtr = networkTestSummary("mtr", " 1.|-- ??? 100.0% 10 0.0 0.0 0.0 0.0 0.0\n 2.|-- 192.0.2.1 0.0% 10 10.0 11.0 9.0 12.0 1.0");
  assert.equal(mtr.hops[1].avgMs, 11);
  assert.deepEqual(networkTestSummary("ping", "unknown output"), { hops: [] });
});
test("each resource alert service validates exactly one metric and its independent threshold", () => {
  for (const metric of ["cpu", "memory", "disk"]) {
    const service = resourceAlertServiceSchema.parse({ name: "Alert", metric, threshold: 85, hostScope: "exclude", excludeHostIds: [2, 2] });
    assert.equal(service.metric, metric);
    assert.equal(service.threshold, 85);
    assert.deepEqual(service.excludeHostIds, [2]);
    assert.equal(resourceAlertIncludesHost(service, 2), false);
    assert.equal(resourceAlertIncludesHost(service, 3), true);
  }
  for (const input of [
    { name: "Alert", metric: "network" }, { name: "Alert", metric: "cpu", threshold: 0 },
    { name: "Alert", metric: "cpu", threshold: 101 }, { name: " ", metric: "cpu" },
    { name: "Alert", metric: "cpu", memory: 80 }, { name: "Alert", metric: "cpu", notifyUserId: 2 },
    { name: "Alert", metric: "cpu", hostScope: "specific", hostIds: [] },
  ]) assert.equal(resourceAlertServiceSchema.safeParse(input).success, false);
});
test("MCP exposes executable JSON schemas for read tools only and follows role restrictions", () => {
  assert.ok(mcpTools("admin").some(tool => tool.name === "traffic.rank"));
  assert.deepEqual(mcpTools("user"), []);
  for (const role of ["user", "admin"]) for (const tool of mcpTools(role)) {
    assert.equal(PANEL_TOOLS[tool.name as keyof typeof PANEL_TOOLS].mode, "read");
    assert.equal(tool.inputSchema.type, "object"); assert.equal(tool.annotations.readOnlyHint, true);
  }
  assert.deepEqual(mcpInputSchema(PANEL_TOOLS["traffic.rank"].schema).properties.limit.maximum, 30);
});

test("MCP entry belongs to admin AI settings, not the user profile", () => {
  const settings = fs.readFileSync("client/src/pages/Settings.tsx", "utf8");
  const aiSection = settings.slice(settings.indexOf("function DeepSeekSettingsCard()"), settings.indexOf("type SystemSettingsSaveKey"));
  assert.match(aiSection, /<McpAccessCard\s*\/>/);
  assert.doesNotMatch(fs.readFileSync("client/src/pages/Profile.tsx", "utf8"), /McpAccessCard/);
});
test("real SQLite analytics, alert lifecycle and authenticated HTTP MCP integration", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-observability-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/observability.fixture.ts"], { cwd: process.cwd(), encoding: "utf8", timeout: 90000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"), FORWARDX_LOG_DIR: path.join(directory, "logs"), JWT_SECRET: "observability-test-secret-only-32-characters", TELEGRAM_BOT_TOKEN: "", DISCORD_BOT_TOKEN: "" } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
