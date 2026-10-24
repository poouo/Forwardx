import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import AiModelSelect, { modelSelectOptions } from "./AiModelSelect";

test("model options support search, deduplication and explicit custom names", () => {
  const models = [{ id: "deepseek-chat", isFree: false }, { id: "deepseek-reasoner" }, { id: "deepseek-chat" }];
  assert.equal(modelSelectOptions(models, "").matches.length, 2);
  assert.deepEqual(modelSelectOptions(models, " REASON ").matches.map(model => model.id), ["deepseek-reasoner"]);
  assert.equal(modelSelectOptions(models, " deepseek-chat ").custom, "");
  assert.equal(modelSelectOptions(models, " my-private-model ").custom, "my-private-model");
  assert.equal(modelSelectOptions([], "custom-model").custom, "custom-model");
});

test("model selector keeps the saved model visible before API configuration or after fetch failure", () => {
  for (const configured of [false, true]) {
    const html = renderToStaticMarkup(<AiModelSelect id="ai-model" value="my-saved-model" onValueChange={() => {}} models={[]} loading={false} configured={configured} error="network error" onRefresh={() => {}} />);
    assert.match(html, /id="ai-model"/);
    assert.match(html, /role="combobox"/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /my-saved-model/);
    assert.doesNotMatch(html, /\sdisabled(?:=|\s|>)/);
  }
});
