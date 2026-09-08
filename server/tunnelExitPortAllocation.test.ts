import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * A tunnel exit rule may outlive a host policy change (or a previous buggy
 * allocation).  Reconciliation must not blindly retain the old port: the
 * replacement has to be inside the exit Agent's NAT range.
 */
test("reconciles stale load-balanced tunnel exit ports inside the exit host policy", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tunnel-exit-port-"));
  const databasePath = path.join(directory, "tunnel-exit-port.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const tunnelRepo = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();

      // Primary exit has a different range; the extra NAT exit is the one
      // whose stale mapping we are repairing.
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [1, "entry", "198.51.100.10", "slave", 1, 20000, 20099, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "portAllowlist", "isOnline"],
        [2, "nat-exit", "198.51.100.11", "slave", 1, 22600, 22699, "22605,22607", 1]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "loadBalanceEnabled", "loadBalanceStrategy", "userId"],
        [10, "lb-tunnel", 1, 1, "tls", 20000, 1, "round_robin", 1]);
      await insert("tunnel_exit_nodes", ["id", "tunnelId", "seq", "hostId", "listenPort", "isEnabled"],
        [100, 10, 1, 2, 22602, 1]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "tunnelExitPort", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete", "isForwardGroupTemplate"],
        [20, 1, "stale-rule", "gost", "tcp", 10, 56645, 25000, "203.0.113.20", 443, 1, 1, 0, 0]);
      await insert("forward_rule_tunnel_exits", ["id", "ruleId", "tunnelId", "exitNodeId", "exitSeq", "exitHostId", "tunnelExitPort"],
        [200, 20, 10, 100, 1, 2, 56645]);

      const rule = (await runtime.queryRaw('SELECT * FROM "forward_rules" WHERE "id" = ?', [20]))[0];
      const tunnel = (await runtime.queryRaw('SELECT * FROM "tunnels" WHERE "id" = ?', [10]))[0];
      await tunnelRepo.reconcileForwardRuleTunnelExits(rule, tunnel);
      const repaired = (await runtime.queryRaw('SELECT "tunnelExitPort" FROM "forward_rule_tunnel_exits" WHERE "ruleId" = ? AND "exitNodeId" = ?', [20, 100]))[0];
      assert.ok(repaired, "expected the exit mapping to remain present");
      assert.ok(Number(repaired.tunnelExitPort) >= 22600 && Number(repaired.tunnelExitPort) <= 22699,
        "reconciled port escaped the NAT range: " + repaired.tunnelExitPort);
      assert.notEqual(Number(repaired.tunnelExitPort), 56645);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("tunnel exit allocation keeps an extra host allowlist when the preferred range matches", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tunnel-exit-allowlist-"));
  const databasePath = path.join(directory, "tunnel-exit-allowlist.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const tunnelRepo = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "portAllowlist", "isOnline"],
        [1, "nat-exit", "198.51.100.12", "slave", 1, 22600, 22600, "23001", 1]);
      // Occupy the only port in the configured range. The additional
      // allowlist entry must still be considered by automatic allocation.
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId"],
        [10, "occupied", 1, 1, "tls", 22600, 1]);

      const selected = await tunnelRepo.findAvailableTunnelExitPort(1, 22600, 22600);
      assert.equal(selected, 23001, "host allowlist port was lost when preferred range matched host range");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("rule updates do not preserve a tunnel exit port outside the NAT policy", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tunnel-rule-port-"));
  const databasePath = path.join(directory, "tunnel-rule-port.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("users", ["id", "username", "password", "role"], [1, "admin", "x", "admin"]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [1, "entry", "198.51.100.20", "slave", 1, 20000, 20099, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [2, "nat-exit", "198.51.100.21", "slave", 1, 22600, 22699, 1]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
        [10, "single-tunnel", 1, 2, "tls", 22600, 1, 1]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "tunnelExitPort", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete", "isForwardGroupTemplate"],
        [20, 1, "stale-rule", "gost", "tcp", 10, 56645, 20001, "203.0.113.20", 443, 1, 1, 0, 0]);

      const caller = rulesRouter.createCaller({
        req: { headers: {} },
        res: { clearCookie() {} },
        user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
        authSession: null,
        authFailureReason: null,
      });
      await caller.update({ id: 20 });
      const repaired = (await runtime.queryRaw('SELECT "tunnelExitPort" FROM "forward_rules" WHERE "id" = ?', [20]))[0];
      assert.ok(repaired, "expected the rule to remain present");
      assert.ok(Number(repaired.tunnelExitPort) >= 22600 && Number(repaired.tunnelExitPort) <= 22699,
        "updated rule retained an invalid exit port: " + repaired.tunnelExitPort);
      assert.notEqual(Number(repaired.tunnelExitPort), 56645);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("nginx stream uses the tunnel listener only for its primary rule", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-nginx-tunnel-port-"));
  const databasePath = path.join(directory, "nginx-tunnel-port.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("system_settings", ["key", "value"], ["forwardProtocols", JSON.stringify({ nginx_stream: true })]);
      await insert("users", ["id", "username", "password", "role", "canAddRules"], [1, "admin", "x", "admin", 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [1, "entry", "198.51.100.30", "slave", 1, 20000, 20099, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [2, "nginx-exit", "198.51.100.31", "slave", 1, 22600, 22699, 1]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
        [10, "nginx-stream", 1, 2, "nginx_stream", 22600, 1, 1]);

      const caller = rulesRouter.createCaller({
        req: { headers: {} },
        res: { clearCookie() {} },
        user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
        authSession: null,
        authFailureReason: null,
      });
      const first = await caller.create({
        hostId: 1,
        name: "nginx-primary",
        forwardType: "gost",
        protocol: "tcp",
        tunnelId: 10,
        sourcePort: 20001,
        targetIp: "203.0.113.30",
        targetPort: 443,
      });
      const second = await caller.create({
        hostId: 1,
        name: "nginx-secondary",
        forwardType: "gost",
        protocol: "tcp",
        tunnelId: 10,
        sourcePort: 20002,
        targetIp: "203.0.113.31",
        targetPort: 443,
      });
      const rows = await runtime.queryRaw('SELECT "id", "tunnelExitPort" FROM "forward_rules" WHERE "id" IN (?, ?) ORDER BY "id"', [first.id, second.id]);
      assert.equal(rows.length, 2);
      assert.equal(Number(rows[0].tunnelExitPort), 22600, "primary nginx rule must use tunnel.listenPort");
      assert.ok(Number(rows[1].tunnelExitPort) >= 22600 && Number(rows[1].tunnelExitPort) <= 22699);
      assert.notEqual(Number(rows[1].tunnelExitPort), 22600, "secondary nginx rule must not collide with primary listener");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("regular GOST tunnels use the shared listener only for their primary rule", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-gost-tunnel-port-"));
  const databasePath = path.join(directory, "gost-tunnel-port.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("users", ["id", "username", "password", "role", "canAddRules"], [1, "admin", "x", "admin", 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [1, "entry", "198.51.100.32", "slave", 1, 20000, 20099, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [2, "gost-exit", "198.51.100.33", "slave", 1, 22600, 22601, 1]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
        [10, "tls", 1, 2, "tls", 22600, 1, 1]);

      const caller = rulesRouter.createCaller({
        req: { headers: {} },
        res: { clearCookie() {} },
        user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
        authSession: null,
        authFailureReason: null,
      });
      const first = await caller.create({
        hostId: 1,
        name: "gost-primary",
        forwardType: "gost",
        protocol: "tcp",
        tunnelId: 10,
        sourcePort: 20001,
        targetIp: "203.0.113.32",
        targetPort: 443,
      });
      const second = await caller.create({
        hostId: 1,
        name: "gost-secondary",
        forwardType: "gost",
        protocol: "tcp",
        tunnelId: 10,
        sourcePort: 20002,
        targetIp: "203.0.113.33",
        targetPort: 443,
      });
      const rows = await runtime.queryRaw('SELECT "id", "tunnelExitPort" FROM "forward_rules" WHERE "id" IN (?, ?) ORDER BY "id"', [first.id, second.id]);
      assert.equal(rows.length, 2);
      assert.equal(Number(rows[0].tunnelExitPort), 22600,
        "the primary GOST rule must reuse tunnel.listenPort");
      assert.equal(Number(rows[1].tunnelExitPort), 22601,
        "a secondary GOST rule must use a separate port inside the NAT range");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("exit-group endpoint sync repairs stale listener ports on every member", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-exit-group-port-"));
  const databasePath = path.join(directory, "exit-group-port.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const tunnelRepo = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [1, "primary-exit", "198.51.100.40", "slave", 1, 21551, 21599, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [2, "extra-exit", "198.51.100.41", "slave", 1, 22600, 22699, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [3, "entry", "198.51.100.42", "slave", 1, 10000, 10099, 1]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "loadBalanceEnabled", "loadBalanceStrategy", "userId"],
        [10, "stale-exit-group", 3, 1, "tls", 56645, 1, "round_robin", 1]);
      await insert("tunnel_exit_nodes", ["id", "tunnelId", "seq", "hostId", "listenPort", "isEnabled"],
        [100, 10, 1, 2, 56936, 1]);

      await tunnelRepo.syncTunnelExitGroupEndpoints(
        { id: 10 },
        [{ hostId: 1, priority: 0 }, { hostId: 2, priority: 1 }],
        "round_robin",
      );
      const tunnel = (await runtime.queryRaw('SELECT "listenPort" FROM "tunnels" WHERE "id" = ?', [10]))[0];
      const node = (await runtime.queryRaw('SELECT "listenPort" FROM "tunnel_exit_nodes" WHERE "tunnelId" = ? AND "hostId" = ?', [10, 2]))[0];
      assert.ok(Number(tunnel.listenPort) >= 21551 && Number(tunnel.listenPort) <= 21599,
        "primary endpoint escaped its NAT range: " + tunnel.listenPort);
      assert.ok(Number(node.listenPort) >= 22600 && Number(node.listenPort) <= 22699,
        "extra endpoint escaped its NAT range: " + node.listenPort);
      assert.notEqual(Number(tunnel.listenPort), 56645);
      assert.notEqual(Number(node.listenPort), 56936);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("exit-group sync keeps the nginx primary rule on the promoted listener", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-nginx-exit-group-promote-"));
  const databasePath = path.join(directory, "nginx-exit-group-promote.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const tunnelRepo = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [1, "old-primary", "198.51.100.50", "slave", 1, 21551, 21599, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [2, "new-primary", "198.51.100.51", "slave", 1, 22600, 22699, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [3, "entry", "198.51.100.52", "slave", 1, 10000, 10099, 1]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "loadBalanceEnabled", "loadBalanceStrategy", "userId"],
        [10, "nginx-group", 3, 1, "nginx_stream", 21551, 1, "round_robin", 1]);
      await insert("tunnel_exit_nodes", ["id", "tunnelId", "seq", "hostId", "listenPort", "isEnabled"],
        [100, 10, 1, 2, 22602, 1]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "tunnelExitPort", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete", "isForwardGroupTemplate"],
        [20, 3, "primary", "gost", "tcp", 10, 21551, 20001, "203.0.113.50", 443, 1, 1, 0, 0]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "tunnelExitPort", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete", "isForwardGroupTemplate"],
        [21, 3, "secondary", "gost", "tcp", 10, 21552, 20002, "203.0.113.51", 443, 1, 1, 0, 0]);
      await insert("forward_rule_tunnel_exits", ["id", "ruleId", "tunnelId", "exitNodeId", "exitSeq", "exitHostId", "tunnelExitPort"],
        [200, 20, 10, 100, 1, 2, 22602]);
      await insert("forward_rule_tunnel_exits", ["id", "ruleId", "tunnelId", "exitNodeId", "exitSeq", "exitHostId", "tunnelExitPort"],
        [201, 21, 10, 100, 1, 2, 22603]);

      // Promote host 2 to the primary exit by changing group priority. The
      // primary rule must follow its new tunnel listener (22602), not get a
      // second random port on that host.
      await tunnelRepo.syncTunnelExitGroupEndpoints(
        { id: 10 },
        [{ hostId: 2, priority: 0 }, { hostId: 1, priority: 1 }],
        "round_robin",
      );
      const tunnel = (await runtime.queryRaw('SELECT "exitHostId", "listenPort" FROM "tunnels" WHERE "id" = ?', [10]))[0];
      const primary = (await runtime.queryRaw('SELECT "tunnelExitPort" FROM "forward_rules" WHERE "id" = ?', [20]))[0];
      assert.equal(Number(tunnel.exitHostId), 2);
      assert.equal(Number(tunnel.listenPort), 22602);
      assert.equal(Number(primary.tunnelExitPort), 22602);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("automatic tunnel updates keep the existing listener instead of reallocating it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tunnel-listener-stable-"));
  const databasePath = path.join(directory, "tunnel-listener-stable.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const tunnelRepo = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [1, "entry", "198.51.100.60", "slave", 1, 10000, 10099, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [2, "exit", "198.51.100.61", "slave", 1, 22600, 22699, 1]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
        [10, "stable-listener", 1, 2, "tls", 22601, 1, 1]);

      const tunnel = (await runtime.queryRaw('SELECT * FROM "tunnels" WHERE "id" = ?', [10]))[0];
      const first = await tunnelRepo.reserveTunnelListenerPort(tunnel, { currentPort: 22601 });
      assert.ok(first, "expected the current listener to be reservable");
      assert.equal(first.port, 22601);
      first.release();
      const second = await tunnelRepo.reserveTunnelListenerPort(tunnel, { currentPort: 22601 });
      assert.ok(second, "expected the current listener to remain reservable");
      assert.equal(second.port, 22601, "omitting listenPort must not churn the tunnel listener");
      second.release();
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("same-tunnel listener exemption never hides an extra or hop listener", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tunnel-resource-exemption-"));
  const databasePath = path.join(directory, "tunnel-resource-exemption.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const tunnelRepo = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [1, "exit", "198.51.100.70", "slave", 1, 22000, 22999, 1]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "mimicPort", "userId", "isEnabled"],
        [10, "resource-exemption", 1, 1, "tls", 22600, 22602, 1, 1]);
      await insert("tunnel_exit_nodes", ["id", "tunnelId", "seq", "hostId", "listenPort", "mimicPort", "isEnabled"],
        [100, 10, 1, 1, 22601, 0, 1]);
      await insert("tunnel_hops", ["id", "tunnelId", "seq", "hostId", "listenPort", "mimicPort"],
        [200, 10, 1, 1, 22603, 0]);

      // The primary tunnel listener can be reused by its primary rule.
      assert.equal(await tunnelRepo.isPortUsedOnHost(1, 22600, undefined, "both", 10, true,
        { tunnelId: 10, port: 22600 }), false);
      // A same-tunnel extra/hop listener must remain a conflict when the
      // shorthand primary exemption is used (the old implementation wrongly
      // exempted all three rows by tunnel id + port alone).
      assert.equal(await tunnelRepo.isPortUsedOnHost(1, 22601, undefined, "both", 10, true,
        { tunnelId: 10, port: 22601 }), true);
      assert.equal(await tunnelRepo.isPortUsedOnHost(1, 22603, undefined, "both", 10, true,
        { tunnelId: 10, port: 22603 }), true);
      // Replacing an extra row may exempt that exact row, but not the primary
      // listener if both happen to carry the same port.
      assert.equal(await tunnelRepo.isPortUsedOnHost(1, 22601, undefined, "both", 10, true,
        { tunnelId: 10, port: 22601, kind: "extra", resourceId: 100 }), false);
      assert.equal(await tunnelRepo.isPortUsedOnHost(1, 22600, undefined, "both", 10, true,
        { tunnelId: 10, port: 22600, kind: "extra", resourceId: 100 }), true);
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("nginx listener repair updates the tunnel and its primary rule together", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-nginx-listener-repair-"));
  const databasePath = path.join(directory, "nginx-listener-repair.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const tunnelRepo = await import(moduleUrl("server/repositories/tunnelRepository.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [1, "nginx-exit", "198.51.100.80", "slave", 1, 22600, 22699, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [2, "entry", "198.51.100.81", "slave", 1, 10000, 10099, 1]);
      // This high port is legacy data from before NAT policy enforcement.
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
        [10, "stale-nginx", 2, 1, "nginx_stream", 56645, 1, 1]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "tunnelExitPort", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete", "isForwardGroupTemplate"],
        [20, 2, "nginx-primary", "gost", "tcp", 10, 56645, 20001, "203.0.113.80", 443, 1, 1, 0, 0]);

      const tunnel = (await runtime.queryRaw('SELECT * FROM "tunnels" WHERE "id" = ?', [10]))[0];
      const repair = await tunnelRepo.ensureTunnelListenerPortPolicy(tunnel, {
        hostId: 1,
        syncSharedPrimaryRule: true,
      });
      assert.ok(repair, "expected stale nginx listener to be repaired");
      assert.ok(Number(repair.port) >= 22600 && Number(repair.port) <= 22699,
        "repaired listener escaped the NAT range: " + repair.port);
      const tunnelRow = (await runtime.queryRaw('SELECT "listenPort" FROM "tunnels" WHERE "id" = ?', [10]))[0];
      const ruleRow = (await runtime.queryRaw('SELECT "tunnelExitPort" FROM "forward_rules" WHERE "id" = ?', [20]))[0];
      assert.equal(Number(tunnelRow.listenPort), Number(repair.port));
      assert.equal(Number(ruleRow.tunnelExitPort), Number(repair.port),
        "nginx primary rule must follow the repaired tunnel listener");
      repair.reservation.release();
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("disabling a single-port nginx primary keeps its listener reservation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-nginx-disable-port-"));
  const databasePath = path.join(directory, "nginx-disable-port.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { rulesRouter } = await import(moduleUrl("server/routers/rules.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("system_settings", ["key", "value"], ["forwardProtocols", JSON.stringify({ nginx_stream: true })]);
      await insert("users", ["id", "username", "password", "role", "canAddRules"], [1, "admin", "x", "admin", 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [1, "entry", "198.51.100.90", "slave", 1, 20000, 20099, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [2, "single-port-exit", "198.51.100.91", "slave", 1, 22600, 22600, 1]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
        [10, "single-port-nginx", 1, 2, "nginx_stream", 22600, 1, 1]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "tunnelExitPort", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning", "pendingDelete", "isForwardGroupTemplate"],
        [20, 1, "nginx-primary", "gost", "tcp", 10, 22600, 20001, "203.0.113.90", 443, 1, 1, 1, 0, 0]);

      const caller = rulesRouter.createCaller({
        req: { headers: {} },
        res: { clearCookie() {} },
        user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
        authSession: null,
        authFailureReason: null,
      });
      await caller.update({ id: 20, isEnabled: false });
      let row = (await runtime.queryRaw('SELECT "isEnabled", "tunnelExitPort" FROM "forward_rules" WHERE "id" = ?', [20]))[0];
      assert.equal(Number(row.isEnabled), 0);
      assert.equal(Number(row.tunnelExitPort), 22600, "disabling must not rotate the only NAT port");

      await caller.update({ id: 20, isEnabled: true });
      row = (await runtime.queryRaw('SELECT "isEnabled", "tunnelExitPort" FROM "forward_rules" WHERE "id" = ?', [20]))[0];
      assert.equal(Number(row.isEnabled), 1);
      assert.equal(Number(row.tunnelExitPort), 22600, "re-enabling should reuse the tunnel listener");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("tunnel exit-host updates repair active GOST rule ports without touching disabled rows", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-tunnel-exit-host-update-"));
  const databasePath = path.join(directory, "tunnel-exit-host-update.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const { tunnelsRouter } = await import(moduleUrl("server/routers/tunnels.ts"));
    const q = (name) => '"' + name + '"';
    const insert = async (table, columns, values) => {
      await runtime.executeRaw(
        "INSERT INTO " + q(table) + " (" + columns.map(q).join(", ") + ") VALUES (" + values.map(() => "?").join(", ") + ")",
        values,
      );
    };

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await insert("users", ["id", "username", "password", "role", "accountEnabled"], [1, "admin", "x", "admin", 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [1, "entry", "198.51.100.100", "slave", 1, 10000, 10099, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [2, "old-exit", "198.51.100.101", "slave", 1, 20000, 20099, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [3, "nat-exit", "198.51.100.102", "slave", 1, 22600, 22699, 1]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "userId", "isEnabled"],
        [10, "migrate-exit", 1, 2, "tls", 20001, 1, 1]);
      // Active rules carry stale and missing values from the old exit. They
      // must be allocated in the new NAT range during the tunnel update.
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "tunnelExitPort", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete", "isForwardGroupTemplate"],
        [20, 1, "stale-active", "gost", "tcp", 10, 56645, 20010, "203.0.113.100", 443, 1, 1, 0, 0]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "tunnelExitPort", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete", "isForwardGroupTemplate"],
        [21, 1, "missing-active", "gost", "tcp", 10, 0, 20011, "203.0.113.101", 443, 1, 1, 0, 0]);
      // Disabled/template rows are intentionally preserved for a later
      // enable/restore operation.
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "tunnelExitPort", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete", "isForwardGroupTemplate"],
        [22, 1, "disabled", "gost", "tcp", 10, 56646, 20012, "203.0.113.102", 443, 1, 0, 0, 0]);
      await insert("forward_rules", ["id", "hostId", "name", "forwardType", "protocol", "tunnelId", "tunnelExitPort", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "pendingDelete", "isForwardGroupTemplate"],
        [23, 1, "template", "gost", "tcp", 10, 56647, 20013, "203.0.113.103", 443, 1, 1, 0, 1]);

      const caller = tunnelsRouter.createCaller({
        req: { headers: {} },
        res: { clearCookie() {} },
        user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
        authSession: null,
        authFailureReason: null,
      });
      await caller.update({ id: 10, exitHostId: 3 });

      const tunnel = (await runtime.queryRaw('SELECT "exitHostId", "listenPort" FROM "tunnels" WHERE "id" = ?', [10]))[0];
      assert.equal(Number(tunnel.exitHostId), 3);
      assert.ok(Number(tunnel.listenPort) >= 22600 && Number(tunnel.listenPort) <= 22699,
        "listener escaped the new NAT range: " + tunnel.listenPort);
      const rows = await runtime.queryRaw('SELECT "id", "tunnelExitPort" FROM "forward_rules" WHERE "tunnelId" = ? ORDER BY "id"', [10]);
      const byId = new Map(rows.map((row) => [Number(row.id), Number(row.tunnelExitPort)]));
      for (const id of [20, 21]) {
        const port = byId.get(id);
        assert.ok(port >= 22600 && port <= 22699, "active rule " + id + " escaped the new NAT range: " + port);
        assert.notEqual(port, 56645);
      }
      assert.equal(byId.get(22), 56646, "disabled rule should retain its old preference");
      assert.equal(byId.get(23), 56647, "template rule should retain its old preference");
      assert.notEqual(byId.get(20), byId.get(21), "active rules must not share an exit port");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
