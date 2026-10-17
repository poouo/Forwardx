import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Wallet } from "lucide-react";
import { AffiliateStats } from "./Affiliates";
import { AFFILIATE_STATUS_LABELS } from "@shared/affiliate";
import {
  getLanguagePreference,
  initializeLanguage,
  setLanguagePreference,
  t,
} from "@/i18n";

test("affiliate overview uses responsive non-shrinking cards and translates its labels", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en");
    await initializeLanguage();
    const html = renderToStaticMarkup(
      <AffiliateStats
        items={[
          {
            label: "可用佣金",
            value: "¥12.00",
            help: "佣金可申请提现或转入账户余额，负数表示冲正欠款。",
            icon: Wallet,
          },
          {
            label: "返佣比例",
            value: "15%",
            help: "仅受邀用户首笔在线支付的套餐订单返佣。",
            icon: Wallet,
          },
          {
            label: "邀请人数",
            value: "4",
            help: "通过邀请码成功注册的用户总数。",
            icon: Wallet,
          },
          {
            label: "待确认佣金",
            value: "¥6.00",
            help: "确认期结束后自动转入可用佣金。",
            icon: Wallet,
          },
        ]}
      />,
    );
    assert.equal(/\p{Script=Han}/u.test(html), false);
    assert.match(html, /grid-cols-1/);
    assert.match(html, /sm:grid-cols-2/);
    assert.match(html, /xl:grid-cols-4/);
    assert.match(html, /min-w-0/);
    assert.match(html, /shrink-0/);
    assert.match(html, /Available commission/);
    for (const label of Object.values(AFFILIATE_STATUS_LABELS))
      assert.equal(/\p{Script=Han}/u.test(t(label)), false, label);
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});
test("affiliate UI and errors have English translations and preserve narrow-screen controls", () => {
  const en = JSON.parse(fs.readFileSync("client/src/i18n/en.json", "utf8"));
  for (const file of [
    "client/src/pages/Affiliates.tsx",
    "shared/affiliate.ts",
    "server/repositories/affiliateRepository.ts",
  ]) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/"([^"\n]*[\u4e00-\u9fff][^"\n]*)"/g))
      assert.equal(typeof en[match[1]], "string", match[1]);
  }
  const page = fs.readFileSync("client/src/pages/Affiliates.tsx", "utf8");
  assert.match(page, /overflow-x-auto/);
  assert.match(page, /overflow-y-auto/);
  assert.match(page, /flex flex-wrap gap-2/);
  assert.doesNotMatch(page, /crypto\.randomUUID/);
});

test("affiliate statistic icons use the shared colorful tile treatment in light and dark themes", () => {
  const tones = ["emerald", "amber", "sky", "violet"] as const;
  const html = renderToStaticMarkup(<AffiliateStats items={tones.map(tone => ({
    label: tone, value: "0", help: "", icon: Wallet, tone,
  }))} />);
  for (const tone of tones) {
    assert.match(html, new RegExp(`from-${tone}-500 to-${tone}-600`));
  }
  assert.equal((html.match(/h-10 w-10 shrink-0/g) || []).length, 4);
  assert.equal((html.match(/h-5 w-5 text-white/g) || []).length, 4);
  assert.equal((html.match(/rounded-xl shadow-sm/g) || []).length, 4);
  assert.equal((html.match(/pearl-hover-card/g) || []).length, 4);
  assert.equal((html.match(/opacity-\[0\.04\]/g) || []).length, 4);
  assert.doesNotMatch(html, /text-muted-foreground\/60|dark:text-black|backdrop-blur/);
  const source = fs.readFileSync("client/src/pages/Affiliates.tsx", "utf8");
  // Both the user-facing and administrator overviews specify semantic colors.
  for (const tone of tones) assert.equal((source.match(new RegExp(`tone: "${tone}"`, "g")) || []).length, 2);
});

test("affiliate settings live in the admin header dialog, including the independent business switch", () => {
  const source = fs.readFileSync("client/src/pages/Affiliates.tsx", "utf8");
  const dialogStart = source.indexOf('<Dialog open={settingsOpen}');
  const dialogEnd = source.indexOf('</Dialog>', dialogStart);
  assert.ok(dialogStart > 0 && dialogEnd > dialogStart);
  const dialog = source.slice(dialogStart, dialogEnd);
  for (const id of ["enabled", "rate", "days", "minimum", "maxcodes", "first", "transfer"]) {
    assert.match(dialog, new RegExp(`id="affiliate-${id}"`));
  }
  assert.match(dialog, /max-h-\[85dvh\] overflow-y-auto/);
  assert.match(dialog, /save\.mutate\(\{ \.\.\.config, enabled \}\)/);
  assert.match(dialog, /disabled=\{!data \|\| !dirty \|\| !valid \|\| save\.isPending\}/);
  assert.match(dialog, /if \(!save\.isPending\) onSettingsOpenChange\(open\)/);
  assert.doesNotMatch(source, /<CardTitle>\{t\("返佣设置"\)\}/);
  assert.doesNotMatch(source, /开关位于系统设置|请在系统设置的侧边栏入口设置中开启/);
  const header = source.slice(source.indexOf("export default function AffiliatesPage"));
  assert.match(header, /admin && user\?\.role === "admin"/);
  assert.match(header, /onClick=\{\(\) => setSettingsOpen\(true\)\}/);
  assert.match(source, /if \(!settingsOpen\) setDirty\(false\)/);
  assert.match(source, /adminOverview\.setData/);
  const settings = fs.readFileSync("client/src/pages/Settings.tsx", "utf8");
  assert.match(settings, /仅控制菜单显示，返佣总开关请在推广管理的设置中调整/);
  assert.doesNotMatch(settings, /affiliateEnabled/);
});
