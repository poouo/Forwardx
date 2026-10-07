import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("standalone public monitoring leases realtime metrics only after path authorization, without repeated pushes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-public-monitor-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import { EventEmitter } from "node:events";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    let stream;
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      const settings = await import(moduleUrl("server/repositories/settingsRepository.ts"));
      await settings.setSettings({ publicHostMonitorEnabled: "true", publicHostMonitorPath: "dev" });
      await runtime.executeRaw('INSERT INTO hosts (id, name, ip, userId, isOnline) VALUES (?, ?, ?, ?, ?)', [90101, "Public", "192.0.2.1", 1, 1]);
      const events = await import(moduleUrl("server/agentEvents.ts"));
      const { hostsRouter } = await import(moduleUrl("server/routers/hosts.ts"));
      const caller = hostsRouter.createCaller({ user: null, req: { headers: {} }, res: {} });
      class Response extends EventEmitter {
        writes = []; destroyed = false; writableEnded = false; writableFinished = false;
        write(value) { this.writes.push(value); return true; }
        end() { this.writableEnded = true; this.emit("finish"); }
        destroy() { this.destroyed = true; this.emit("close"); }
      }
      const response = new Response();
      stream = events.registerAgentEventClient(90101, "public-monitor-test", response);
      await assert.rejects(caller.publicMonitor({path:"wrong"}), (e) => e.code === "NOT_FOUND");
      assert.equal(events.isHostMetricsWatching(90101), false);
      assert.equal(response.writes.length, 0);
      const first = await caller.publicMonitor({path:"dev"});
      assert.equal(first.hosts.length, 1);
      assert.equal(first.hosts[0].id, 90101);
      assert.ok(first.refreshedAt);
      assert.equal(events.isHostMetricsWatching(90101), true);
      assert.equal(response.writes.length, 1, "first standalone viewer requests immediate metrics");
      await caller.publicMonitor({path:"dev"});
      assert.equal(response.writes.length, 1, "polls and additional viewers must not repeat refresh pushes");
      now += 15_001;
      assert.equal(events.isHostMetricsWatching(90101), false, "lease expires when page stops polling");
      await caller.publicMonitor({path:"dev"});
      assert.equal(response.writes.length, 2, "returning viewer renews metrics demand");
      now += 15_001;
      events.isHostMetricsWatching(90101);
      await settings.setSetting("publicHostMonitorEnabled", "false");
      await assert.rejects(caller.publicMonitor({path:"dev"}), (e) => e.code === "NOT_FOUND");
      assert.equal(events.isHostMetricsWatching(90101), false);
      assert.equal(response.writes.length, 2);
    } finally {
      Date.now = realNow;
      stream?.close();
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"), FORWARDX_LOG_DIR: path.join(directory, "logs") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
