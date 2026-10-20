import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getSidebarMenuLabel,
  isSidebarMenuVisible,
  normalizeSidebarMenuSettings,
  SIDEBAR_MENU_KEYS,
  SIDEBAR_MENU_LABELS,
} from "./sidebarMenu";

test("ticket and affiliate entries are hidden by default", () => {
  const settings = normalizeSidebarMenuSettings();
  assert.equal(isSidebarMenuVisible(settings, "tickets"), false);
  assert.equal(isSidebarMenuVisible(settings, "affiliates"), false);
  assert.equal(isSidebarMenuVisible(settings), true);
});

test("every sidebar switch respects saved false and can be re-enabled", () => {
  for (const key of SIDEBAR_MENU_KEYS) {
    for (const enabled of [false, true]) {
      const saved = JSON.parse(JSON.stringify({ [key]: enabled }));
      assert.equal(isSidebarMenuVisible(normalizeSidebarMenuSettings(saved), key), enabled, key);
    }
  }
});

test("admin role, feature enablement and historical records cannot override hidden entries", () => {
  const settings = normalizeSidebarMenuSettings({ tickets: false, affiliates: false });
  for (const isAdmin of [false, true]) {
    for (const enabled of [false, true]) {
      for (const hasHistory of [false, true]) {
        const entries = [
          { menuKey: "tickets" as const, isAdmin, enabled, hasHistory },
          { menuKey: "affiliates" as const, isAdmin, enabled, hasHistory },
        ];
        assert.deepEqual(entries.filter(item => isSidebarMenuVisible(settings, item.menuKey)), []);
      }
    }
  }
  assert.deepEqual(settings, normalizeSidebarMenuSettings({ tickets: false, affiliates: false }));
});

test("affiliate labels match each role while other menu labels stay unchanged", () => {
  assert.equal(getSidebarMenuLabel("affiliates", true), "推广管理");
  assert.equal(getSidebarMenuLabel("affiliates"), "推广返佣");
  for (const key of SIDEBAR_MENU_KEYS.filter(key => key !== "affiliates")) {
    assert.equal(getSidebarMenuLabel(key, true), SIDEBAR_MENU_LABELS[key]);
    assert.equal(getSidebarMenuLabel(key, false), SIDEBAR_MENU_LABELS[key]);
  }
});

test("layout wires both affiliate routes and tickets through the shared visibility filter", () => {
  const layout = readFileSync(new URL("../client/src/components/DashboardLayout.tsx", import.meta.url), "utf8");
  assert.match(layout, /path: "\/affiliate-management", menuKey: "affiliates"/);
  assert.match(layout, /path: "\/affiliates", menuKey: "affiliates"/);
  assert.match(layout, /path: "\/tickets", menuKey: "tickets"/);
  assert.match(layout, /return isSidebarMenuVisible\(sidebarMenuSettings, item.menuKey\)/);
  assert.match(layout, /visibleAdminMenuItems = filterSidebarNavItems\(adminMenuItems\)/);
  assert.match(layout, /ticketMenuItems = filterSidebarNavItems\(/);
  assert.match(layout, /primaryMenuItems = filterSidebarNavItems\(/);
  assert.doesNotMatch(layout, /isAdmin \|\| sidebarMenuSettings\.tickets|affiliateStatus\?\.hasHistory/);
});

test("settings and admin sidebar share the affiliate label and saving refreshes public settings", () => {
  const settings = readFileSync(new URL("../client/src/pages/Settings.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("../client/src/components/DashboardLayout.tsx", import.meta.url), "utf8");
  assert.match(settings, /getSidebarMenuLabel\(key, true\)/);
  assert.match(layout, /getSidebarMenuLabel\("affiliates", true\)/);
  assert.match(settings, /utils\.system\.publicInfo\.invalidate\(\)/);
});
