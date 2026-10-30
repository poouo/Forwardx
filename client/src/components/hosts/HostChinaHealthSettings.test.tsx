import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import HostChinaHealthSettings, { chinaHealthPayload, createChinaHealthDraft, applyChinaHealthHook, ChinaHealthStatus, applyHostProbeServiceMode, HostProbeServiceModeTabs } from "./HostChinaHealthSettings";
import { ipSwitchHookSchema } from "@shared/hostChinaHealth";
import { getLanguagePreference, initializeLanguage, setLanguagePreference, t } from "../../i18n";
import { ResourceAlertFields, ResourceAlertHostPicker } from "./HostResourceAlertSettings";
import { defaultResourceAlertService, defaultResourceAlertPolicy } from "@shared/operationsMonitor";

test("list data cannot populate secrets; unloaded credentials are preserved on save", () => {
  const draft = createChinaHealthDraft({ enabled: true, autoSwitch: true, hookConfigured: true, hook: { url: "secret" }, extra: "ignored" });
  assert.equal(draft.hookUrl, ""); assert.equal(draft.hookMethod, "GET");
  assert.equal(chinaHealthPayload(draft).hook, undefined);
  const replaced = chinaHealthPayload({ ...draft, hookLoaded: true, hookUrl: "http://10.0.0.1/api/changeip?token=test", successMode: "http" });
  assert.equal(replaced.hook?.method, "GET"); assert.equal(replaced.hook?.successMode, "http");
  assert.throws(() => chinaHealthPayload({ ...draft, hookLoaded: true, hookUrl: "http://10.0.0.1/", hookHeaders: "not json" }));
});

test("saved provider fields round-trip completely, including JSON scalar types and timeout", () => {
  for (const successValue of [true, false, 0, 1, "true", "1", "", "ok"]) {
    const hook = ipSwitchHookSchema.parse({ url: "https://provider.example/change?key=secret&ip={{ip}}", method: "POST", headers: { Authorization: "Bearer secret" }, body: '{"id":"{{hostId}}"}', successMode: "json", successPath: "data.ok", successValue, ipPath: "data.ip", updateAddress: "entry_and_tunnel", timeoutSeconds: 30 });
    const draft = applyChinaHealthHook(createChinaHealthDraft({ enabled: true, hookConfigured: true }), hook);
    assert.deepEqual(chinaHealthPayload(draft).hook, hook);
    assert.equal(draft.hookLoaded, true);
    const edited = chinaHealthPayload({ ...draft, hookUrl: "http://10.0.0.1/new", hookTimeoutSeconds: 20 });
    assert.equal(edited.hook?.url, "http://10.0.0.1/new");
    assert.equal(edited.hook?.timeoutSeconds, 20);
    assert.equal(chinaHealthPayload({ ...draft, enabled: false }).hook?.url, hook.url);
  }
});

test("provider configuration is always visible, with no replacement switch", () => {
  for (const autoSwitch of [false, true]) {
    const value = applyChinaHealthHook(createChinaHealthDraft({ enabled: true, autoSwitch, hookConfigured: true }), ipSwitchHookSchema.parse({ url: "http://10.0.0.1/change?token=saved", successMode: "http" }));
    const html = renderToStaticMarkup(<HostChinaHealthSettings value={value} onChange={() => {}} />);
    assert.match(html, /id="china-hook-url"/);
    assert.match(html, /value="http:\/\/10.0.0.1\/change\?token=saved"/);
    assert.doesNotMatch(html, /Replace saved API|替换已存接口/);
    const loading = renderToStaticMarkup(<HostChinaHealthSettings value={value} onChange={() => {}} hookLoading />);
    assert.match(loading, /<fieldset disabled=""/);
    const error = renderToStaticMarkup(<HostChinaHealthSettings value={value} onChange={() => {}} hookError onRetryHook={() => {}} onReplaceHook={() => {}} />);
    assert.match(error, /role="alert"/);
    assert.match(error, /<fieldset disabled=""/);
  }
  const manager = readFileSync("client/src/components/hosts/HostProbeServiceManager.tsx", "utf8");
  assert.match(manager, /utils\.client\.hosts\.probeServiceIpSwitchHook\.mutate/);
  assert.match(manager, /if \(!cancelled\) setForm/);
  assert.match(manager, /return \(\) => \{ cancelled = true; \}/);
  assert.match(manager, /if \(!dialogOpen\) setForm\(defaultForm\)/);
});

