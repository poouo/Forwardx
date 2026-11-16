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

test("batch enrollment keeps host previews compact and opens a management dialog", () => {
  assert.match(source, /registrationMode, setRegistrationMode/);
  assert.match(source, /<Switch checked=\{registrationMode === "batch"\}/);
  assert.match(source, /<EnrollmentHostSummary enrollment=\{enrollment\} onOpen=\{\(\) => onOpenHosts\(enrollment\)\} \/>/);
  assert.match(source, /<Dialog open=\{!!selectedEnrollment\}/);
  assert.match(source, /管理主机/);
  assert.match(source, /编辑批量注册主机/);
  assert.match(source, /移出批量注册/);
  assert.match(source, /不会删除主机本身/);
  assert.match(source, /DEV_ENROLLMENT_PREVIEW_ENABLED/);
});

test("batch enrollment host editing keeps the reported address read-only", () => {
  assert.match(source, /type EnrollmentHostEditState = \{[\s\S]*?name: string;[\s\S]*?\};/);
  assert.doesNotMatch(source, /editingEnrollmentHost\.address/);
  assert.doesNotMatch(source, /enrollment-host-address/);
  assert.match(source, /主机地址由 Agent 上报且不可编辑/);
});

test("batch enrollment command dialog includes install, uninstall and upgrade commands", () => {
  assert.match(source, /批量注册命令/);
  assert.match(source, /label=\{translateText\("安装命令"\)\}/);
  assert.match(source, /label=\{translateText\("卸载命令"\)\}/);
  assert.match(source, /label=\{translateText\("升级命令"\)\}/);
  assert.match(source, /getAgentScriptCommand\(`install \$\{enrollmentCommand\.token\}`\)/);
  assert.match(source, /command=\{getUninstallCommand\(\)\}/);
  assert.match(source, /command=\{getUpgradeCommand\(\)\}/);
});

test("batch and single-host cards share the backend order", () => {
  assert.match(source, /const filteredCardTokenItems = useMemo\(/);
  assert.match(source, /\.\.\.filteredCardTokenItems\.map\(\(value\) => value\.registrationMode === "batch"/);
  assert.match(source, /const cardSortable = useSortableReorder\(/);
  assert.match(source, /const nextTokenIds = nextItems[\s\S]*?item\.kind === "token" \|\| !!item\.value\.tokenId/);
  assert.doesNotMatch(source, /\.\.\.realEnrollmentItems\.map\(\(value\) => \(\{ kind: "enrollment" as const, value \}\)\),\s*\.\.\.filteredTokenItems/);
});
