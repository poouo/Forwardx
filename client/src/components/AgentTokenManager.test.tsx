import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AgentTokenManager.tsx", import.meta.url), "utf8");

test("recovery installation checks current binding before copying", () => {
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
  assert.match(source, /如需添加新机器，请使用统一安装指令/);
  assert.match(source, /setReuseInstall\(null\)[\s\S]*?取消/);
  assert.match(source, /copyToClipboard\(reuseInstall\.command\)/);
  assert.match(source, /确认并复制/);
});

test("unified enrollment reuses command rows and removes manual and batch token creation", () => {
  assert.match(source, /configureDiscovery\.useMutation/);
  assert.match(source, /api\/agent\/discovery\.sh/);
  assert.doesNotMatch(source, /agentTokens\.create|EnrollmentCard|DEV_ENROLLMENT|registrationMode/);
  const dialog = source.slice(source.indexOf('<Dialog open={showCreate}'), source.indexOf('<Dialog open={!!editingToken}'));
  for (const label of ["安装命令", "卸载命令", "升级命令"]) assert.ok(dialog.includes(`label={translateText("${label}")}`));
  assert.doesNotMatch(dialog, /<details|<summary/);
  assert.match(dialog, /max-w-\[42rem\]/);
});
