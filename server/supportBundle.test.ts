import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordAgentConnectionStats, getAgentConnectionStats } from "./agentConnectionStats";

// Never read the developer's database/config when exporting a test support bundle.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-support-bundle-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "panel.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");

const { AGENT_TUNNEL_PATHS } = await import("./agentEncryptionMiddleware");
const { createSupportBundleTask, getSupportBundleTask, redactSupportValue } = await import("./supportBundle");
const runtime = await import("./dbRuntime");
const schema = await import("./dbSchema");
before(async () => {
  await runtime.connectDatabase();
  await schema.ensureDatabaseSchema();
});
after(async () => {
  await runtime.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("Agent support and migration reports are accepted through the encrypted sync tunnel", () => {
  assert.equal(AGENT_TUNNEL_PATHS.has("/api/agent/support-bundle-result"), true);
  assert.equal(AGENT_TUNNEL_PATHS.has("/api/agent/migration-rollback"), true);
});

test("support bundle redaction removes nested credentials", () => {
  const value = redactSupportValue({ token: "abc", nested: { password: "def", message: "token=ghi" } });
  assert.deepEqual(value, { token: "[REDACTED]", nested: { password: "[REDACTED]", message: "token=[REDACTED]" } });
});

test("support bundle completes immediately for offline Agents", async () => {
  const task = createSupportBundleTask([{ id: 9, name: "offline", isOnline: false, agentToken: "hidden" }]);
  const status = await getSupportBundleTask(task.taskId);
  assert.equal(status?.complete, true);
  assert.equal(status?.hosts[0]?.status, "offline");
  assert.ok(status?.download?.content.includes("forwardx-support-bundle-v1"));
  assert.ok(!status?.download?.content.includes("hidden"));
});

const connectionFixture = (now: number) => ({
  version: 1, scope: "network-namespace", source: "proc-sockstat", sampledAt: Math.floor(now / 1000),
  tcp: { status: "ok", total: 14, inUse: 7, timeWait: 7, ipv6Included: true },
  udp: { status: "ok", total: 7, inUse: 7, ipv6Included: true },
});

test("connection reports retain current totals without counting unknown values as zero", () => {
  const now = Date.now();
  const report = connectionFixture(now);
  assert.equal(recordAgentConnectionStats(501, report, now), true);
  report.tcp.total = 123;
  const saved = getAgentConnectionStats(501, now)!;
  assert.equal(saved.stats.tcp.total, 14);
  saved.stats.tcp.total = 456;
  assert.equal(getAgentConnectionStats(501, now)?.stats.tcp.total, 14);
  assert.equal(recordAgentConnectionStats(501, { ...connectionFixture(now), tcp: { status: "unavailable", reason: "permission-denied", ipv6Included: false, total: 999 } }, now + 1000), true);
  assert.equal(getAgentConnectionStats(501, now + 1000)?.stats.tcp.total, undefined);
  assert.equal(getAgentConnectionStats(501, now + 1000)?.stats.udp.total, 7);
  assert.equal(getAgentConnectionStats(501, now + 16 * 60_000), null);
});

test("connection ingress rejects malformed, stale and inconsistent reports", () => {
  const now = Date.now();
  const report = connectionFixture(now);
  for (const invalid of [
    null, {}, { ...report, version: 2 }, { ...report, scope: "host" },
    { ...report, sampledAt: report.sampledAt - 1000 }, { ...report, sampledAt: report.sampledAt + 120 },
    { ...report, tcp: { ...report.tcp, total: 15 } }, { ...report, tcp: { ...report.tcp, timeWait: -1 } },
    { ...report, udp: { ...report.udp, total: "7" } }, { ...report, udp: { ...report.udp, total: Number.MAX_SAFE_INTEGER + 1 } },
    { ...report, udp: { status: "unavailable", reason: "arbitrary-text", ipv6Included: false } },
  ]) assert.equal(recordAgentConnectionStats(502, invalid, now), false);
  assert.equal(recordAgentConnectionStats(-1, report, now), false);
  assert.equal(recordAgentConnectionStats(502, report, now), true);
  assert.equal(recordAgentConnectionStats(502, { ...report, sampledAt: report.sampledAt - 1 }, now), false);
});

test("connection snapshots have a hard capacity bound", () => {
  const now = Date.now();
  for (let id = 10000; id <= 15000; id++) assert.equal(recordAgentConnectionStats(id, connectionFixture(now), now), true);
  assert.equal(getAgentConnectionStats(10000, now), null);
  assert.ok(getAgentConnectionStats(15000, now));
});

test("support exports include the last received connection snapshot without historical writes", async () => {
  const now = Date.now();
  assert.equal(recordAgentConnectionStats(503, connectionFixture(now), now), true);
  const task = createSupportBundleTask([{ id: 503, name: "socket-report", isOnline: false }]);
  const status = await getSupportBundleTask(task.taskId);
  const exported = JSON.parse(status!.download!.content);
  assert.match(status!.download!.content, /"connectionStats"/);
  assert.ok(exported);
  assert.match(status!.download!.content, /"timeWait": 7/);
});
