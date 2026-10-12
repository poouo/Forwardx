import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";

const read = (file: string) => readFileSync(file, "utf8");
const pages = [
  "README.md", "README.en.md", "docs/guide/index.md", "docs/guide/deploy-panel.md",
  "docs/guide/deploy-docker.md", "docs/guide/deploy-local.md", "docs/guide/quick-start.md",
  "docs/guide/first-setup.md", "docs/guide/agent.md", "docs/guide/agent-proxy-manager.md",
  "docs/guide/agent-proxy-manager.en.md", "docs/guide/ssh-management.md",
  "docs/guide/env-vars.md", "docs/guide/paths-logs.md", "docs/guide/upgrade-backup.md",
  "docs/guide/account-recovery.md", "docs/guide/uninstall.md", "docs/guide/releases.md",
];

test("deployment documentation and READMEs have resolvable local file links", () => {
  for (const file of pages) {
    for (const match of read(file).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0].split("?")[0];
      if (!target || /^[a-z]+:/i.test(target) || target.startsWith("/")) continue;
      const resolved = resolve(dirname(file), decodeURIComponent(target));
      // Generated during VitePress build, not a checked-in source file.
      if (resolved === resolve("docs/build-info.json")) continue;
      assert.ok(existsSync(resolved), `${file}: missing ${target}`);
    }
  }
});

test("both READMEs document current deployment, proxy and recovery entry points", () => {
  for (const [file, language] of [["README.md", "zh-CN"], ["README.en.md", "en"]]) {
    const text = read(file);
    for (const installer of ["install-panel-docker.sh", "install-panel-local.sh"]) {
      assert.match(text, new RegExp(`${installer.replace(/\./g, "\\.")} \\| bash -s -- install --language ${language}`));
    }
    for (const required of ["fwxm panel status", "fwxm panel restart", "fwxm panel reset-admin", "fwxm agent status", "fwxm agent restart", "fwxm agent proxy off", "proxyUrl", "socks5h://", "--proxy", "pnpm dev:panel"]) {
      assert.ok(text.includes(required), `${file}: missing ${required}`);
    }
    assert.doesNotMatch(text, /选择[“"]自动[”"]|Select Automatic/);
  }
});

test("deployment pages link to SSH management and the proxy guide remains discoverable", () => {
  for (const file of ["docs/guide/deploy-panel.md", "docs/guide/deploy-local.md", "docs/guide/deploy-docker.md", "docs/guide/agent.md", "docs/guide/account-recovery.md"]) {
    assert.ok(read(file).includes("./ssh-management.md"), file);
  }
  const navigation = read("docs/.vitepress/config.mts");
  assert.ok(navigation.includes('link: "/guide/ssh-management"'));
  assert.ok(navigation.includes('link: "/guide/agent-proxy-manager"'));
  const manager = read("scripts/forwardx-manage.sh");
  assert.ok(manager.includes("2) 运行状态"));
  assert.ok(manager.includes("4) 重启面板或 Agent"));
});
