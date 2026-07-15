import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("latency series resolve direct rules, active forward-group children, tunnels, chains, and services", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-latency-series-"));
  const databasePath = path.join(directory, "latency.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const metrics = await import(moduleUrl("server/repositories/metricsRepository.ts"));
    const probes = await import(moduleUrl("server/repositories/hostProbeServiceRepository.ts"));

    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await schema.ensureDatabaseSchema();

    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      const placeholders = values.map(() => "?").join(", ");
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + placeholders + ")",
        values,
      );
    };
    const now = Math.floor(Date.now() / 1000);
    const since = new Date((now - 600) * 1000);

    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled", "activeMemberId"], [10, "failover", "host", "failover", "0.0.0.0", 1, 1, 102]);
    await insert("forward_groups", ["id", "name", "groupType", "groupMode", "targetIp", "userId", "isEnabled"], [20, "chain", "host", "chain", "0.0.0.0", 1, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [101, 10, "host", 1, 0, 1]);
    await insert("forward_group_members", ["id", "groupId", "memberType", "hostId", "priority", "isEnabled"], [102, 10, "host", 2, 1, 1]);

    const ruleColumns = ["id", "hostId", "name", "forwardType", "protocol", "forwardGroupId", "forwardGroupRuleId", "forwardGroupMemberId", "isForwardGroupTemplate", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning"];
    await insert("forward_rules", ruleColumns, [100, 1, "template", "iptables", "tcp", 10, null, null, 1, 10000, "example.test", 443, 1, 1, 1]);
    await insert("forward_rules", ruleColumns, [110, 1, "child-1", "iptables", "tcp", 10, 100, 101, 0, 10000, "example.test", 443, 1, 1, 1]);
    await insert("forward_rules", ruleColumns, [120, 2, "child-2", "iptables", "tcp", 10, 100, 102, 0, 10000, "example.test", 443, 1, 1, 1]);
    await insert("forward_rules", ruleColumns, [130, 1, "direct", "iptables", "tcp", null, null, null, 0, 10001, "example.test", 443, 1, 1, 1]);

    await insert("tcping_stats", ["ruleId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [110, 1, 11, 0, now - 120]);
    await insert("tcping_stats", ["ruleId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [120, 2, 42, 0, now - 90]);
    await insert("tcping_stats", ["ruleId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [130, 1, 33, 0, now - 60]);
    await insert("tunnel_latency_stats", ["tunnelId", "latencyMs", "isTimeout", "recordedAt"], [30, 55, 0, now - 50]);
    await insert("forward_group_latency_stats", ["groupId", "latencyMs", "isTimeout", "recordedAt"], [20, 66, 0, now - 40]);
    await insert("host_probe_service_stats", ["serviceId", "hostId", "latencyMs", "isTimeout", "recordedAt"], [40, 1, 77, 0, now - 30]);

    const activeSeries = await metrics.getTcpingSeriesByRule(100, { since });
    assert.deepEqual(activeSeries.map((item) => item.latencyMs), [42]);

    await runtime.executeRaw('UPDATE "forward_groups" SET "activeMemberId" = NULL WHERE "id" = 10');
    const priorityFallbackSeries = await metrics.getTcpingSeriesByRule(100, { since });
    assert.deepEqual(priorityFallbackSeries.map((item) => item.latencyMs), [11]);

    const directSeries = await metrics.getTcpingSeriesByRule(130, { since });
    assert.deepEqual(directSeries.map((item) => item.latencyMs), [33]);
    const tunnelSeries = await metrics.getTunnelLatencySeries(30, { since });
    assert.deepEqual(tunnelSeries.map((item) => item.latencyMs), [55]);
    const chainSeries = await metrics.getForwardGroupLatencySeries(20, { since });
    assert.deepEqual(chainSeries.map((item) => item.latencyMs), [66]);
    const serviceSeries = await probes.getHostProbeServiceSeries({ serviceIds: [40], hostId: 1, hours: 1 });
    assert.deepEqual(serviceSeries.map((item) => item.latencyMs), [77]);

    await runtime.closeDatabase();
  `;

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: databasePath,
        FORWARDX_LOG_DIR: path.join(directory, "logs"),
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
