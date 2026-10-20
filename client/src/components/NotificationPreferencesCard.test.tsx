import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getLanguagePreference, initializeLanguage, setLanguagePreference, t } from "@/i18n";
import { NotificationPreferenceRow } from "./NotificationPreferencesCard";

test("notification toggles are accessible, bilingual, compact and retain checked/disabled state", async () => {
  const previous = getLanguagePreference();
  try {
    for (const language of ["zh-CN", "en"] as const) {
      setLanguagePreference(language);
      await initializeLanguage();
      for (const checked of [true, false]) {
        const html = renderToStaticMarkup(<NotificationPreferenceRow title={t("工单通知")} description={t("接收与我相关的工单更新。")} checked={checked} disabled onChange={async () => {}} />);
        assert.ok(html.includes(`aria-checked="${checked}"`));
        assert.match(html, /role="switch"/);
        assert.match(html, /disabled=""/);
        assert.match(html, /<label[^>]*for="([^"]+)"/);
        assert.match(html, /shrink-0/);
        assert.doesNotMatch(html, /<p\b/);
        assert.match(html, /tabindex="0"/);
        if (language === "en") assert.doesNotMatch(html, /\p{Script=Han}/u);
      }
      for (const key of ["通知偏好", "通知偏好已保存", "工单通知设置已保存", "关闭后停止所有工单推送，不影响工单和个人偏好。", "管理员已关闭工单推送，个人偏好仍会保留。", "仅在管理员选择推送公告时发送。", "通知渠道启用并绑定后才能接收推送。"])
        if (language === "en") assert.doesNotMatch(t(key), /\p{Script=Han}/u);
    }
  } finally {
    setLanguagePreference(previous);
    await initializeLanguage();
  }
});

test("Profile centralizes notification preferences and no longer labels announcements as TG-only", () => {
  const source = readFileSync("client/src/pages/Profile.tsx", "utf8");
  assert.match(source, /<NotificationPreferencesCard \/>/);
  assert.match(source, /<DiscordAccountCard showAnnouncementPreference=\{false\}/);
  assert.doesNotMatch(source, /公告 Telegram 推送|公告 TG 推送|管理员选择 TG 推送/);
  const preferences = readFileSync("client/src/components/NotificationPreferencesCard.tsx", "utf8");
  assert.match(preferences, /preferences\.channel === "discord" \? "Discord" : "Telegram"/);
  assert.match(preferences, /supportTicketNotificationSubscribed: enabled/);
  assert.match(preferences, /discordAnnouncementSubscribed: enabled/);
  assert.match(preferences, /telegramAnnouncementSubscribed: enabled/);
});
