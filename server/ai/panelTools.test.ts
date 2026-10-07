import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PANEL_TOOLS, PANEL_SETTINGS, panelToolCatalog, parsePanelCall, projectPanelResult } from "./panelTools";

test("catalog covers main management areas, exposes only permitted tools and no credential setters", () => {
  assert.ok(Object.keys(PANEL_TOOLS).length >= 30);
  assert.ok(Object.keys(PANEL_SETTINGS).length >= 50);
  assert.match(panelToolCatalog("admin"), /settings.set.*修改设置/);
  assert.match(panelToolCatalog("user"), /rules.update/);
  assert.doesNotMatch(panelToolCatalog("user"), /settings.set|users.limits|groups.toggle/);
  assert.doesNotMatch(Object.keys(PANEL_SETTINGS).join(","), /password|token|apiKey|secret|database|upgrade/i);
});
test("tool schemas reject arbitrary paths, hidden fields, invalid dates, wrong types and out-of-range values", () => {
  const admin = { role: "admin" };
  assert.throws(() => parsePanelCall(admin, "system.updateSettings", {}, "write"));
  assert.throws(() => parsePanelCall(admin, "settings.set", { key: "deepseekApiKey", value: "evil" }, "write"));
  assert.throws(() => parsePanelCall(admin, "settings.set", { key: "pluginsEnabled", value: "false" }, "write"));
  assert.throws(() => parsePanelCall(admin, "rules.update", { id: 1, password: "x" }, "write"));
  assert.throws(() => parsePanelCall(admin, "rules.update", { id: 1, targetPort: 65536 }, "write"));
  assert.throws(() => parsePanelCall(admin, "users.limits", { userId: 2, expiresAt: "tomorrow" }, "write"));
  assert.throws(() => parsePanelCall({ role: "user" }, "settings.read", {}, "read"), /管理员/);
  assert.throws(() => parsePanelCall(admin, "rules.update", { id: 1, targetPort: 80 }, "read"), /类型不匹配/);
  assert.throws(() => parsePanelCall(admin, "rules.create", { name: "x", sourcePort: 0, targetIp: "192.0.2.1", targetPort: 80 }, "write"), /隧道/);
  assert.equal(parsePanelCall(admin, "settings.set", { key: "emailTrafficReminderThreshold", value: 20 }, "write").input.value, 20);
});
test("result projection drops credentials at every nesting level", () => {
  const projected = projectPanelResult({ id: 1, password: "hash", configs: [{ id: 2, secret: "tunnel-key", token: "agent-token", name: "节点", certKeyPem: "private-key" }], apiKey: "secret", items: [{ username: "test", password: "bad" }] });
  assert.deepEqual(projected, { id: 1, configs: [{ id: 2, name: "节点" }], items: [{ username: "test" }] });
});
test("real SQLite tools reuse web business routes, retain unrelated data, enforce scopes and reject stale previews", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ai-panel-tools-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/ai/panelTools.fixture.ts"], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "tools.db"), FORWARDX_LOG_DIR: path.join(directory, "logs"), JWT_SECRET: "panel-tools-test-only-32-character-secret", TELEGRAM_BOT_TOKEN: "", DISCORD_BOT_TOKEN: "" } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
