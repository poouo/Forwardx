import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import english from "./en.json";
import { browserLanguage, interpolate, parseLanguagePreference, resolveLanguage } from "./language";

test("manual choice wins over browser and IP country; unsupported storage resets to auto", () => {
  assert.equal(resolveLanguage("en", ["zh-CN"], "CN"), "en");
  assert.equal(resolveLanguage("zh-CN", ["en-US"], "US"), "zh-CN");
  for (const value of [null, "", "fr", "EN", "__proto__"]) assert.equal(parseLanguagePreference(value), "auto");
});

test("automatic selection follows supported browser language order before country", () => {
  assert.equal(browserLanguage(["fr-FR", "en-GB", "zh-CN"]), "en");
  assert.equal(browserLanguage(["zh-Hant-TW", "en-US"]), "zh-CN");
  assert.equal(resolveLanguage("auto", ["en-US"], "CN"), "en");
  assert.equal(resolveLanguage("auto", ["zh-CN"], "US"), "zh-CN");
  assert.equal(resolveLanguage("auto", ["de-DE"], "US"), "en");
  assert.equal(resolveLanguage("auto", [], "HK"), "zh-CN");
  assert.equal(resolveLanguage("auto", [], null), "zh-CN");
  assert.equal(resolveLanguage("auto", [], "invalid"), "zh-CN");
});

test("interpolation preserves user values without recursive substitution or HTML processing", () => {
  assert.equal(interpolate("Host {0}: {1}", ["{1}<script>", 0]), "Host {1}<script>: 0");
  assert.equal(interpolate("{0} {1} {2}", [null, false]), " false {2}");
});

test("English catalog preserves every interpolation and numeric limit", () => {
  const placeholders = (value: string) => (value.match(/\{\d+\}/g) || []).sort();
  const numbers = (value: string): string[] => value.replace(/\{\d+\}/g, "").match(/\d+(?:[.,]\d+)*/g) || [];
  for (const [source, translated] of Object.entries(english)) {
    assert.deepEqual(placeholders(translated), placeholders(source), source);
    for (const number of numbers(source)) assert.ok(numbers(translated).includes(number), `Numeric value ${number} lost: ${source}`);
    assert.ok(!/[\u3400-\u9fff\u2581]/.test(translated), `Untranslated catalog entry: ${source}`);
  }
});

test("English catalog has no duplicate keys", () => {
  const source = ts.parseJsonText("en.json", fs.readFileSync(new URL("./en.json", import.meta.url), "utf8"));
  const keys = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) {
      assert.ok(!keys.has(node.name.text), `Duplicate translation: ${node.name.text}`);
      keys.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
});

test("all static client translation keys have English entries", () => {
  let checked = 0;
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/\.tsx?$/.test(file) || /\.test\./.test(file)) continue;
      const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && ["t", "translateText"].includes(node.expression.getText(sf))) {
          const source = node.arguments[0];
          if (source && ts.isStringLiteral(source) && /[\u3400-\u9fff]/.test(source.text)) {
            checked++;
            assert.ok(Object.hasOwn(english, source.text), `${file}: ${source.text}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(sf);
    }
  }
  walk("client/src");
  assert.ok(checked > 3000);
});
