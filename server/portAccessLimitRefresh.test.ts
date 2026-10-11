import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("per-IP-only refresh preserves ordinary running rules while retaining tunnel refresh behavior", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-port-limits-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import { connectDatabase, executeRaw, queryRaw } from "./server/dbRuntime.ts";
    import { ensureDatabaseSchema } from "./server/dbSchema.ts";
    import { refreshUserForwardEndpoints } from "./server/routers/helpers.ts";
    await connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
    await ensureDatabaseSchema();
    await executeRaw('INSERT INTO users (id, username, password, role, canAddRules) VALUES (1, ?, ?, ?, 1)', ['owner', 'x', 'admin']);
    await executeRaw('INSERT INTO hosts (id, name, ip, userId) VALUES (1, ?, ?, 1)', ['entry', '198.51.100.1']);
    await executeRaw('INSERT INTO tunnels (id, name, entryHostId, exitHostId, mode, listenPort, userId, isEnabled, isRunning) VALUES (1, ?, 1, 1, ?, 19000, 1, 1, 1)', ['tunnel', 'tls']);
    for (const [id, type, tunnelId] of [[1, 'iptables', null], [2, 'nftables', null], [3, 'realm', null], [4, 'socat', null], [5, 'gost', null], [6, 'nginx', null], [7, 'gost', 1]]) {
      await executeRaw('INSERT INTO forward_rules (id, name, hostId, userId, sourcePort, targetIp, targetPort, forwardType, protocol, tunnelId, isEnabled, isRunning, pendingDelete) VALUES (?, ?, 1, 1, ?, ?, 443, ?, ?, ?, 1, 1, 0)', [id, 'rule-' + id, 22000 + id, '203.0.113.10', type, 'tcp', tunnelId]);
    }
    await refreshUserForwardEndpoints(1, 'test-per-IP-change', { preserveOrdinaryRuntime: true });
    const rules = await queryRaw('SELECT id, isRunning FROM forward_rules ORDER BY id');
    const running = value => value === true || value === 1 || value === '1';
    for (const rule of rules) assert.equal(running(rule.isRunning), Number(rule.id) !== 7, 'incorrect runtime reset for rule ' + rule.id);
    await refreshUserForwardEndpoints(1, 'test-other-limit-change');
    for (const rule of await queryRaw('SELECT isRunning FROM forward_rules')) assert.equal(running(rule.isRunning), false);
    process.exit(0);
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "limits.db") },
    });
    assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
