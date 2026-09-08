import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Mimic UDP ports are persisted across Agent reconciliations.  A host NAT
 * policy change must therefore repair an old value instead of blindly
 * retaining a port that can never be reached through the gateway.
 */
test("reconciles a stale mimic UDP port inside the host policy", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-mimic-port-"));
  const databasePath = path.join(directory, "mimic-port.db");
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
        [1, "entry", "198.51.100.10", "slave", 1, 10000, 10099, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [2, "nat-exit", "198.51.100.11", "slave", 1, 22600, 22602, 1]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "mimicPort", "udpOverTcp", "forwardxVersion", "userId", "isEnabled"],
        [10, "stale-mimic", 1, 2, "forwardx", 22600, 56645, 1, "v1", 1, 1]);

      const tunnel = (await runtime.queryRaw('SELECT * FROM "tunnels" WHERE "id" = ?', [10]))[0];
      const result = await tunnelRepo.ensureForwardXMimicPorts(tunnel, [], []);
      const repaired = (await runtime.queryRaw('SELECT "mimicPort" FROM "tunnels" WHERE "id" = ?', [10]))[0];
      assert.ok(result.changed, "stale mimic value should be repaired");
      assert.ok(Number(repaired.mimicPort) >= 22601 && Number(repaired.mimicPort) <= 22602,
        "mimic port escaped the NAT range: " + repaired.mimicPort);
      assert.notEqual(Number(repaired.mimicPort), 56645);
      assert.equal(Number(result.tunnel.mimicPort), Number(repaired.mimicPort));
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

test("mimic allocation preserves an allowed port outside the host range", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-mimic-allowlist-"));
  const databasePath = path.join(directory, "mimic-allowlist.db");
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
        [1, "entry", "198.51.100.20", "slave", 1, 10000, 10099, "", 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "portAllowlist", "isOnline"],
        [2, "nat-exit", "198.51.100.21", "slave", 1, 22600, 22600, "23001", 1]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "mimicPort", "udpOverTcp", "forwardxVersion", "userId", "isEnabled"],
        [10, "allowlisted-mimic", 1, 2, "forwardx", 22600, 0, 1, "v1", 1, 1]);

      const tunnel = (await runtime.queryRaw('SELECT * FROM "tunnels" WHERE "id" = ?', [10]))[0];
      const result = await tunnelRepo.ensureForwardXMimicPorts(tunnel, [], []);
      const repaired = (await runtime.queryRaw('SELECT "mimicPort" FROM "tunnels" WHERE "id" = ?', [10]))[0];
      assert.equal(Number(repaired.mimicPort), 23001, "allowlisted mimic port was discarded");
      assert.equal(Number(result.tunnel.mimicPort), 23001);
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

test("duplicate mimic ports within one tunnel are split safely", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-mimic-duplicate-"));
  const databasePath = path.join(directory, "mimic-duplicate.db");
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
        [1, "entry", "198.51.100.30", "slave", 1, 10000, 10099, 1]);
      await insert("hosts", ["id", "name", "ip", "hostType", "userId", "portRangeStart", "portRangeEnd", "isOnline"],
        [2, "nat-exit", "198.51.100.31", "slave", 1, 22600, 22603, 1]);
      await insert("tunnels", ["id", "name", "entryHostId", "exitHostId", "mode", "listenPort", "mimicPort", "udpOverTcp", "forwardxVersion", "userId", "isEnabled"],
        [10, "duplicate-mimic", 1, 2, "forwardx", 22600, 22601, 1, "v1", 1, 1]);
      await insert("tunnel_exit_nodes", ["id", "tunnelId", "seq", "hostId", "listenPort", "mimicPort", "isEnabled"],
        [100, 10, 1, 2, 22602, 22601, 1]);

      const tunnel = (await runtime.queryRaw('SELECT * FROM "tunnels" WHERE "id" = ?', [10]))[0];
      const nodes = await runtime.queryRaw('SELECT * FROM "tunnel_exit_nodes" WHERE "tunnelId" = ?', [10]);
      const result = await tunnelRepo.ensureForwardXMimicPorts(tunnel, [], nodes);
      const repaired = (await runtime.queryRaw('SELECT "mimicPort" FROM "tunnel_exit_nodes" WHERE "id" = ?', [100]))[0];
      assert.notEqual(Number(repaired.mimicPort), 22601, "duplicate mimic port was retained");
      assert.ok(Number(repaired.mimicPort) >= 22600 && Number(repaired.mimicPort) <= 22603);
      assert.notEqual(Number(repaired.mimicPort), 22600, "mimic port may not shadow the tunnel listener");
      assert.equal(Number(result.exitNodes[0].mimicPort), Number(repaired.mimicPort));
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
