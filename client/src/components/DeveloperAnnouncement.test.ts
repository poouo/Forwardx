import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compareAnnouncementVersions, DEVELOPER_ANNOUNCEMENT_INTERVAL_MS } from "@shared/developerAnnouncements";

const text = fs.readFileSync("client/src/components/DashboardLayout.tsx", "utf8");
const source = ts.createSourceFile("DashboardLayout.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect: ts.ArrowFunction | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect") {
    const callback = node.arguments[0];
    if (callback && ts.isArrowFunction(callback) && callback.body.getText(source).includes("const seenVersion = readLastSeenUpgradeAnnouncementVersion")) effect = callback;
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(effect);
const program = ts.transpileModule(`(${effect.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function simulate(overrides: Record<string, unknown> = {}) {
  const result = { shown: false, versionWritten: "", countdown: -1 };
  const key = { current: "" };
  const context = {
    isAdmin: true, user: { id: 1 }, publicInfo: { version: "2.3.292" }, upgradeAnnouncementFetched: true,
    upgradeAnnouncement: { id: "developer:fix:1", source: "developer" },
    readLastSeenUpgradeAnnouncementVersion: () => "2.3.292",
    normalizePanelVersion: (value: string) => value || "", comparePanelVersions: compareAnnouncementVersions,
    setShowUpgradeAnnouncement: (shown: boolean) => { result.shown = shown; },
    writeLastSeenUpgradeAnnouncementVersion: (_id: number, version: string) => { result.versionWritten = version; },
    clearUpgradeAnnouncementDisplaySession() {}, readUpgradeAnnouncementDisplaySession: () => null,
    writeUpgradeAnnouncementDisplaySession() {}, displayedUpgradeAnnouncementKeyRef: key,
    UPGRADE_ANNOUNCEMENT_COUNTDOWN_SECONDS: 5,
    setUpgradeAnnouncementCountdown: (countdown: number) => { result.countdown = countdown; },
    utils: { announcements: { upgradePopup: { setData() {} } } }, ...overrides,
  };
  runInNewContext(program, context)();
  return { ...result, key: key.current };
}

test("already-seen installed versions do not suppress new developer notices", () => {
  const result = simulate();
  assert.equal(result.shown, true); assert.equal(result.versionWritten, "");
  assert.equal(result.key, "1:developer:developer:fix:1"); assert.equal(result.countdown, 5);
  assert.equal(simulate({ publicInfo: null }).shown, true, "remote notices do not wait for installed-version metadata");
  assert.equal(simulate({ upgradeAnnouncement: { id: "developer:fix:2", source: "developer" } }).key, "1:developer:developer:fix:2");
});
test("local upgrade notices retain their original version behavior and user restrictions", () => {
  assert.equal(simulate({ upgradeAnnouncement: { id: 1, source: "local" } }).shown, false);
  assert.equal(simulate({ upgradeAnnouncement: { id: 1, source: "local" }, readLastSeenUpgradeAnnouncementVersion: () => "2.3.291" }).shown, true);
  assert.equal(simulate({ isAdmin: false }).shown, false);
  assert.equal(simulate({ user: null }).shown, false);
  assert.equal(simulate({ upgradeAnnouncementFetched: false }).shown, false);
});

test("withdrawn or expired notices close the popup and clear its display identity", () => {
  const key = { current: "1:developer:developer:fix:1" };
  const result = simulate({ upgradeAnnouncement: null, displayedUpgradeAnnouncementKeyRef: key, readLastSeenUpgradeAnnouncementVersion: () => null });
  assert.equal(result.shown, false);
  assert.equal(result.versionWritten, "", "remote acknowledgement must not suppress pending local notices");
  assert.equal(key.current, "");
});
test("remote metadata checks are visit-triggered with no interval polling", () => {
  assert.equal(DEVELOPER_ANNOUNCEMENT_INTERVAL_MS, 1_800_000);
  for (const path of ["announcements.upgradePopup", "system.checkUpdate"]) {
    const start = text.indexOf(`trpc.${path}.useQuery(undefined, {`);
    assert.ok(start >= 0);
    const options = text.slice(start, text.indexOf("\n  });", start));
    assert.match(options, /enabled:.*isAdmin.*pageVisible/);
    assert.match(options, /staleTime: (?:DEVELOPER_ANNOUNCEMENT|ADMIN_VISIT_CHECK)_INTERVAL_MS/);
    assert.match(options, /refetchInterval: false/);
    assert.match(options, /refetchOnWindowFocus: true/);
    assert.match(options, /refetchOnReconnect: false/);
    assert.match(options, /retry: false/);
  }
  assert.match(text, /if \(!isAdmin \|\| !pageVisible\) return;/);
  assert.match(text, /utils\.announcements\.upgradePopup\.fetch\(undefined, \{ staleTime: DEVELOPER_ANNOUNCEMENT_INTERVAL_MS/);
  assert.match(text, /utils\.system\.checkUpdate\.fetch\(undefined, \{ staleTime: ADMIN_VISIT_CHECK_INTERVAL_MS/);
  assert.match(text, /\}, \[location, isAdmin, user\?\.id, pageVisible/);
  const scheduler = fs.readFileSync("server/scheduler.ts", "utf8");
  assert.doesNotMatch(scheduler, /checkPanelUpdateTask|runUpdateAutoCheck|UPDATE_AUTO_CHECK_INTERVAL_MS|repeatAfter\(updateCheck/);
});

test("reuses the existing popup and acknowledges remote reads only on success", () => {
  assert.match(text, /if \(upgradeAnnouncement\?\.source === "developer"\) return;/);
  assert.match(text, /await utils\.announcements\.upgradePopup\.cancel\(\)/);
  assert.match(text, /utils\.announcements\.upgradePopup\.setData\(undefined, null\)/);
  const main = fs.readFileSync("client/src/main.tsx", "utf8");
  assert.match(main, /const criticalQueryPaths = new Set\(\[[\s\S]*?"announcements\.upgradePopup"/);
  assert.match(main, /condition: \(op\) => op\.type === "query" && criticalQueryPaths\.has\(op\.path\),\s*true: httpLink/);
  assert.match(text, /englishTitle/); assert.match(text, /englishContent/);
  assert.match(text, /target="_blank" rel="noopener noreferrer"/);
});

test("developer popup description addresses users without explaining release mechanics", () => {
  assert.ok(text.includes('translateText("请留意以下重要通知。")'));
  assert.ok(!text.includes("开发者公告独立于面板版本发布"));
  const english = JSON.parse(fs.readFileSync("client/src/i18n/en.json", "utf8"));
  assert.equal(english["请留意以下重要通知。"], "Please review this important notice.");
  assert.ok(!Object.hasOwn(english, "开发者公告独立于面板版本发布，请阅读并按需检查更新。"));
});
