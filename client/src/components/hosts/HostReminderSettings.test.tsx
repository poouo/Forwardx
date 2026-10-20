import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import HostReminderSettings from "./HostReminderSettings";
import HostTrafficShutdownSetting from "./HostTrafficShutdownSetting";

test("reminders have separate backgrounds and disabled channel hints without permanent copy", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      for (const channelReady of [true, false]) {
        const html = renderToStaticMarkup(<HostReminderSettings channelReady={channelReady} trafficEnabled trafficPercent={20} renewalEnabled={false} renewalDays={7} onTrafficEnabledChange={() => {}} onTrafficPercentChange={() => {}} onRenewalEnabledChange={() => {}} onRenewalDaysChange={() => {}} />);
        assert.equal((html.match(/role="switch"/g) || []).length, 2);
        assert.equal((html.match(/type="number"/g) || []).length, 2);
        assert.equal((html.match(/<p\b/g) || []).length, 0);
        assert.equal((html.match(/bg-muted\/35/g) || []).length, 2);
        assert.equal((html.match(/<button[^>]*\sdisabled=""/g) || []).length, channelReady ? 0 : 2);
        assert.equal((html.match(/tabindex="0"/g) || []).length, channelReady ? 0 : 2);
        assert.match(html, /value="20"/);
        assert.match(html, /value="7"/);
        assert.match(html, /grid min-w-0 grid-cols-2 gap-2\.5/);
        assert.match(html, new RegExp(`aria-checked="${channelReady}"`));
        if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
      }
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("shutdown control keeps threshold and triggered state without a permanent helper paragraph", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      for (const enabled of [false, true]) {
        const html = renderToStaticMarkup(<HostTrafficShutdownSetting enabled={enabled} percent={95} triggered={enabled} onEnabledChange={() => {}} onPercentChange={() => {}} />);
        assert.match(html, /value="95"/);
        assert.match(html, /min="1" max="100"/);
        assert.match(html, new RegExp(`aria-checked="${enabled}"`));
        assert.equal(html.includes("aria-describedby="), enabled);
        assert.equal((html.match(/<p\b/g) || []).length, enabled ? 1 : 0);
        assert.ok(html.includes(language === "en" ? "Used ≥" : "已用 ≥"));
        assert.ok(html.includes(language === "en" ? "Traffic depletion shutdown" : "流量耗尽关机"));
        assert.ok(!html.includes(language === "en" ? "Requires an updated Agent" : "需新版 Agent"));
        if (enabled) assert.ok(html.includes(language === "en" ? "Triggered this cycle" : "本周期已触发"));
        if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
      }
    }
  } finally { setLanguagePreference(previous); await initializeLanguage(); }
});

test("host form saves shutdown config only in the admin payload and keeps reminders combined", () => {
  const source = readFileSync("client/src/pages/Hosts.tsx", "utf8");
  assert.match(source, /trafficShutdownEnabled: false/);
  const payload = source.slice(source.indexOf("const trafficConfigPayload"), source.indexOf("const protocolPolicyPayload"));
  assert.match(payload, /user\?\.role === "admin"/);
  assert.match(payload, /trafficShutdownEnabled: form.trafficShutdownEnabled/);
  assert.match(payload, /trafficShutdownThresholdPercent: form.trafficShutdownThresholdPercent/);
  assert.equal((source.match(/<HostReminderSettings\b/g) || []).length, 1);
  assert.equal((source.match(/<HostTrafficShutdownSetting\b/g) || []).length, 1);
  assert.match(source, /grid min-w-0 grid-cols-2 gap-2\.5">\s*<HostTrafficShutdownSetting/);
  const shutdownPair = source.slice(source.indexOf("<HostTrafficShutdownSetting"), source.indexOf('translateText("DDNS 服务")'));
  assert.match(shutdownPair, /translateText\("自动重置流量"\)/);
  const pairedControls = source.slice(source.indexOf('<div className="mt-2.5 grid min-w-0 grid-cols-2 gap-2.5">'), source.indexOf("<HostReminderSettings"));
  assert.match(pairedControls, /流量故障转移/);
  assert.match(pairedControls, /<HostStatusNotificationSetting/);
  assert.match(pairedControls, /已达阈值，暂停组调度/);
  const control = readFileSync("client/src/components/hosts/HostTrafficShutdownSetting.tsx", "utf8");
  assert.match(control, /enabled \? setConfirm\(true\) : props.onEnabledChange\(false\)/);
  assert.match(control, /<DialogDescription>.*所有服务都会中断.*手动开机/);
});
