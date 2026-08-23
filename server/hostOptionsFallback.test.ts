import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("host options fall back to the full-row query on a legacy hosts schema", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-host-options-"));
  const databasePath = path.join(directory, "panel.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const hosts = await import(moduleUrl("server/repositories/hostRepository.ts"));

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await runtime.executeRaw(
        'INSERT INTO "users" ("id", "username", "password", "name", "role") VALUES (?, ?, ?, ?, ?)',
        [1, "admin", "hash", "Admin", "admin"],
      );
      await runtime.executeRaw(
        'INSERT INTO "hosts" ("id", "name", "ip", "ipv4", "agentToken", "userId", "isOnline", "lastHeartbeat") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [1, "Legacy host", "192.0.2.10", "192.0.2.10", "secret-agent-token", 1, 1, Math.floor(Date.now() / 1000)],
      );

      // Simulate a deployment that did not apply the later geo columns.
      for (const column of [
        "ipv4",
        "geoCountryCode", "geoCountryName", "geoRegion", "geoEmoji",
        "geoLatitudeMicro", "geoLongitudeMicro", "geoUpdatedAt",
      ]) {
        await runtime.executeRaw('ALTER TABLE "hosts" DROP COLUMN "' + column + '"');
      }

      const options = await hosts.getHostOptions();
      assert.deepEqual(options.map((host) => Number(host.id)), [1]);
      assert.equal(options[0].name, "Legacy host");
      assert.equal(options[0].isOnline, true);
      assert.equal(options[0].agentToken, undefined);
    } finally {
      await runtime.closeDatabase().catch(() => undefined);
    }
  `;

  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_TYPE: "sqlite",
        FORWARDX_TEST_DB: databasePath,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
