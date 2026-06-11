import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { LocalNotifications } from "@capacitor/local-notifications";
import { mobileAuth } from "@/lib/mobileAuth";

const SETTINGS_KEY = "forwardx.mobile.notificationSettings";
const RELEASES_URL = "https://github.com/poouo/Forwardx/releases";
const LATEST_RELEASE_URL = "https://github.com/poouo/Forwardx/releases/latest";
const RELEASES_API_URL = "https://api.github.com/repos/poouo/Forwardx/releases?per_page=20";

export type MobileNotificationSettings = {
  trafficEnabled: boolean;
  trafficThresholdPercent: number;
  expiryEnabled: boolean;
  expiryDaysBefore: number;
  reminderTime: string;
  upgradeAutoCheck: boolean;
};

export type MobileReminderSnapshot = {
  trafficLimit?: number | null;
  trafficUsed?: number | null;
  expiresAt?: string | Date | null;
};

export type MobileAppUpdateResult = {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  platform: "android" | "ios";
  packageLabel: "APK" | "IPA";
  hasPackage: boolean;
  hasApk: boolean;
};

export const defaultMobileNotificationSettings: MobileNotificationSettings = {
  trafficEnabled: false,
  trafficThresholdPercent: 20,
  expiryEnabled: false,
  expiryDaysBefore: 3,
  reminderTime: "09:00",
  upgradeAutoCheck: false,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeReminderTime(value: unknown) {
  if (typeof value !== "string") return defaultMobileNotificationSettings.reminderTime;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return defaultMobileNotificationSettings.reminderTime;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return defaultMobileNotificationSettings.reminderTime;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function normalizeMobileNotificationSettings(
  input: Partial<MobileNotificationSettings> | null | undefined,
): MobileNotificationSettings {
  return {
    trafficEnabled: !!input?.trafficEnabled,
    trafficThresholdPercent: clamp(Number(input?.trafficThresholdPercent || 20), 1, 99),
    expiryEnabled: !!input?.expiryEnabled,
    expiryDaysBefore: clamp(Number(input?.expiryDaysBefore || 3), 1, 30),
    reminderTime: normalizeReminderTime(input?.reminderTime),
    upgradeAutoCheck: !!input?.upgradeAutoCheck,
  };
}

export function getMobileNotificationSettings(): MobileNotificationSettings {
  if (typeof window === "undefined") return defaultMobileNotificationSettings;
  try {
    return normalizeMobileNotificationSettings(JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "null"));
  } catch {
    return defaultMobileNotificationSettings;
  }
}

export function saveMobileNotificationSettings(settings: MobileNotificationSettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalizeMobileNotificationSettings(settings)));
}

async function ensureNotificationPermission() {
  const current = await LocalNotifications.checkPermissions();
  if (current.display === "granted") return true;
  const requested = await LocalNotifications.requestPermissions();
  return requested.display === "granted";
}

