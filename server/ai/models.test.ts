import assert from "node:assert/strict";
import test from "node:test";
import { buildAiModelsEndpoint } from "./models";

test("DeepSeek model endpoint does not send unsupported chat filters", () => {
  assert.equal(buildAiModelsEndpoint("deepseek", "https://api.deepseek.com/", true), "https://api.deepseek.com/models");
  assert.equal(buildAiModelsEndpoint("deepseek", "https://api.deepseek.com/v1/", true), "https://api.deepseek.com/v1/models");
});

test("compatible model endpoints preserve version prefixes and normalize chat completion URLs", () => {
  assert.equal(buildAiModelsEndpoint("custom", "https://example.com/v1/chat/completions/", true), "https://example.com/v1/models");
  assert.equal(buildAiModelsEndpoint("custom", "https://example.com/v1/models", true), "https://example.com/v1/models");
  assert.equal(buildAiModelsEndpoint("custom", "https://example.com/api/v1?region=eu", true), "https://example.com/api/v1/models?region=eu");
});

test("only SiliconFlow receives its supported chat-model filter", () => {
  assert.equal(buildAiModelsEndpoint("siliconflow", "https://api.siliconflow.cn/v1", true), "https://api.siliconflow.cn/v1/models?sub_type=chat");
  assert.equal(buildAiModelsEndpoint("siliconflow", "https://api.siliconflow.cn/v1", false), "https://api.siliconflow.cn/v1/models");
});
