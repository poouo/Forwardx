import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeHostProbeMethod, urlProbeOptionsSchema, urlProbeTargetSchema } from "../shared/urlProbe";
import { urlProbeKey, matchesUrlProbeReport } from "./urlProbe";
import { ensureDatabaseSchema, getDatabaseTableDefs } from "./dbSchema";

test("URL probe settings accept HTTP/HTTPS and reject credentials, fragments and invalid bounds", () => {
  for (const url of ["https://example.com/health?x=1&y=2", "http://127.0.0.1:8080/health", "http://[::1]:8080/"]) assert.ok(urlProbeTargetSchema.safeParse(url).success);
  for (const url of ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.com/", "https://example.com/#fragment", "http://example.com\r\nX: y", "https:\\example.com", "", "http://example.com:99999"]) assert.equal(urlProbeTargetSchema.safeParse(url).success, false, url);
  assert.deepEqual(urlProbeOptionsSchema.parse({ targetUrl: "https://example.com" }), { targetUrl: "https://example.com", timeoutSeconds: 5, expectedStatus: 200 });
  for (const value of [{ timeoutSeconds: 0 }, { timeoutSeconds: 31 }, { expectedStatus: 199 }, { expectedStatus: 600 }]) assert.equal(urlProbeOptionsSchema.safeParse(value).success, false);
  assert.equal(normalizeHostProbeMethod("url"), "url");
});

test("URL reports bind to URL, timeout and status instead of accepting stale or TCP-only success", () => {
  const settings = { serviceId: 1, targetUrl: "https://example.com/a?x=1&y=2", timeoutSeconds: 5, expectedStatus: 204 };
  const report = { method: "url", probeKey: urlProbeKey(settings) };
  assert.equal(report.probeKey, "service:1:url:35990647f4c4d05089482e350fa9510d3a924b5349f99194080a0382bde3960c");
  assert.ok(matchesUrlProbeReport(report, settings));
  assert.equal(matchesUrlProbeReport({ ...report, method: "tcping" }, settings), false);
  for (const change of [{ targetUrl: "https://example.com/b" }, { expectedStatus: 200 }, { timeoutSeconds: 10 }, { serviceId: 2 }]) assert.equal(matchesUrlProbeReport(report, { ...settings, ...change }), false);
});

test("MySQL and PostgreSQL upgrades add URL probe fields with safe defaults", async () => {
  const fields = ["targetUrl", "timeoutSeconds", "expectedStatus"];
  for (const kind of ["mysql", "postgresql"] as const) {
    const queries: string[] = [];
    const pool = {
      ...(kind === "mysql" ? { getConnection() { throw new Error("not used"); } } : {}),
      async query(sql: string) {
        queries.push(sql);
        if (kind === "mysql" && sql.startsWith("SHOW COLUMNS")) {
          const table = sql.match(/`([^`]+)`/)![1];
          return [getDatabaseTableDefs().find(def => def.name === table)!.columns.filter(column => table !== "host_probe_services" || !fields.includes(column.name)).map(column => ({ Field: column.name, Type: column.type })), []];
        }
        return kind === "mysql" ? [[], []] : { rows: [] };
      },
      async execute() { return [[], []]; },
    };
    await ensureDatabaseSchema(pool as any);
    const quote = kind === "mysql" ? "`" : '"';
    for (const field of fields) assert.ok(queries.some(sql => sql.startsWith(`ALTER TABLE ${quote}host_probe_services${quote} ADD COLUMN ${quote}${field}${quote}`)), `${kind} upgrades ${field}`);
  }
});

test("SQLite upgrade, admin permissions, configuration and encrypted telemetry round-trip", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-url-probe-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/urlProbe.fixture.ts"], { cwd: process.cwd(), encoding: "utf8", timeout: 90_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"), FORWARDX_LOG_DIR: path.join(directory, "logs"), JWT_SECRET: "url-probe-test-secret-only-32-characters", TELEGRAM_BOT_TOKEN: "", DISCORD_BOT_TOKEN: "" } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
