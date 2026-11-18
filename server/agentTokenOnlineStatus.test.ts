import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-token-online-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "tokens.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let tokens: typeof import("./repositories/tokenRepository");
let hosts: typeof import("./repositories/hostRepository");

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  tokens = await import("./repositories/tokenRepository");
  hosts = await import("./repositories/hostRepository");
  await runtime.insertAndGetId("users", { id: 1, username: "admin", password: "unused", role: "admin" });
});
after(async () => {
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("single and batch Token status matches host management with SQLite second timestamps", async () => {
  for (const mode of ["single", "batch"] as const) {
    const token = `test-${mode}`;
    const hostIds: number[] = [];
    for (const [name, isOnline, lastHeartbeat] of [
      ["online", true, new Date()],
      ["stale", true, new Date(Date.now() - 300_000)],
      ["offline", false, new Date()],
      ["missing-heartbeat", true, null],
    ] as const) {
      hostIds.push(await runtime.insertAndGetId("hosts", {
        name: `${mode}-${name}`, ip: "192.0.2.1", userId: 1,
        agentToken: token, isOnline, lastHeartbeat,
      }));
    }
    await tokens.createAgentToken({ token, userId: 1, registrationMode: mode, hostId: hostIds[0] });
    // This is the representation that the old raw-query path misread as ms.
    const [raw] = await runtime.queryRaw<any>('SELECT "lastHeartbeat" FROM "hosts" WHERE "id" = ?', [hostIds[0]]);
    assert.equal(typeof raw.lastHeartbeat, "number");
    assert.ok(raw.lastHeartbeat < 100_000_000_000);
    const item = (await tokens.getAgentTokens()).find((row: any) => row.token === token)!;
    assert.deepEqual(item.hosts.map((host: any) => host.isOnline), [true, false, false, false]);
    assert.equal(item.host.isOnline, true);
    assert.ok(item.host.lastHeartbeat instanceof Date);
    for (const host of item.hosts) {
      assert.equal(host.isOnline, (await hosts.getHostById(host.id))?.isOnline);
    }
  }
});

test("legacy hostId association and unused Tokens keep their response shape", async () => {
  const hostId = await runtime.insertAndGetId("hosts", {
    name: "legacy", ip: "192.0.2.2", userId: 1, isOnline: true, lastHeartbeat: new Date(),
  });
  await tokens.createAgentToken({ token: "legacy", userId: 1, hostId });
  await tokens.createAgentToken({ token: "unused", userId: 1 });
  const items = await tokens.getAgentTokens();
  const legacy = items.find((row: any) => row.token === "legacy")!;
  assert.equal(legacy.host.id, hostId);
  assert.equal(legacy.host.isOnline, true);
  assert.equal(legacy.hosts.length, 1);
  const unused = items.find((row: any) => row.token === "unused")!;
  assert.equal(unused.host, null);
  assert.deepEqual(unused.hosts, []);
});