test("China health notifications default to administrators without a recipient selector in either language", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language); await initializeLanguage();
      const draft = createChinaHealthDraft({ enabled: true, notifyUserId: 2 });
      assert.equal(draft.notify, true);
      assert.equal(chinaHealthPayload(draft).notifyUserId, null, "legacy user targets are ignored");
      const html = renderToStaticMarkup(<HostChinaHealthSettings value={draft} onChange={() => {}} />);
      assert.ok(html.includes(language === "en" ? "Notify admins" : "通知管理员"));
      assert.doesNotMatch(html, /Notify user|Host owner|通知用户|主机所有者/);
      if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
    }
    const source = readFileSync("client/src/components/hosts/HostChinaHealthSettings.tsx", "utf8");
    assert.doesNotMatch(source, /UserSelect|notifyUserId/);
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("top-level probe mode constrains China checks without clearing the provider draft", () => {
  const form = { name: "Test service", hostScope: "all" as const, hostIds: [1, 2], intervalSeconds: 600, health: { ...createChinaHealthDraft(), hookConfigured: true, hookUrl: "http://10.0.0.1/changeip", autoSwitch: true } };
  assert.equal(form.health.enabled, false, "new services default to standard probes");
  const china = applyHostProbeServiceMode(form, "china");
  assert.equal(china.health.enabled, true); assert.equal(china.hostScope, "specific");
  assert.deepEqual(china.hostIds, [1]); assert.equal(china.intervalSeconds, 300);
  assert.deepEqual(form.hostIds, [1, 2], "switching modes does not mutate the previous state");
  const standard = applyHostProbeServiceMode(china, "standard");
  assert.equal(chinaHealthPayload(standard.health).enabled, false);
  assert.equal(standard.health.hookUrl, form.health.hookUrl);
  assert.equal(standard.health.hookConfigured, true);
  assert.equal(applyHostProbeServiceMode(standard, "china").health.autoSwitch, true);
  const resource = applyHostProbeServiceMode(china, "resource");
  assert.equal(resource, china, "opening resource alerts preserves the probe form unchanged");
  assert.equal(resource.health.enabled, true);
  assert.equal(resource.hostScope, "specific");
});

