import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const read = (file: string) => readFileSync(file, "utf8");
function markdownPages(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownPages(path) : entry.name.endsWith(".md") ? [path] : [];
  });
}
const pages = ["README.md", "README.en.md", ...markdownPages("docs")];

test("all source documentation and READMEs have resolvable local file and image links", () => {
  for (const file of pages) {
    const prose = read(file).replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
    for (const match of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0].split("?")[0];
      if (!target || /^[a-z]+:/i.test(target) || target.startsWith("/")) continue;
      const resolved = resolve(dirname(file), decodeURIComponent(target));
      // Generated during VitePress build, not a checked-in source file.
      if (resolved === resolve("docs/build-info.json")) continue;
      assert.ok(existsSync(resolved), `${file}: missing ${target}`);
    }
  }
});

test("account documentation has canonical payment and billing navigation", () => {
  const navigation = read("docs/.vitepress/config.mts");
  const index = read("docs/guide/index.md");
  for (const page of ["payments", "billing"]) {
    assert.ok(navigation.includes(`link: "/guide/${page}"`), page);
    assert.ok(index.includes(`./${page}.md`), page);
    assert.ok(read("docs/guide/users-billing.md").includes(`./${page}.md`), page);
  }
  const legacyEntry = read("docs/PAYMENT_CN.md");
  assert.ok(legacyEntry.includes("./guide/payments.md"));
  assert.ok(legacyEntry.split("\n").length < 15, "legacy payment entry should not duplicate the tutorial");
  assert.ok(!existsSync("docs/guide/ui-review.md"));
  for (const file of pages) assert.ok(!read(file).includes("ui-review.md"), file);
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
