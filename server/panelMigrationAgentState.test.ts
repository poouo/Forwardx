import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("panel migration directives only reach imported hosts when scoped", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-panel-migration-state-"));
  const databasePath = path.join(directory, "panel.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const migrationState = await import(moduleUrl("server/panelMigrationAgentState.ts"));
    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();
      await migrationState.setPanelMigrationAgentDirective({
        id: "migration-scoped",
        state: "preparing",
        targetPanelUrl: "https://new.example.com",
        fallbackPanelUrl: "https://old.example.com",
        startedAt: 123,
        hostIds: [11, 12, 12],
      });

      assert.equal((await migrationState.getPanelMigrationAgentDirective(11))?.id, "migration-scoped");
      assert.equal((await migrationState.getPanelMigrationAgentDirective(12))?.targetPanelUrl, "https://new.example.com");
      assert.equal(await migrationState.getPanelMigrationAgentDirective(13), null);
      assert.equal((await migrationState.getPanelMigrationAgentDirective())?.fallbackPanelUrl, "https://old.example.com");

      await migrationState.setPanelMigrationAgentDirective({
        id: "migration-source",
        state: "committed",
        targetPanelUrl: "https://new.example.com",
      });
      assert.equal((await migrationState.getPanelMigrationAgentDirective(13))?.id, "migration-source");
    } finally {
      await runtime.closeDatabase();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: databasePath },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
