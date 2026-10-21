import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RULE_TABLE_COLUMNS, defaultRuleTableLayout, normalizeRuleTableLayout, ruleTableColumns } from "@shared/ruleTableLayout";
import { HOST_TABLE_COLUMNS, defaultHostTableLayout, hostTableColumns } from "@shared/hostTableLayout";
import ListSettings, { ListSettingsContent } from "./ListSettings";
import ColumnResizeHandle from "./ColumnResizeHandle";
import { RuleUsageSummary } from "./rules/RuleUsageSummary";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";

test("wide resource lists opt into the shared floating scrollbar without global table drag handlers", () => {
  for (const name of ["Hosts", "Rules", "Tunnels", "ForwardGroups"]) {
    assert.match(readFileSync(`client/src/pages/${name}.tsx`, "utf8"), /<Table floatingScrollbar[\s>]/);
  }
  const source = readFileSync("client/src/components/FloatingTableScrollbar.tsx", "utf8");
  assert.match(source, /role="scrollbar"/);
  assert.match(source, /aria-orientation="horizontal"/);
  assert.match(source, /setPointerCapture\(event.pointerId\)/);
  assert.match(source, /onPointerCancel=/);
  assert.match(source, /onLostPointerCapture=/);
  assert.match(source, /resize.disconnect\(\)/);
  assert.match(source, /intersection.disconnect\(\)/);
  assert.match(source, /cancelAnimationFrame\(frame\)/);
  assert.doesNotMatch(source, /addEventListener\("(?:mousemove|pointermove|mousedown|pointerdown)"/);
});

test("settings offer checkboxes, visible drag handles and required columns without pixel labels", () => {
  const layout = normalizeRuleTableLayout({ ...defaultRuleTableLayout(), hidden: ["daily"] });
  const html = renderToStaticMarkup(<ListSettingsContent layout={layout} columns={ruleTableColumns(layout, false, true)} onChange={() => {}} onReset={() => {}} />);
  assert.match(html, /列表设置/);
  assert.doesNotMatch(html, /勾选显示列，拖动调整顺序/);
  assert.match(html, /恢复默认/);
  assert.match(html, /拖动排序/);
  assert.equal((html.match(/type="checkbox"/g) || []).length, RULE_TABLE_COLUMNS.filter(column => !("adminOnly" in column)).length);
  assert.equal((html.match(/disabled=""/g) || []).length, 2);
  assert.match(html, /此列必须保留/);
  assert.doesNotMatch(html, /\d+px|>用户</);
});

test("column resize handles provide labels, bounds and keyboard focus", () => {
  const column = ruleTableColumns(defaultRuleTableLayout(), true).find(item => item.id === "entry")!;
  const html = renderToStaticMarkup(<ColumnResizeHandle column={column} onResize={() => {}} onReset={() => {}} />);
  assert.match(html, /role="separator"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-valuenow="285"/);
  assert.match(html, /aria-valuemin="140"/);
  assert.match(html, /aria-valuemax="900"/);
  assert.match(html, /调整转发入口列宽/);
});

test("list settings use a labeled icon trigger in a permanent table gutter, not a page action", () => {
  const layout = defaultRuleTableLayout();
  const html = renderToStaticMarkup(<ListSettings layout={layout} columns={ruleTableColumns(layout, false, true)} onChange={() => {}} onReset={() => {}} />);
  assert.match(html, /<button[^>]*aria-label="列表设置"[^>]*title="列表设置"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, />列表设置<|pearl-button-outline/);
  const source = readFileSync("client/src/pages/Rules.tsx", "utf8");
  assert.equal((source.match(/<ListSettings /g) || []).length, 1);
  const header = source.slice(source.indexOf("<TableHeader>"), source.indexOf("</TableHeader>"));
  assert.match(header, /sticky left-0/);
  assert.match(header, /<ListSettings /);
  assert.match(source, /<col className="w-\[44px\]" \/>/);
});

test("settings and resize labels support English", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en"); await initializeLanguage();
    const layout = defaultRuleTableLayout(), columns = ruleTableColumns(layout, true, true);
    const html = renderToStaticMarkup(<><ListSettingsContent layout={layout} columns={columns} onChange={() => {}} onReset={() => {}} /><ColumnResizeHandle column={columns[0]} onResize={() => {}} onReset={() => {}} /></>);
    assert.match(html, /List settings/);
    assert.doesNotMatch(html, /Select columns and drag to reorder/);
    assert.doesNotMatch(html, /\p{Script=Han}/u);
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("host lists reuse the same settings, required columns and accessible resize handles", () => {
  const layout = defaultHostTableLayout();
  const columns = hostTableColumns(layout, true);
  const html = renderToStaticMarkup(<ListSettingsContent layout={layout} columns={columns} onChange={() => {}} onReset={() => {}} />);
  assert.equal((html.match(/type="checkbox"/g) || []).length, HOST_TABLE_COLUMNS.length);
  assert.equal((html.match(/disabled=""/g) || []).length, 2);
  assert.match(html, /设备名称/);
  assert.match(html, /主地址/);
  assert.match(html, /Agent 版本/);
  for (const column of columns) {
    const handle = renderToStaticMarkup(<ColumnResizeHandle column={column} onResize={() => {}} onReset={() => {}} />);
    assert.match(handle, new RegExp(`aria-valuenow="${column.width}"`));
  }
});

test("list settings use available popover height and scroll only the options between fixed controls", () => {
  const source = readFileSync("client/src/components/ListSettings.tsx", "utf8");
  assert.match(source, /max-h-\[min\(36rem,var\(--radix-popover-content-available-height,calc\(100dvh-1\.5rem\)\)\)\]/);
  assert.match(source, /flex-col overflow-hidden/);
  assert.match(source, /data-list-settings-options="" className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain"/);
  assert.match(source, /className="shrink-0 px-1 pb-2"/);
  assert.match(source, /className="mt-2 shrink-0 border-t pt-2"/);
  assert.doesNotMatch(source, /60svh/);
});

test("host settings translate every column without Chinese fallback in English", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en"); await initializeLanguage();
    const layout = defaultHostTableLayout();
    const html = renderToStaticMarkup(<ListSettingsContent layout={layout} columns={hostTableColumns(layout, true)} onChange={() => {}} onReset={() => {}} />);
    assert.match(html, /Primary address/);
    assert.match(html, /Agent version/);
    assert.doesNotMatch(html, /\p{Script=Han}/u);
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("host headers and rows share their configured columns and keep the name cell short", () => {
  const source = readFileSync("client/src/pages/Hosts.tsx", "utf8");
  assert.match(source, /tableLayout\.columns\.map\(column => <TableCell/);
  assert.match(source, /tableLayout\.columns\.map\(column => <TableHead/);
  assert.match(source, /tableLayout\.columns\.map\(column => <col /);
  assert.match(source, /<ListSettings columns=\{tableLayout\.allColumns\}/);
  assert.match(source, /<ColumnResizeHandle column=\{column\}/);
  assert.match(source, /host-table-row h-16/);
  const table = source.slice(source.indexOf('<Table className="host-management-table'), source.indexOf('</Table>', source.indexOf('<Table className="host-management-table')));
  assert.doesNotMatch(table, /min-w-\[1340px\]|w-\[320px\]|HostListResourceBundle/);
  const name = source.slice(source.indexOf('case "name":'), source.indexOf('case "status":'));
  assert.doesNotMatch(name, /<HostRegionBadge|<HostLoad|<HostListStatusBadge/);
  for (const id of ["region", "address", "version", "load", "uptime", "expiry", "cpu", "memory", "disk"]) assert.ok(source.includes(`case "${id}":`));
  assert.doesNotMatch(table, /host-table-frozen-left|host-table-frozen-right|sticky right-0|left-\[44px\]/);
});

test("table quotas use a single truncated summary while full details remain available", () => {
  const rule = { adminManaged: true, trafficLimit: 4096, quotaUsedIn: 1024, quotaUsedOut: 512 };
  const compact = renderToStaticMarkup(<RuleUsageSummary rule={rule} compact />);
  assert.match(compact, /已用 1.50 KiB/);
  assert.match(compact, /truncate/);
  assert.doesNotMatch(compact, /progressbar|管理员自定义规则|剩余/);
  const full = renderToStaticMarkup(<RuleUsageSummary rule={rule} />);
  assert.match(full, /progressbar/); assert.match(full, /管理员自定义规则/); assert.match(full, /剩余/);
  assert.match(renderToStaticMarkup(<RuleUsageSummary rule={{ ...rule, ruleLimitReason: "expired" }} compact />), /规则已到期/);
  assert.equal(renderToStaticMarkup(<RuleUsageSummary rule={{}} compact />), "");
});

test("card quotas use an accessible popover icon without inline details or extra rows", () => {
  const rule = { adminManaged: true, trafficLimit: 4096, quotaUsedIn: 1024, quotaUsedOut: 512 };
  const html = renderToStaticMarkup(<RuleUsageSummary rule={rule} iconOnly />);
  assert.match(html, /<button[^>]*type="button"[^>]*aria-label="规则额度"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /inline-flex h-4 w-4 shrink-0/);
  assert.doesNotMatch(html, /progressbar|管理员自定义规则|剩余|已用/);
  const blocked = renderToStaticMarkup(<RuleUsageSummary rule={{ ...rule, ruleLimitReason: "expired" }} iconOnly />);
  assert.match(blocked, /text-destructive/);
  assert.equal(renderToStaticMarkup(<RuleUsageSummary rule={{}} iconOnly />), "");
  const source = readFileSync("client/src/pages/Rules.tsx", "utf8");
  assert.match(source, /case "total": return renderTableRuleTotalTraffic\(rule\);/);
  assert.match(source, /case "quota": return isAdminManagedRule\(rule\) \? <RuleUsageSummary[^>]* compact \/>/);
  const cards = source.slice(source.indexOf("const renderRuleCard ="), source.indexOf("return (\n    <div className=\"space-y-6\">", source.indexOf("const renderRuleCard =")));
  assert.equal((cards.match(/<RuleUsageSummary[^>]* iconOnly \/>/g) || []).length, 2);
  assert.doesNotMatch(cards, /<RuleUsageSummary[^>]*get\(rule.id\)\} \/>/);
});

test("table headers, cells and grouped row spans share the same configured column list", () => {
  const source = readFileSync("client/src/pages/Rules.tsx", "utf8");
  assert.match(source, /tableLayout\.columns\.map\(column => <TableCell/);
  assert.match(source, /tableLayout\.columns\.map\(column => <TableHead/);
  assert.match(source, /tableLayout\.columns\.map\(column => <col /);
  assert.match(source, /colSpan=\{tableLayout\.columns\.length \+ 1\}/);
  const handle = readFileSync("client/src/components/ColumnResizeHandle.tsx", "utf8");
  const move = handle.slice(handle.indexOf("onPointerMove="), handle.indexOf("onPointerUp="));
  assert.doesNotMatch(move, /onResize\(/);
  assert.match(move, /style\.setProperty/);
  assert.match(handle, /onPointerCancel=\{cancel\} onLostPointerCapture=\{cancel\}/);
});

test("host and rule tables fill their containers while only the last visible column absorbs spare width", () => {
  for (const file of ["Hosts", "Rules"]) {
    const source = readFileSync(`client/src/pages/${file}.tsx`, "utf8");
    assert.ok(source.includes('width: `max(100%, calc('), file);
    assert.ok(source.includes('width: column.id === tableLayout.columns.at(-1)?.id ? undefined : `var(--list-col-${column.id})`'), file);
    assert.match(source, /<col className="w-\[44px\]" \/>/);
  }
  const handle = readFileSync("client/src/components/ColumnResizeHandle.tsx", "utf8");
  assert.match(handle, /closest\("th"\)\?\.getBoundingClientRect\(\)\.width/);
  assert.match(handle, /current\.renderedWidth \+ event\.clientX - current\.startX/);
});
