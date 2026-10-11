import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference, t } from "./index";
import { BUILTIN_WALLPAPERS, PERSONALIZATION_THEME_PRESETS } from "../../../shared/personalization";

const hasChinese = (value: string) => /\p{Script=Han}/u.test(value);

test("English network result states and built-in appearance options contain no Chinese", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en");
    await initializeLanguage();
    const { ResultOutput, Iperf3Output, buildPendingOutput } = await import("../pages/LookingGlass");
    const { LatencyRating } = await import("../components/LatencyRating");
    const { LatencyStabilityStats } = await import("../components/LatencyStabilityStats");
    const { getLatencyStabilityStats } = await import("../lib/latencyChart");
    const output = renderToStaticMarkup(<>
      <ResultOutput result={null} liveOutput="" state="idle" />
      <Iperf3Output loading={false} onCopy={() => {}} />
      <LatencyRating isTimeout />
      <LatencyStabilityStats stats={getLatencyStabilityStats([])} />
    </>);
    assert.equal(hasChinese(output), false);
    assert.match(output, /Network Test Results/);
    assert.match(output, /Select a host, test type and target/);
    assert.equal(hasChinese(buildPendingOutput("tcp", "Test Host", "example.com", "443")), false);
    assert.match(buildPendingOutput("tcp", "Test Host", "example.com", "443"), /Target port: 443/);
    for (const item of PERSONALIZATION_THEME_PRESETS) {
      assert.equal(hasChinese(t(item.name)), false, item.name);
      assert.equal(hasChinese(t(item.description)), false, item.description);
    }
    for (const item of BUILTIN_WALLPAPERS) assert.equal(hasChinese(t(item.name)), false, item.name);
    // Substitutions and raw diagnostic text must not rewrite user-provided data.
    const raw = "用户自定义主机 <&> {1}";
    assert.equal(t("测试主机: {0}", [raw]), `Test host: ${raw}`);
    assert.match(renderToStaticMarkup(<ResultOutput result={null} liveOutput={raw} state="running" />), /用户自定义主机/);
    setLanguagePreference("zh-CN");
    await initializeLanguage();
    assert.match(renderToStaticMarkup(<ResultOutput result={null} liveOutput="" state="idle" />), /网络测试结果/);
    assert.match(buildPendingOutput("tcp", "测试机器", "example.com", "443"), /目标端口: 443/);
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

test("Appearance settings translate built-in names without rewriting uploaded filenames", () => {
  const source = readFileSync("client/src/pages/Settings.tsx", "utf8");
  assert.match(source, /translateText\(preset\.name\)/);
  assert.match(source, /translateText\(preset\.description\)/);
  assert.match(source, /alt=\{translateText\(item\.name\)\}/);
  assert.match(source, /font-medium">\{translateText\(item\.name\)\}/);
  assert.match(source, /title=\{item\.name\}>\{item\.name\}/);
});
