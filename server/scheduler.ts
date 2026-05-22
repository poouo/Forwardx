import * as db from "./db";
import { getEmailConfig, sendMail } from "./email";
import { sendTelegramMessage } from "./telegramBot";

async function runMonthlyTrafficReset() {
  try {
    const today = new Date().getDate();
    const usersToReset = await db.getUsersForAutoReset(today);
    for (const user of usersToReset) {
      await db.resetUserTraffic(user.id);
      console.log(`[Scheduler] Auto-reset traffic for user ${user.id} (${user.username})`);
    }
    if (usersToReset.length > 0) {
      console.log(`[Scheduler] Monthly traffic reset: ${usersToReset.length} user(s) reset`);
    }

    const recharged = await db.rechargeSubscriptionTrafficCycles();
    if (recharged > 0) {
      console.log(`[Scheduler] Subscription traffic recharge: ${recharged} user(s) reset`);
    }
  } catch (error) {
    console.error("[Scheduler] Monthly traffic reset error:", error);
  }
}

async function runExpirationCheck() {
  try {
    const expiredUsers = await db.getExpiredUsers();
    for (const user of expiredUsers) {
      await db.disableAllUserRules(user.id);
      console.log(`[Scheduler] User ${user.id} (${user.username}) expired, disabled all rules`);
    }
    if (expiredUsers.length > 0) {
      console.log(`[Scheduler] Expiration check: ${expiredUsers.length} user(s) expired`);
    }
  } catch (error) {
    console.error("[Scheduler] Expiration check error:", error);
  }
}

async function runSelfTestTimeoutSweep() {
  try {
    const n = await db.timeoutStaleForwardTests(60);
    if (n > 0) {
      console.log(`[Scheduler] Self-test timeout sweep: ${n} test(s) marked as timeout`);
    }
  } catch (error) {
    console.error("[Scheduler] Self-test timeout sweep error:", error);
  }
}

async function runTcpingCleanup() {
  try {
    await db.cleanOldTcpingStats(48);
  } catch (error) {
    console.error("[Scheduler] TCPing cleanup error:", error);
  }
}

function dayKey(prefix: string, userId: number) {
  return `${prefix}:${userId}:${new Date().toISOString().slice(0, 10)}`;
}

async function runEmailReminders() {
  try {
    const config = await getEmailConfig();
    if (!config.enabled) return;
    const users = await db.getUserTrafficSummaries();
    const now = Date.now();

    for (const user of users as any[]) {
      if (!user.email) continue;

      if (config.expiryReminder && user.expiresAt) {
        const expiresAt = new Date(user.expiresAt).getTime();
        const daysLeft = Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));
        const key = dayKey(`emailReminder:expiry:${daysLeft}`, user.id);
        if (daysLeft >= 0 && daysLeft <= 3 && !(await db.getSetting(key))) {
          await sendMail({
            to: user.email,
            subject: "ForwardX 套餐到期提醒",
            text: `你的 ForwardX 套餐将在 ${daysLeft} 天后到期，请及时续费或联系管理员。`,
          });
          await db.setSetting(key, "sent");
        }
      }

      if (config.trafficReminder && Number(user.trafficLimit || 0) > 0) {
        const used = Number(user.trafficUsed || 0);
        const limit = Number(user.trafficLimit || 0);
        const leftPercent = Math.max(0, Math.round(((limit - used) / limit) * 100));
        const key = dayKey("emailReminder:traffic", user.id);
        if (leftPercent <= config.trafficReminderThreshold && !(await db.getSetting(key))) {
          await sendMail({
            to: user.email,
            subject: "ForwardX 流量余量提醒",
            text: `你的 ForwardX 流量剩余约 ${leftPercent}%，请及时续费或联系管理员。`,
          });
          await db.setSetting(key, "sent");
        }
      }
    }
  } catch (error) {
    console.error("[Scheduler] Email reminder error:", error);
  }
}

async function runTelegramReminders() {
  try {
    const settings = await db.getAllSettings();
    const envToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
    const botEnabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
    const botConfigured = !!String(settings.telegramBotToken || envToken).trim();
    if (!botEnabled || !botConfigured) return;

    const expiryReminder = settings.telegramExpiryReminder === "true";
    const trafficReminder = settings.telegramTrafficReminder === "true";
    const trafficReminderThreshold = Number(settings.telegramTrafficReminderThreshold || 20);
    if (!expiryReminder && !trafficReminder) return;

    const users = await db.getUserTrafficSummaries();
    const now = Date.now();

    for (const user of users as any[]) {
      if (!user.telegramId) continue;

      if (expiryReminder && user.expiresAt) {
        const expiresAt = new Date(user.expiresAt).getTime();
        const daysLeft = Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));
        const key = dayKey(`telegramReminder:expiry:${daysLeft}`, user.id);
        if (daysLeft >= 0 && daysLeft <= 3 && !(await db.getSetting(key))) {
          await sendTelegramMessage(
            user.telegramId,
            [
              "ForwardX 到期提醒",
              "",
              `你的套餐将在 ${daysLeft} 天后到期。`,
              `到期时间：${new Date(user.expiresAt).toLocaleDateString("zh-CN")}`,
              "请及时续费或联系管理员。",
            ].join("\n"),
          );
          await db.setSetting(key, "sent");
        }
      }

      if (trafficReminder && Number(user.trafficLimit || 0) > 0) {
        const used = Number(user.trafficUsed || 0);
        const limit = Number(user.trafficLimit || 0);
        const leftPercent = Math.max(0, Math.round(((limit - used) / limit) * 100));
        const key = dayKey("telegramReminder:traffic", user.id);
        if (leftPercent <= trafficReminderThreshold && !(await db.getSetting(key))) {
          await sendTelegramMessage(
            user.telegramId,
            [
              "ForwardX 流量提醒",
              "",
              `你的流量剩余约 ${leftPercent}%。`,
              `已用：${formatBytesLocal(used)}`,
              `总量：${formatBytesLocal(limit)}`,
              "请及时续费或联系管理员。",
            ].join("\n"),
          );
          await db.setSetting(key, "sent");
        }
      }
    }
  } catch (error) {
    console.error("[Scheduler] Telegram reminder error:", error);
  }
}

function formatBytesLocal(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${parseFloat((bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2))} ${units[index]}`;
}

export function startScheduler() {
  setInterval(async () => {
    const now = new Date();
    if (now.getMinutes() < 10) await runMonthlyTrafficReset();
  }, 60 * 60 * 1000);

  setInterval(async () => {
    await runExpirationCheck();
  }, 60 * 60 * 1000);

  setInterval(async () => {
    await runSelfTestTimeoutSweep();
  }, 30 * 1000);

  setInterval(async () => {
    await runTcpingCleanup();
  }, 60 * 60 * 1000);

  setInterval(async () => {
    await runEmailReminders();
    await runTelegramReminders();
  }, 6 * 60 * 60 * 1000);

  setTimeout(async () => {
    await runMonthlyTrafficReset();
    await runExpirationCheck();
    await runSelfTestTimeoutSweep();
    await runTcpingCleanup();
    await runEmailReminders();
    await runTelegramReminders();
  }, 5000);

  console.log("[Scheduler] Scheduled tasks started (monthly reset + expiration check + selftest timeout sweep + tcping cleanup + email/telegram reminders)");
}
