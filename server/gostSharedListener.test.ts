import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("shared GOST endpoints support many rules in one NAT slot, migration and endpoint changes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-gost-shared-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const load = file => import(pathToFileURL(path.join(process.cwd(), file)).href);
    const runtime = await load("server/dbRuntime.ts");
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await (await load("server/dbSchema.ts")).ensureDatabaseSchema();
      const repo = await load("server/repositories/tunnelRepository.ts");
      const { rulesRouter } = await load("server/routers/rules.ts");
      const insert = async (table, row) => runtime.executeRaw(
        'INSERT INTO "'+table+'" ('+Object.keys(row).map(k=>'"'+k+'"').join(',')+') VALUES ('+Object.keys(row).map(()=>'?').join(',')+')', Object.values(row));
      await insert("users", { id: 1, username: "audit", password: "audit-test", name: "audit", role: "admin" });
      for (const [id, port] of [[1,0],[2,24000],[3,24001]]) await insert("hosts", {
        id, name: "host-"+id, ip: "192.0.2."+id, userId: 1,
        portRangeStart: port || null, portRangeEnd: port || null,
      });
      await insert("tunnels", { id: 1, name: "shared", mode: "tls", entryHostId: 1, exitHostId: 2, listenPort: 24000, userId: 1, loadBalanceEnabled: 1 });
      await insert("tunnel_exit_nodes", { id: 1, tunnelId: 1, seq: 1, hostId: 3, listenPort: 24001, isEnabled: 1 });
      const caller = rulesRouter.createCaller({ user: { id: 1, role: "admin", accountEnabled: true }, req: { headers: {} }, res: {} });
      const created = [];
      for (const [i, protocol] of ["tcp", "udp", "both"].entries()) {
        created.push(await caller.create({ name: "rule-"+i, hostId: 1, sourcePort: 25000+i, targetIp: "203.0.113.1", targetPort: 80+i, tunnelId: 1, forwardType: "gost", protocol }));
      }
      let tunnel = await repo.getTunnelById(1);
      for (const { id } of created) {
        const rule = (await runtime.queryRaw('SELECT * FROM "forward_rules" WHERE "id" = ?', [id]))[0];
        await repo.reconcileForwardRuleTunnelExits(rule, tunnel);
        assert.equal(rule.tunnelExitPort, 24000);
        assert.equal((await repo.getForwardRuleTunnelExits(id))[0].tunnelExitPort, 24001);
      }
      // Old randomly allocated exit fields neither reserve phantom public ports
      // nor survive reconciliation, including on disabled rules.
      await runtime.executeRaw('UPDATE "forward_rules" SET "tunnelExitPort" = 31999, "isEnabled" = 0 WHERE "id" = ?', [created[1].id]);
      const legacy = (await runtime.queryRaw('SELECT * FROM "forward_rules" WHERE "id" = ?', [created[1].id]))[0];
      assert.equal(await repo.isPortUsedOnHost(2, 31999), false);
      assert.equal(await repo.isPortUsedOnHost(2, 24000), true);
      await repo.reconcileForwardRuleTunnelExits(legacy, tunnel);
      assert.equal(legacy.tunnelExitPort, 24000);
      assert.deepEqual([...await repo.getUsedPortsOnHost(2)], [24000]);
      const reservation = await repo.reserveTunnelListenerPort(tunnel);
      assert.equal(reservation?.port, 24000);
      reservation?.release();
      // All references follow the endpoint, not only the lowest rule id.
      await runtime.executeRaw('UPDATE "hosts" SET "portRangeEnd" = 24002 WHERE "id" = 2');
      await repo.updateTunnel(1, { listenPort: 24002 });
      await repo.syncTunnelListenerPortReferences(1, 24002, { syncSharedPrimaryRule: true, hostId: 2 });
      const ports = await runtime.queryRaw('SELECT "tunnelExitPort" AS port FROM "forward_rules" WHERE "tunnelId" = 1');
      assert.ok(ports.every(row => row.port === 24002));
      tunnel = await repo.getTunnelById(1);
      assert.equal((await repo.reconcileTunnelRulePrimaryExitPorts(tunnel)).processed, 2);
      await repo.updateTunnel(1, { loadBalanceEnabled: false });
      await repo.reconcileForwardRuleTunnelExits(legacy, await repo.getTunnelById(1));
      assert.equal((await repo.getForwardRuleTunnelExits(legacy.id)).length, 0);
      // Nginx still reserves independent secondary listeners.
      await insert("tunnels", { id: 2, name: "nginx", mode: "nginx_stream", entryHostId: 1, exitHostId: 3, listenPort: 24005, userId: 1 });
      await insert("forward_rules", { id: 100, name: "nginx-rule", hostId: 1, sourcePort: 25100, targetIp: "203.0.113.2", targetPort: 80, tunnelId: 2, tunnelExitPort: 32001, forwardType: "gost", userId: 1 });
      assert.equal(await repo.isPortUsedOnHost(3, 32001), true);
    } finally { await runtime.closeDatabase(); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "audit.db") }, encoding: "utf8", timeout: 90_000,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
