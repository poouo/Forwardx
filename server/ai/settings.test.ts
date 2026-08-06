import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAiChatCompletionsUrl, resolveForwardxAiSettings } from "./settings";

test("resolves provider-specific AI settings and preserves legacy DeepSeek values", () => {
  const siliconflow = resolveForwardxAiSettings({
    deepseekProvider: "siliconflow",
    deepseekApiKeySiliconflow: " bearer test-key ",
    deepseekBaseUrlSiliconflow: "https://silicon.example/v1/",
    deepseekModelSiliconflow: "model-a",
    deepseekAiEnabled: "true",
  });
  assert.equal(siliconflow.provider, "siliconflow");
  assert.equal(siliconflow.apiKey, "test-key");
  assert.equal(siliconflow.chatCompletionsUrl, "https://silicon.example/v1/chat/completions");
  assert.equal(siliconflow.model, "model-a");

  const legacy = resolveForwardxAiSettings({ deepseekApiKey: "legacy", deepseekBaseUrl: "https://legacy.example" });
  assert.equal(legacy.provider, "deepseek");
  assert.equal(legacy.apiKey, "legacy");
  assert.equal(buildAiChatCompletionsUrl("https://legacy.example/chat/completions"), "https://legacy.example/chat/completions");
});

test("clearing an AI API key removes provider storage and disables AI", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-ai-settings-"));
  const databasePath = path.join(directory, "settings.db");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const moduleUrl = (file) => pathToFileURL(path.join(process.cwd(), file)).href;
    const runtime = await import(moduleUrl("server/dbRuntime.ts"));
    const schema = await import(moduleUrl("server/dbSchema.ts"));
    const db = await import(moduleUrl("server/db.ts"));
    const { systemRouter } = await import(moduleUrl("server/_core/systemRouter.ts"));
    const caller = systemRouter.createCaller({
      req: { headers: {} },
      res: { clearCookie() {} },
      user: { id: 1, username: "admin", role: "admin", accountEnabled: true },
      authSession: null,
      authFailureReason: null,
    });

    try {
      await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB } });
      await schema.ensureDatabaseSchema();

      await caller.updateSettings({
        deepseek: {
          provider: "siliconflow",
          enabled: true,
          apiKey: "provider-secret",
        },
      });
      assert.equal(await db.getSetting("deepseekApiKeySiliconflow"), "provider-secret");
      assert.equal(await db.getSetting("deepseekAiEnabled"), "true");

      await caller.updateSettings({
        deepseek: {
          provider: "siliconflow",
          enabled: false,
          clearApiKey: true,
        },
      });
      assert.equal(await db.getSetting("deepseekApiKeySiliconflow"), null);
      assert.equal(await db.getSetting("deepseekAiEnabled"), "false");

      await db.setSettings({
        deepseekProvider: "deepseek",
        deepseekApiKeyDeepseek: "current-deepseek-secret",
        deepseekApiKey: "legacy-deepseek-secret",
        deepseekAiEnabled: "true",
      });
      await caller.updateSettings({
        deepseek: {
          provider: "deepseek",
          enabled: false,
          clearApiKey: true,
        },
      });
      assert.equal(await db.getSetting("deepseekApiKeyDeepseek"), null);
      assert.equal(await db.getSetting("deepseekApiKey"), null);
      assert.equal(await db.getSetting("deepseekAiEnabled"), "false");
    } finally {
      await runtime.closeDatabase();
    }
  `;

  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_TYPE: "sqlite",
      FORWARDX_TEST_DB: databasePath,
      NODE_ENV: "test",
    },
    encoding: "utf8",
  });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
