import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RuleLimitsForm, newRuleLimitsForm } from "../rules/RuleLimitsForm";
import HostChinaHealthSettings, { createChinaHealthDraft } from "../hosts/HostChinaHealthSettings";
import HostTrafficShutdownSetting from "../hosts/HostTrafficShutdownSetting";
import { Dialog, DialogHeader, DialogFooter } from "./dialog";
import { LatencyChartDialogHeader } from "../LatencyChartDialogHeader";

const source = (path: string) => readFileSync(`client/src/${path}`, "utf8").replace(/\r\n/g, "\n");
const section = (path: string, start: string, end: string) => {
  const text = source(path);
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${path}: section exists`);
  return text.slice(from, to);
};

test("short numbers stay paired while date/time fields wrap when their container is too narrow", () => {
  const html = renderToStaticMarkup(<RuleLimitsForm value={newRuleLimitsForm()} onChange={() => {}} />);
  assert.equal((html.match(/grid min-w-0 grid-cols-2 gap-3/g) || []).length, 1);
  assert.ok(html.includes("grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))]"));
  assert.equal((html.match(/type="number"/g) || []).length, 2);
  assert.equal((html.match(/type="time"/g) || []).length, 2);
  const health = renderToStaticMarkup(<HostChinaHealthSettings value={{ ...createChinaHealthDraft(), enabled: true, notify: false }} onChange={() => {}} />);
  assert.match(health, /grid min-w-0 grid-cols-2 gap-2\.5/);
  assert.equal((health.match(/type="number"/g) || []).length, 5);
});

test("shutdown thresholds move below the header in narrow cards and inline in wide cards", () => {
  const html = renderToStaticMarkup(<HostTrafficShutdownSetting enabled percent={95} triggered={false} onEnabledChange={() => {}} onPercentChange={() => {}} />);
  assert.match(html, /@container/);
  assert.match(html, /col-span-2 row-start-2/);
  assert.match(html, /@min-\[16rem\]:row-start-1/);
  assert.match(html, /col-start-2 row-start-1 @min-\[16rem\]:col-start-3/);
  assert.match(html, /value="95"/);
  assert.doesNotMatch(html, /whitespace-nowrap/);
});

test("host billing and paired controls use mobile columns without squeezing timestamps", () => {
  const host = section("pages/Hosts.tsx", '<TabsContent value="other"', 'translateText("DDNS 服务")');
  assert.match(host, /grid min-w-0 grid-cols-2 gap-2\.5 px-1/);
  assert.equal((host.match(/col-span-2 min-w-0 space-y-1 sm:col-span-1/g) || []).length, 2);
  assert.match(host, /col-span-2 row-start-2 min-w-0 space-y-1 md:col-span-1 md:row-start-auto/);
  assert.equal((host.match(/mt-2\.5 grid min-w-0 grid-cols-2 gap-2\.5/g) || []).length, 2);
  assert.match(host, /@min-\[16rem\]:grid-cols-/);
});

test("plan and rule names retain full mobile width while short settings share columns", () => {
  const plan = section("pages/Plans.tsx", '<TabsContent value="settings"', '<PlanDescriptionEditor');
  assert.match(plan, /grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3/);
  assert.match(plan, /col-span-2 space-y-2 md:col-span-1/);
  const rule = section("pages/Rules.tsx", '</RuleRouteTransition>\n            <div className="grid min-w-0 grid-cols-2', 'translateText("源端口")');
  assert.match(rule, /col-span-2 space-y-2 sm:col-span-1/);
  for (const label of ["规则名称", "协议", "转发工具"]) assert.ok(rule.includes(label));
  const billing = section("components/TrafficBillingConfigManager.tsx", '<Dialog open={dialogOpen}', '<DialogFooter>');
  assert.match(billing, /grid min-h-0 min-w-0 touch-pan-y auto-rows-max grid-cols-2 content-start gap-3/);
  assert.match(billing, /col-span-2 grid min-w-0 gap-3/);
  assert.match(billing, /col-span-2 space-y-2/);
});

test("code generators preserve full-width code, plan selection and submit rows on mobile", () => {
  const billing = section("pages/Billing.tsx", '<TabsContent value="redeem"', '<CardTitle>{translateText("折扣码列表")}');
  assert.equal((billing.match(/grid min-w-0 grid-cols-2 gap-3 md:grid-cols-4/g) || []).length, 2);
  assert.equal((billing.match(/col-span-2 space-y-2">/g) || []).length, 2);
  assert.match(billing, /col-span-2 space-y-2 md:col-span-4/);
  assert.equal((billing.match(/col-span-2 flex justify-end md:col-span-4/g) || []).length, 2);
});

test("host services and SMTP reserve only a compact column for ports", () => {
  const service = source("components/hosts/HostProbeServiceManager.tsx");
  assert.match(service, /grid-cols-\[minmax\(0,1fr\)_5\.5rem\]/);
  assert.match(service, /grid-cols-\[minmax\(0,1fr\)_6\.5rem\]/);
  const smtp = source("pages/EmailSettings.tsx");
  assert.match(smtp, /grid-cols-\[minmax\(0,1fr\)_5\.5rem\]/);
  assert.match(smtp, /grid-cols-\[minmax\(0,1fr\)_6rem\]/);
});

test("upgrade cards respond to their own width rather than the two-column page viewport", () => {
  const settings = source("pages/Settings.tsx");
  const upgrade = settings.slice(settings.indexOf("{/* 版本升级 */}"), settings.indexOf('translateText("GitHub 下载加速")'));
  const versions = upgrade.slice(0, upgrade.indexOf("{updateInfo?.error"));
  assert.match(upgrade, /@container\/panel-upgrade min-w-0/);
  assert.match(versions, /@min-\[20rem\]\/panel-upgrade:grid-cols-2/);
  assert.match(versions, /@min-\[38rem\]\/panel-upgrade:grid-cols-/);
  assert.match(versions, /col-span-full flex min-w-0[\s\S]*@min-\[38rem\]\/panel-upgrade:col-span-1/);
  assert.doesNotMatch(versions, /\blg:grid-cols-/);
  assert.equal((versions.match(/mt-1 break-all font-mono text-sm/g) || []).length, 2);
  assert.match(versions, /updateAutoCheckMutation\.mutateAsync/);
  assert.match(upgrade, /<Badge className="w-fit shrink-0 whitespace-nowrap">/);
  assert.match(upgrade, /className=\{`w-fit shrink-0 whitespace-nowrap/);
  assert.equal((upgrade.match(/flex min-w-0 flex-\[1_1_14rem\] items-start gap-3/g) || []).length, 2);
  assert.match(upgrade, /grid-cols-\[repeat\(auto-fit,minmax\(min\(100%,7rem\),1fr\)\)\]/);
  assert.doesNotMatch(upgrade.slice(upgrade.indexOf("<CardContent")), /sm:flex-row|sm:grid-cols-4/);
});

