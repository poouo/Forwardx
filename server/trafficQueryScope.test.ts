import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("indexed user traffic scope preserves logical ownership, orphan history and explicit global access", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-user-scope-"));
  process.env.DATABASE_TYPE = "sqlite";
  process.env.SQLITE_PATH = path.join(directory, "fixture.db");
  const runtime = await import("./dbRuntime");
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const { scopedTrafficSource, trafficOwnerRuleIdsSql } = await import("./repositories/trafficQueryScope");
  const { getHosts } = await import("./repositories/hostRepository");
  try {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH } });
    await ensureDatabaseSchema();
    await runtime.withSqliteExclusive((sqlite) => {
      const rule = sqlite.prepare(`INSERT INTO forward_rules
        (id, userId, hostId, name, forwardType, sourcePort, targetIp, targetPort, forwardGroupId, forwardGroupRuleId, isForwardGroupTemplate)
        VALUES (?, ?, 1, 'scope-test', 'iptables', ?, '192.0.2.1', 443, ?, ?, ?)`);
      // User 1 is an admin in application terms: own scope must still exclude user 2.
      rule.run(1, 1, 10001, null, null, 0);
      rule.run(2, 2, 10002, null, null, 0);
      rule.run(3, 2, 10003, 10, null, 1);
      rule.run(4, 1, 10004, 10, 3, 0); // physical admin-owned child, logical owner 2
      rule.run(5, 1, 10005, 11, 3, 0); // invalid parent/group mismatch: owner 1
      rule.run(6, 2, 10006, 10, 999, 0); // nonexistent parent: owner 2
      for (let id = 1000; id < 6000; id++) rule.run(id, 3, id + 10000, null, null, 0);
      const raw = sqlite.prepare("INSERT INTO traffic_stats (ruleId,hostId,bytesIn,bytesOut) VALUES (?,1,?,0)");
      const counter = sqlite.prepare("INSERT INTO forward_rule_traffic_counters (ruleId,hostId,userId,bytesIn,bytesOut) VALUES (?,1,?,?,0)");
      for (let id = 1; id <= 6; id++) { raw.run(id, id * 10); counter.run(id, 1, id * 10); }
      for (let id = 1000; id < 6000; id++) counter.run(id, 3, 0);
      counter.run(99, 2, 990); // deleted rule history, retains stored owner
      sqlite.exec(`INSERT INTO hosts (id,name,ip,userId) VALUES (1,'own','192.0.2.1',1),(2,'shared','192.0.2.2',2),(3,'unrelated','192.0.2.3',3)`);
      sqlite.exec("ANALYZE");
    });
    const ruleIds = async (uid: number) => {
      const scope = trafficOwnerRuleIdsSql(uid);
      return (await runtime.queryRaw<{ id: number }>(scope.sql, scope.params)).map((r) => r.id).sort((a, b) => a - b);
    };
    assert.deepEqual(await ruleIds(1), [1, 5]);
    assert.deepEqual(await ruleIds(2), [2, 3, 4, 6]);
    for (const [uid, ids] of [[1, [1, 5]], [2, [2, 3, 4, 6, 99]]] as const) {
      const source = scopedTrafficSource("forward_rule_traffic_counters", "s", uid, true);
      const rows = await runtime.queryRaw<{ ruleId: number }>(`SELECT s.ruleId FROM ${source.sql}`, source.params);
      assert.deepEqual(rows.map((r) => r.ruleId).sort((a, b) => a - b), ids);
      const plan = await runtime.queryRaw<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT s.ruleId FROM ${source.sql}`, source.params);
      const details = plan.map((r) => r.detail).join("\n");
      assert.match(details, /SEARCH scoped USING .*INDEX.*ruleId/i);
      assert.match(details, /SEARCH historical USING .*INDEX.*userId/i);
      assert.doesNotMatch(details, /SCAN (scoped|historical|child)\b/);
    }
    const all = scopedTrafficSource("forward_rule_traffic_counters", "s", undefined, true);
    assert.equal((await runtime.queryRaw(`SELECT * FROM ${all.sql}`, all.params)).length, 5007);
    assert.deepEqual((await getHosts(1)).map((h: { id: number }) => h.id), [1]);
    assert.deepEqual((await getHosts(1, [2])).map((h: { id: number }) => h.id).sort(), [1, 2]);
    assert.equal((await getHosts()).length, 3, "explicit administrative host management remains global");

    await runtime.withSqliteExclusive((sqlite) => {
      sqlite.exec(`INSERT INTO users (id,username,password,role) VALUES (1,'scope-admin','x','admin'),(2,'scope-user','x','user'),(3,'host-only','x','user')`);
      const group = sqlite.prepare("INSERT INTO forward_groups (id,name,groupType,groupMode,targetIp,userId,entryGroupId) VALUES (?,'scope-group','host','port','192.0.2.1',?,?)");
      for (let id = 100; id <= 400; id++) group.run(id, 2, id === 100 ? 101 : id === 101 ? 100 : null);
      group.run(888, 1, null);
      group.run(999, 1, null); // unrelated graph must not be loaded
      sqlite.exec(`INSERT INTO tunnels (id,name,entryHostId,exitHostId,mode,listenPort,userId,exitGroupId)
        VALUES (7,'scoped-tunnel',1,2,'tls',24007,1,888);
        INSERT INTO forward_group_members (groupId,memberType,tunnelId,isEnabled) VALUES (100,'tunnel',7,1);
        INSERT INTO tunnel_hops (tunnelId,hostId,seq) VALUES (7,3,0);`);
    });
    const access = await import("./linkAccessView");
    const statements: string[] = [];
    let restore = () => {};
    await runtime.withSqliteExclusive((sqlite) => {
      const prepare = sqlite.prepare;
      sqlite.prepare = ((sql: string) => { statements.push(sql); return prepare.call(sqlite, sql); }) as typeof prepare;
      restore = () => { sqlite.prepare = prepare; };
    });
    try {
      access.clearLinkAccessScopeCache();
      const graph = await access.getLinkAccessScope({ id: 2, role: "user" });
      assert.equal(graph?.groupIds.size, 302, "all 301 owned groups plus the reachable tunnel exit group");
      assert.equal(graph?.groupIds.has(999), false);
      assert.equal(graph?.groupTunnelIds?.get(100)?.has(7), true);
      assert.equal(graph?.groupHostIds?.get(100)?.has(3), true);
      assert.equal(graph?.useTunnelIds?.has(7), false, "shared-group reachability must not grant direct tunnel use");
      for (const sql of statements.filter((sql) => /from "(?:forward_groups|forward_group_members|tunnels|tunnel_hops|tunnel_exit_nodes)"/i.test(sql))) {
        assert.match(sql, /\bwhere\b/i, `topology queries must be scoped: ${sql}`);
      }
      statements.length = 0;
      await access.getLinkAccessScope({ id: 3, role: "user" });
      assert.equal(statements.some((sql) => /from "(?:forward_group_members|tunnel_hops|tunnel_exit_nodes)"/i.test(sql)), false,
        "a host-only user must not query topology membership/history tables");
    } finally { restore(); access.clearLinkAccessScopeCache(); }
    const { dashboardSummaries, operationsSummaries } = await import("./backgroundSummaryCache");
    await dashboardSummaries.get("1:stats", async () => ({ total: 1 }));
    await operationsSummaries.get("1:finance:all", async () => ({ total: 2 }));
    await runtime.closeDatabase();
    assert.equal(dashboardSummaries.size().entries, 0, "reconnecting cannot reuse another database's user IDs");
    assert.equal(operationsSummaries.size().entries, 0);
  } finally {
    await runtime.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
