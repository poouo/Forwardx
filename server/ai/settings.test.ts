import assert from "node:assert/strict";
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