test("settings action headers do not turn a desktop flex basis into empty height on mobile", () => {
  const headers = [...source("pages/Settings.tsx").matchAll(
    /<CardHeader className="(responsive-actions[^"]*)">\s*<div className="([^"]*)">([\s\S]*?)<\/CardHeader>/g,
  )];
  assert.equal(headers.length, 2, "protocol and sidebar settings both have responsive action headers");
  assert.ok(headers.some((header) => header[3].includes('translateText("转发协议总开关")')));
  assert.ok(headers.some((header) => header[3].includes('translateText("左侧导航栏菜单展示设置")')));
  for (const [, headerClass, titleClass, content] of headers) {
    assert.match(headerClass, /\bspace-y-0\b/);
    assert.match(headerClass, /\bgap-3\b/);
    assert.match(headerClass, /\bsm:flex-row\b/);
    assert.match(titleClass, /\bsm:flex-1\b/);
    assert.match(titleClass, /\bsm:basis-40\b/);
    assert.doesNotMatch(titleClass, /(?:^|\s)(?:basis-\S+|flex-1|grow)(?=\s|$)/);
    assert.match(content, /className="w-full gap-2 sm:w-auto"/);
  }
});

test("long dialogs keep their actions visible and give their form body a shrinkable scroll region", () => {
  for (const Component of [DialogHeader, DialogFooter]) {
    assert.match(renderToStaticMarkup(<Component>Actions</Component>), /class="[^"]*shrink-0/);
  }
  const shared = source("components/ui/dialog.tsx");
  assert.match(shared, /dialog-panel pointer-events-auto grid min-h-0/);
  assert.match(shared, /auto-rows-max/);
  assert.match(shared, /overflow-x-hidden overflow-y-auto overscroll-contain/);
  for (const [path, start, end] of [
    ["pages/Plugins.tsx", '{actionInputDialog?.description && (', '<DialogFooter className="gap-2 border-t'],
    ["pages/Settings.tsx", 'open={customSidebarDialogOpen}', 'htmlFor="custom-sidebar-name"'],
  ]) {
    const body = section(path, start, end);
    assert.match(body, /min-h-0 flex-1[^\"]*overflow-y-auto overscroll-contain/);
  }
  for (const path of ["components/hosts/HostGroupManager.tsx", "components/plugins/AgentResourceManager.tsx", "pages/Hosts.tsx", "pages/Users.tsx"]) {
    assert.doesNotMatch(source(path), /<DialogContent[^>]*className="[^"]*(?:max-h|\bh)-\[[^\]]*\dvh\]/, `${path}: dialog heights must account for mobile browser chrome`);
  }
  const mobileUpdate = section("components/DashboardLayout.tsx", '<Dialog open={showMobileUpdateDialog}', '{/* Change Password Dialog */}');
  assert.doesNotMatch(mobileUpdate, /<DialogContent className="[^"]*\boverflow-hidden\b/);
});