function dateAtReminderTime(base: number | Date, time: string) {
  const [hour, minute] = normalizeReminderTime(time).split(":").map(Number);
  const date = new Date(base);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function nextReminderDate(time: string) {
  const date = dateAtReminderTime(Date.now(), time);
  if (date.getTime() <= Date.now() + 30_000) date.setDate(date.getDate() + 1);
  return date;
}

export async function scheduleMobileReminders(settings: MobileNotificationSettings, snapshot: MobileReminderSnapshot) {
  if (!mobileAuth.isNative) return;

  await LocalNotifications.cancel({ notifications: [{ id: 40101 }, { id: 40102 }] }).catch(() => undefined);
  if (!settings.trafficEnabled && !settings.expiryEnabled) return;
  if (!(await ensureNotificationPermission())) return;

  const normalized = normalizeMobileNotificationSettings(settings);
  const notifications: Parameters<typeof LocalNotifications.schedule>[0]["notifications"] = [];
  const trafficLimit = Number(snapshot.trafficLimit || 0);
  const trafficUsed = Number(snapshot.trafficUsed || 0);

  if (normalized.trafficEnabled && trafficLimit > 0) {
    const remainingPercent = Math.max(0, Math.round(((trafficLimit - trafficUsed) / trafficLimit) * 100));
    if (remainingPercent <= normalized.trafficThresholdPercent) {
      notifications.push({
        id: 40101,
        title: "ForwardX 流量提醒",
        body: `套餐流量剩余约 ${remainingPercent}%，请及时关注。`,
        schedule: { at: nextReminderDate(normalized.reminderTime) },
      });
    }
  }

  if (normalized.expiryEnabled && snapshot.expiresAt) {
    const expiresAt = new Date(snapshot.expiresAt).getTime();
    if (Number.isFinite(expiresAt)) {
      const targetDate = dateAtReminderTime(expiresAt - normalized.expiryDaysBefore * 86_400_000, normalized.reminderTime);
      const notifyAt = Math.max(Date.now() + 60_000, targetDate.getTime());
      if (notifyAt <= expiresAt) {
        notifications.push({
          id: 40102,
          title: "ForwardX 套餐到期提醒",
          body: `套餐将在 ${normalized.expiryDaysBefore} 天内到期，请及时续费或联系管理员。`,
          schedule: { at: new Date(notifyAt) },
        });
      }
    }
  }

  if (notifications.length) await LocalNotifications.schedule({ notifications });
}

function compareVersions(a: string, b: string) {
  const pa = a.replace(/^v/i, "").split(".").map((n) => Number(n) || 0);
  const pb = b.replace(/^v/i, "").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function extractMobilePackageVersion(assetName: string, platform: "android" | "ios") {
  const pattern = platform === "ios"
    ? /^forwardx-ios-v?(\d+\.\d+\.\d+)(?:-[\w.-]+)?\.ipa$/i
    : /^forwardx-android-v?(\d+\.\d+\.\d+)(?:-[\w.-]+)?\.apk$/i;
  const match = assetName.match(pattern);
  return match?.[1] || null;
}

export async function openMobileReleasePage(url = RELEASES_URL) {
  const targetUrl = url || RELEASES_URL;
  if (mobileAuth.isNative) await Browser.open({ url: targetUrl });
  else window.open(targetUrl, "_blank", "noopener,noreferrer");
}

export async function checkMobileAppUpdate(options: { silent?: boolean } = {}): Promise<MobileAppUpdateResult | null> {
  if (!mobileAuth.isNative) return null;

  try {
    const [appInfo, response] = await Promise.all([
      App.getInfo(),
      fetch(RELEASES_API_URL, {
        headers: { Accept: "application/vnd.github+json" },
      }),
    ]);
    if (!response.ok) throw new Error(`GitHub ${response.status}`);

    const releases = await response.json();
    const current = String(appInfo.version || "").replace(/^v/i, "");
    const platform = mobileAuth.platform === "ios" ? "ios" : "android";
    const packageLabel = platform === "ios" ? "IPA" : "APK";
    const packageCandidates = (Array.isArray(releases) ? releases : [])
      .flatMap((release: any) => (Array.isArray(release?.assets) ? release.assets : []).map((asset: any) => {
        const name = String(asset?.name || "");
        const version = extractMobilePackageVersion(name, platform);
        if (!version) return null;
        return {
          version,
          releaseUrl: release?.html_url || `${RELEASES_URL}/tag/${release?.tag_name || ""}`,
        };
      }))
      .filter(Boolean)
      .sort((a: any, b: any) => compareVersions(b.version, a.version));
    const latestPackage = packageCandidates[0] as { version: string; releaseUrl: string } | undefined;
    const latest = latestPackage?.version || current;
    const hasPackage = packageCandidates.length > 0;
    const hasUpdate = hasPackage && !!latest && !!current && compareVersions(latest, current) > 0;
    const releaseUrl = latestPackage?.releaseUrl || LATEST_RELEASE_URL;

    return {
      hasUpdate,
      currentVersion: current,
      latestVersion: latest,
      releaseUrl,
      platform,
      packageLabel,
      hasPackage,
      hasApk: platform === "android" && hasPackage,
    };
  } catch (error) {
    if (!options.silent) throw error;
    return null;
  }
}