test("service mode uses three top tabs and includes resource alerts", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en"); await initializeLanguage();
    for (const mode of ["standard", "china", "resource"] as const) {
      const health = { ...createChinaHealthDraft(), enabled: mode === "china", notify: false };
      const html = renderToStaticMarkup(<HostProbeServiceModeTabs mode={mode} onModeChange={() => {}}><HostChinaHealthSettings value={health} onChange={() => {}} /></HostProbeServiceModeTabs>);
      assert.match(html, /role="tablist"/); assert.match(html, /grid-cols-3/);
      assert.equal((html.match(/role="tab"/g) || []).length, 3);
      assert.match(html, /Standard probe/); assert.match(html, /China connectivity health check/);
      assert.match(html, /Resource alert/);
      assert.match(html, /role="tabpanel"/);
      assert.equal(html.includes('id="china-failureThreshold"'), mode === "china");
      assert.doesNotMatch(html, /\p{Script=Han}/u);
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("service dialog reserves its header/footer and scrolls only the form below fixed mode tabs", () => {
  const manager = readFileSync("client/src/components/hosts/HostProbeServiceManager.tsx", "utf8");
  assert.match(manager, /<DialogContent className="max-h-\[88svh\] grid-rows-\[auto_minmax\(0,1fr\)_auto\]/);
  assert.doesNotMatch(manager, /max-h-\[88vh\]/);
  assert.match(manager, /<DialogHeader className="shrink-0">/);
  assert.match(manager, /<DialogFooter className="shrink-0">/);
  const html = renderToStaticMarkup(<HostProbeServiceModeTabs mode="china" onModeChange={() => {}}><div>Long form content</div></HostProbeServiceModeTabs>);
  assert.match(html, /class="[^"]*grid min-h-0 grid-rows-\[auto_minmax\(0,1fr\)\] gap-3 overflow-hidden/);
  assert.match(html, /role="tablist"[^>]*class="[^"]*shrink-0/);
  assert.match(html, /role="tabpanel"[^>]*class="[^"]*min-h-0 touch-pan-y[^\"]*overflow-y-auto overscroll-contain/);
  assert.doesNotMatch(html, /flex-auto/);
});

test("resource alert configuration is a service-mode tab with host-scoped settings and admin-only notifications", () => {
  const manager = readFileSync("client/src/components/hosts/HostProbeServiceManager.tsx", "utf8");
  assert.match(manager, /serviceMode === "resource" \? <HostResourceAlertSettings hosts=/);
  const settings = readFileSync("client/src/components/hosts/HostResourceAlertSettings.tsx", "utf8");
  assert.match(settings, /htmlFor="resource-alert-host"/);
  assert.match(settings, /<HostStatusLabel host=\{host\} label=\{host\.name\}/);
  assert.match(settings, /grid min-w-0 grid-cols-2 gap-2\.5/);
  assert.match(settings, /仅向管理员发送通知/);
  assert.doesNotMatch(settings, /UserSelect|notifyUserId/);
});

test("resource alerts match service host-selection rows and use the shared dialog footer", () => {
  const settings = readFileSync("client/src/components/hosts/HostResourceAlertSettings.tsx", "utf8");
  const manager = readFileSync("client/src/components/hosts/HostProbeServiceManager.tsx", "utf8");
  assert.match(settings, /rounded-md border border-border\/50 bg-muted\/15 p-2\.5/);
  assert.match(settings, /sm:flex-row sm:items-center sm:justify-between/);
  assert.match(settings, /h-9 sm:h-8 sm:w-52 sm:shrink-0/);
  assert.match(manager, /trpc\.hosts\.resourceAlertServices\.useQuery/);
  assert.match(settings, /trpc\.hosts\.saveResourceAlertService\.useMutation/);
  assert.match(settings, /resourceAlertServiceSchema\.safeParse\(draft\)\.success/);
  assert.match(settings, /<form id=\{formId\}/);
  const form = settings.slice(settings.indexOf('return <form id={formId}'));
  assert.ok(form.indexOf('<ResourceAlertFields ') < form.indexOf('<ResourceAlertHostPicker '), "host selection follows parameter fields like the probe service form");
  assert.match(settings, /checked=\{settings\.enabled\} onCheckedChange=\{enabled => onChange\(\{ enabled \}\)\}/, "service switch keeps its draft update handler");
  assert.doesNotMatch(settings, /BellRing|启用持续资源告警|<Button[^>]*onClick=\{\(\) => save/);
  const footer = manager.slice(manager.indexOf('<DialogFooter className="shrink-0">'));
  assert.match(footer, /type="submit" form=\{resourceAlertFormId\}/);
  assert.match(footer, /disabled=\{!resourceAlertSaveState\.ready \|\| resourceAlertSaveState\.pending\}/);
});

test("resource alert fields keep compact sizing and valid limits without separate switch rows", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en"); await initializeLanguage();
    const html = renderToStaticMarkup(<ResourceAlertFields settings={defaultResourceAlertService} onChange={() => {}} />);
    assert.doesNotMatch(html, /\p{Script=Han}/u);
    assert.equal((html.match(/role="switch"/g) || []).length, 1);
    assert.equal((html.match(/type="number"/g) || []).length, 3);
    assert.match(html, /Enable Service/);
    assert.doesNotMatch(html, /Send notifications/);
    assert.match(html, /id="resource-alert-threshold"[^>]*min="1" max="100"/);
    assert.match(html, /id="resource-durationSeconds"[^>]*min="60" max="3600"/);
    assert.match(html, /id="resource-recoverySeconds"[^>]*min="30" max="600"/);
    assert.match(html, /id="resource-alert-metric"/);
    assert.ok(html.indexOf('id="resource-alert-enabled"') < html.indexOf('id="resource-alert-threshold"'));
    assert.doesNotMatch(html, /rounded-lg border p-3/);
    assert.match(html, /<fieldset class=/);
    assert.doesNotMatch(html, /<fieldset disabled=/);
    assert.doesNotMatch(html, /<button[^>]*disabled=/);
    const disabled = renderToStaticMarkup(<ResourceAlertFields disabled settings={defaultResourceAlertService} onChange={() => {}} />);
    assert.match(disabled, /<fieldset disabled=""/);
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("alert host picker matches the probe picker placeholder, numbered rows and empty state", () => {
  const hosts = [{ id: 1, name: "Host One", isOnline: true }, { id: 2, name: "Host Two", isOnline: false }];
  const scope = { ...defaultResourceAlertPolicy, hostScope: "specific" as const };
  const render = (value = scope) => renderToStaticMarkup(<ResourceAlertHostPicker hosts={hosts} scope={value} onChange={() => {}} notify={true} onNotifyChange={() => {}} />);
  const empty = render();
  assert.ok(empty.includes(t("添加运行主机...")));
  assert.ok(empty.includes(t("从上方选择主机")));
  const selected = render({ ...scope, hostIds: [1, 2] });
  assert.match(selected, /max-h-40 space-y-1 overflow-y-auto/);
  assert.match(selected, /grid-cols-\[auto_minmax\(0,1fr\)_auto\]/);
  assert.match(selected, /Host One/);
  assert.match(selected, /Host Two/);
  assert.match(selected, /aria-label="(?:移除主机|Remove host)"/);
});

test("resource alert scope keeps notifications beside host selection and enable switch in the first row", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en"); await initializeLanguage();
    const hosts = [{ id: 1, name: "Host One" }];
    for (const hostScope of ["all", "specific", "exclude"] as const) {
      const html = renderToStaticMarkup(<ResourceAlertHostPicker hosts={hosts} scope={{ hostScope, hostIds: [1], excludeHostIds: [1] }} onChange={() => {}} notify={false} onNotifyChange={() => {}} />);
      assert.doesNotMatch(html, /\p{Script=Han}/u);
      assert.match(html, /id="resource-alert-scope"/);
      assert.match(html, /id="resource-alert-notify"/);
      assert.doesNotMatch(html, /id="resource-alert-enabled"/);
      assert.match(html, /flex min-w-0 flex-wrap items-end gap-2\.5/);
      assert.match(html, /min-w-\[8rem\] flex-1/);
      assert.equal((html.match(/role="switch"/g) || []).length, 1);
      assert.doesNotMatch(html, /<button[^>]*disabled=/, "both switches can be used before selecting hosts");
      assert.equal(html.includes('id="resource-alert-host"'), hostScope !== "all");
      assert.equal(html.includes("Host One"), hostScope !== "all");
    }
    const source = readFileSync("client/src/components/hosts/HostResourceAlertSettings.tsx", "utf8");
    for (const scope of ["all", "specific", "exclude"]) assert.ok(source.includes('<SelectItem value="' + scope + '">'));
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("health states and Agent upgrade hints support English", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en"); await initializeLanguage();
    for (const phase of ["unknown", "healthy", "suspect", "unhealthy", "recovering"]) {
      const html = renderToStaticMarkup(<ChinaHealthStatus health={{ enabled: true, autoSwitch: true, agentReady: false, state: { phase } }} />);
      assert.doesNotMatch(html, /\p{Script=Han}/u);
      assert.match(html, /upgrade the Agent/);
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("compact service form keeps one inline enabled switch and bounds the host selection list", () => {
  const manager = readFileSync("client/src/components/hosts/HostProbeServiceManager.tsx", "utf8");
  assert.equal((manager.match(/checked=\{form\.isEnabled\}/g) || []).length, 1);
  assert.match(manager, /<Label htmlFor="probe-service-enabled"/);
  assert.match(manager, /<Input id="probe-service-name" className="h-9 sm:h-8"/);
  assert.match(manager, /<p className="text-xs text-muted-foreground">\{translateText\("从上方选择主机"\)\}/);
  assert.match(manager, /max-h-40 space-y-1 overflow-y-auto/);
  assert.match(manager, /<DialogContent className="[^"]*sm:max-w-xl"/);
  const nameField = manager.slice(manager.indexOf('<Label htmlFor="probe-service-name"'), manager.indexOf('<Label htmlFor="probe-service-method"'));
  assert.doesNotMatch(nameField, /probe-service-enabled/);
  const methodField = manager.slice(manager.indexOf('<Label htmlFor="probe-service-method"'), manager.indexOf('className={`grid min-w-0 gap-2.5'));
  assert.match(methodField, /<SelectTrigger id="probe-service-method"/);
  assert.match(methodField, /<Switch id="probe-service-enabled"/);
  assert.ok(methodField.indexOf('</Select>') < methodField.indexOf('<Switch'));
});

test("health configuration keeps verbose help collapsed and shows concise warnings only when relevant", async () => {
  const previous = getLanguagePreference();
  try {
    setLanguagePreference("en"); await initializeLanguage();
    for (const autoSwitch of [false, true]) {
      const value = { ...createChinaHealthDraft(), enabled: true, notify: false, autoSwitch, hookConfigured: true };
      const html = renderToStaticMarkup(<HostChinaHealthSettings value={value} onChange={() => {}} />);
      const visible = html.slice(0, html.indexOf("<details"));
      assert.match(html, /<details class=/); assert.doesNotMatch(html, /<details[^>]*\sopen(?:=|\s|>)/);
      assert.doesNotMatch(visible, /Probe a fixed public IP|Notifications are sent|<h3/);
      assert.match(visible, /Failure count/); assert.match(visible, /IP switches \/ 24h/);
      assert.equal(visible.includes("May incur fees or reboot"), autoSwitch);
      assert.match(html, /Probe a fixed public IP/, "detailed detection caveats remain available on demand");
      assert.doesNotMatch(html, /\p{Script=Han}/u);
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("provider interval is editable in minutes and defaults to 60 without losing stored seconds", () => {
  const draft = { ...createChinaHealthDraft(), enabled: true, notify: false };
  assert.equal(draft.cooldownSeconds, 3600);
  const html = renderToStaticMarkup(<HostChinaHealthSettings value={draft} onChange={() => {}} />);
  assert.match(html, /<input type="number"[^>]*id="china-cooldownSeconds"[^>]*min="5"[^>]*max="1440"[^>]*value="60"/);
  assert.equal(chinaHealthPayload({ ...draft, cooldownSeconds: 90 * 60 }).cooldownSeconds, 5400);
});