test("dialogs shrink inside native safe areas without overriding panel height limits", () => {
  const shared = source("components/ui/dialog.tsx");
  assert.match(shared, /dialog-positioner[^\"]*flex flex-col items-center justify-center/);
  const css = source("index.css");
  assert.match(css, /\.dialog-positioner\s*\{[^}]*padding-top: max\(var\(--dialog-edge-gap\), var\(--forwardx-safe-area-top\)\)/);
  assert.match(css, /\.dialog-positioner\s*\{[^}]*padding-bottom: max\(var\(--dialog-edge-gap\), var\(--forwardx-safe-area-bottom\)\)/);
  assert.match(css, /\.dialog-positioner > \.dialog-panel\s*\{\s*flex-shrink: 1;\s*\}/);
});

test("latency headings and controls occupy separate rows in narrow panels", () => {
  const html = renderToStaticMarkup(<Dialog><LatencyChartDialogHeader title="服务延迟图表" description="主机最近 24H 服务探测延迟"><button>当天</button></LatencyChartDialogHeader></Dialog>);
  assert.match(html, /shrink-0/);
  assert.match(html, /@container\/latency-header/);
  assert.match(html, /@min-\[40rem\]\/latency-header:grid-cols-\[minmax\(0,1fr\)_auto\]/);
  assert.match(html, /data-latency-controls="true"[^>]*flex-wrap/);
  for (const path of ["components/hosts/HostProbeServiceLatencyDialog.tsx", "components/rules/TcpingDetailDialog.tsx", "pages/ForwardGroups.tsx", "pages/Tunnels.tsx"]) {
    assert.match(source(path), /<LatencyChartDialogHeader/);
    assert.doesNotMatch(source(path), /flex flex-col gap-2 pr-9 sm:flex-row/);
  }
});

test("plan editor reserves separate header, tabs, scroll body and footer tracks", () => {
  const plan = section("pages/Plans.tsx", '<Dialog open={editing}', '<Dialog open={assignOpen}');
  assert.match(plan, /grid-rows-\[auto_minmax\(0,1fr\)_auto\]/);
  assert.match(plan, /className="grid min-h-0 grid-rows-\[auto_minmax\(0,1fr\)\] gap-3 overflow-hidden/);
  assert.match(plan, /<TabsList[^>]*shrink-0/);
  assert.match(plan, /min-h-0 touch-pan-y overflow-y-auto overscroll-contain pb-1/);
  assert.equal((plan.match(/className="m-0 space-y-[34] !animate-none"/g) || []).length, 2);
});

test("long forwarding editors reserve header and footer height and scroll only their body", () => {
  for (const path of ["pages/ForwardGroups.tsx", "pages/Rules.tsx", "pages/Hosts.tsx", "pages/Tunnels.tsx"]) {
    const text = source(path);
    assert.match(text, /<DialogContent[^\n]*grid-rows-\[auto_minmax\(0,1fr\)_auto\]/, path);
    assert.match(text, /className="[^\"]*min-h-0 touch-pan-y[^\"]*overflow-y-auto[^\"]*overscroll-contain/, path);
  }
  const users = section("pages/Users.tsx", '<Dialog open={showTrafficSettings}', '<Tabs defaultValue="permission"');
  assert.match(users, /<DialogHeader>/);
});

test("metered resource editor keeps both switches inside its own scroll body", () => {
  const billing = section("components/TrafficBillingConfigManager.tsx", '<Dialog open={dialogOpen}', '</Dialog>');
  assert.match(billing, /<DialogContent[^\n]*grid-rows-\[auto_minmax\(0,1fr\)_auto\] overflow-hidden/);
  assert.match(billing, /grid min-h-0 min-w-0 touch-pan-y[^\"]*overflow-y-auto overscroll-contain pb-2/);
  const footer = billing.indexOf('<DialogFooter>');
  for (const field of ['启用计费资源', '需要额外计费权限']) {
    assert.ok(billing.indexOf(field) > 0 && billing.indexOf(field) < footer);
  }
  assert.equal((billing.match(/col-span-2 flex min-w-0 items-center justify-between gap-3 rounded-lg/g) || []).length, 2);
  assert.equal((billing.match(/text-xs leading-5 text-muted-foreground/g) || []).length, 2);
});

test("mobile dashboard pairs inbound/outbound cards and lays out personal consumption as two by two", () => {
  const home = source("pages/Home.tsx");
  const traffic = section("pages/Home.tsx", 'title={translateText("入站流量")}', '<MobileAppSettings');
  assert.doesNotMatch(traffic, /col-span-2/);
  assert.match(home, /className=\{isAdmin \? undefined : "col-span-2 lg:col-span-1"\}/);
  const consumption = section("pages/Home.tsx", 'translateText("我的消耗")', 'translateText("我的账户状态")');
  assert.match(consumption, /grid grid-cols-2 gap-3 xl:grid-cols-4/);
  assert.match(consumption, /\[&>\*\]:min-w-0/);
  assert.match(consumption, /overflow-wrap:anywhere/);
  assert.match(consumption, /<Badge[^>]*className="w-fit self-start border-emerald-500\/30/);
});

test("host management keeps its three mobile actions in a single compact row", () => {
  const actions = section("pages/Hosts.tsx", 'activeManageTab === "hosts" && (', 'className="hidden items-center overflow-hidden rounded-md border border-border/40 sm:flex"');
  assert.match(actions, /col-span-2 grid min-w-0 grid-cols-3 gap-1\.5 sm:contents/);
  assert.match(actions, /user\?\.role === "admin" \? "w-full sm:w-auto"/);
  assert.match(actions, /translateText\("检查更新"\)/);
  assert.match(actions, /translateText\("一键升级"\)/);
  assert.match(actions, /translateText\("添加"\)/);
});
