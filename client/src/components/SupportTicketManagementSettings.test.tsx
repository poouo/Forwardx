import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference } from "@/i18n";
import { SupportTicketManagementSettings } from "./SupportTicketManagementSettings";

test("ticket feature and notification settings are independent, accessible and bilingual", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      for (const feature of [true, false]) for (const notifications of [true, false]) {
        const html = renderToStaticMarkup(<SupportTicketManagementSettings
          feature={{ enabled: feature, unavailable: false, onChange: async () => {} }}
          notifications={{ enabled: notifications, unavailable: false, onChange: async () => {} }}
        />);
        const switches = [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map(match => match[0]);
        assert.equal(switches.length, 2);
        assert.ok(switches[0].includes(`aria-checked="${feature}"`));
        assert.ok(switches[1].includes(`aria-checked="${notifications}"`));
        assert.equal((html.match(/<label[^>]+for=/g) || []).length, 2);
        assert.equal((html.match(/aria-describedby=/g) || []).length, 2);
        assert.match(html, /min-w-0/);
        assert.match(html, /shrink-0/);
        if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
      }
    }
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

test("unavailable ticket settings cannot be changed and do not disable the other setting", () => {
  const html = renderToStaticMarkup(<SupportTicketManagementSettings
    feature={{ enabled: false, unavailable: true, onChange: async () => {} }}
    notifications={{ enabled: true, unavailable: false, onChange: async () => {} }}
  />);
  const switches = [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map(match => match[0]);
  assert.match(switches[0], /disabled=""/);
  assert.doesNotMatch(switches[1], /disabled=""/);
});

test("administrators can reopen ticket settings after disabling the feature and the old notification control is removed", () => {
  const page = readFileSync("client/src/pages/SupportTickets.tsx", "utf8");
  const disabled = page.slice(page.indexOf("!status.data?.enabled ?"), page.indexOf("<TicketDetail", page.indexOf("!status.data?.enabled ?")));
  assert.match(disabled, /user\?\.role === "admin" && <Button/);
  assert.match(disabled, /setSettingsOpen\(true\)/);
  assert.match(page, /user\?\.role === "admin" && <TicketSettingsDialog/);
  assert.match(page, /supportTickets\.settings\.useQuery\(undefined, \{ enabled: open \}\)/);
  assert.match(page, /supportTickets\.status\.setData/);
  assert.match(page, /!feature\.isPending && !notifications\.isPending/);
  assert.match(page, /max-h-\[85dvh\] overflow-y-auto/);
  const old = readFileSync("client/src/components/NotificationSettingsCard.tsx", "utf8");
  assert.doesNotMatch(old, /supportTicketNotificationsEnabled|updateTickets/);
  const preferences = readFileSync("client/src/components/NotificationPreferencesCard.tsx", "utf8");
  assert.match(preferences, /supportTicketNotificationSubscribed: enabled/);
});
