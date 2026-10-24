import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AgentTokenManager.tsx", import.meta.url), "utf8");

test("both installation-copy entry points check current binding before copying", () => {
  assert.match(source, /copyInstallCommand\(newToken\)/);
  assert.match(source, /copyInstallCommand\(scriptToken\)/);
  assert.match(source, /getInstallToken\.fetch\(\{ id \}, \{ staleTime: 0 \}\)/);
  assert.doesNotMatch(source, /getInstallToken\.fetch\(\{ token/);
  assert.match(source, /if \(data\.boundHost\) \{[\s\S]*?setReuseInstall\([\s\S]*?return;/);
  assert.doesNotMatch(source, /on(?:Copy|Click)=\{[^\n]*copyToClipboard\(getInstallCommand/);
});

test("reuse confirmation applies to offline bindings too, with explicit cancel and confirm", () => {
  assert.match(source, /<Dialog open=\{!!reuseInstall\}/);
  assert.match(source, /此 Token 已关联 Agent/);
  assert.match(source, /reuseInstall\?\.online \? translateText\("在线"\) : translateText\("离线"\)/);
  assert.match(source, /如需管理两台主机，请新建 Token/);
  assert.match(source, /setReuseInstall\(null\)[\s\S]*?取消/);
  assert.match(source, /copyToClipboard\(reuseInstall\.command\)/);
  assert.match(source, /确认并复制/);
});
