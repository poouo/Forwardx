import * as db from "./db";
import { getEmailConfig, parseAdminCopyRecipients, sendMail, type MailPayload } from "./email";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_REMINDER_DAYS = 3;
/** 连续失败达到该次数视为 SMTP 不可用，本轮不再逐个等待超时。 */
const MAX_CONSECUTIVE_SEND_FAILURES = 3;

export interface ReminderUser {
  id: number;
  username?: string | null;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  accountEnabled?: boolean | null;
  expiresAt?: Date | string | number | null;
  trafficLimit?: number | string | null;
  trafficUsed?: number | string | null;
}

export interface EmailReminderConfig {
  enabled: boolean;
  expiryReminder: boolean;
  trafficReminder: boolean;
  trafficReminderThreshold: number;
  adminCopy: boolean;
  adminCopyTo: string;
}

/** sent/already-sent：用户本人已收到；no-email：用户未填写邮箱；failed：发给本人失败。 */
export type ReminderOutcome = "sent" | "already-sent" | "no-email" | "failed";

export interface AdminDigestEntry {
  kind: "expiry" | "traffic";
  user: ReminderUser;
  outcome: ReminderOutcome;
  daysLeft?: number;
  expiresAt?: number;
  leftPercent?: number;
}

export interface EmailReminderDeps {
  getConfig: () => Promise<EmailReminderConfig>;
  listUsers: () => Promise<ReminderUser[]>;
  getMarkers: (keys: string[]) => Promise<Record<string, string | null>>;
  setMarkers: (keys: string[]) => Promise<void>;
  sendMail: (payload: MailPayload) => Promise<unknown>;
  now: () => number;
  logError: (message: string, error?: unknown) => void;
}

const defaultDeps: EmailReminderDeps = {
  getConfig: getEmailConfig,
  listUsers: () => db.getUserTrafficSummaries() as Promise<ReminderUser[]>,
  getMarkers: (keys) => db.getSettings(keys),
  setMarkers: (keys) => db.setSettings(Object.fromEntries(keys.map((key) => [key, "sent"]))),
  sendMail,
  now: () => Date.now(),
  logError: (message, error) => console.error(message, error),
};

function userLabel(user: ReminderUser) {
  const username = String(user.username || "").trim() || `#${user.id}`;
  const name = String(user.name || "").trim();
  const email = String(user.email || "").trim();
  return `${username}${name && name !== username ? `（${name}）` : ""}${email && email !== username ? ` <${email}>` : ""}`;
}

function outcomeNote(outcome: ReminderOutcome) {
  if (outcome === "no-email") return "［未填写邮箱，未通知本人］";
  if (outcome === "failed") return "［通知本人失败］";
  return "";
}

function expiryText(daysLeft: number) {
  return daysLeft <= 0 ? "已到期" : `${daysLeft} 天内到期`;
}

export function buildAdminReminderDigest(entries: AdminDigestEntry[]) {
  const expiring = entries.filter((entry) => entry.kind === "expiry");
  const lowTraffic = entries.filter((entry) => entry.kind === "traffic");
  const summary = [
    expiring.length ? `${expiring.length} 位即将到期` : "",
    lowTraffic.length ? `${lowTraffic.length} 位流量不足` : "",
  ].filter(Boolean).join("，");
  const lines = ["以下用户触发了邮件提醒：", ""];
  if (expiring.length) {
    lines.push(`即将到期（${expiring.length}）`);
    for (const entry of expiring) {
      const date = entry.expiresAt ? `（${new Date(entry.expiresAt).toLocaleDateString("zh-CN")}）` : "";
      lines.push(`- ${userLabel(entry.user)}：${expiryText(entry.daysLeft ?? 0)}${date}${outcomeNote(entry.outcome)}`);
    }
    lines.push("");
  }
  if (lowTraffic.length) {
    lines.push(`流量不足（${lowTraffic.length}）`);
    for (const entry of lowTraffic) {
      lines.push(`- ${userLabel(entry.user)}：剩余约 ${entry.leftPercent ?? 0}%${outcomeNote(entry.outcome)}`);
    }
    lines.push("");
  }
  lines.push("此邮件由邮箱设置中的「抄送管理员」开关发送。");
  return { subject: `ForwardX 用户提醒：${summary}`, text: lines.join("\n") };
}

/** 接收邮箱留空时，发给所有已填写邮箱且未停用的管理员账号。 */
export function resolveAdminCopyRecipients(adminCopyTo: string, users: ReminderUser[]) {
  const configured = parseAdminCopyRecipients(adminCopyTo).valid;
  if (configured.length) return configured;
  const admins = users
    .filter((user) => user.role === "admin" && user.accountEnabled !== false)
    .map((user) => String(user.email || "").trim())
    .filter(Boolean);
  return parseAdminCopyRecipients(admins.join(",")).valid;
}

interface ReminderCandidate {
  kind: "expiry" | "traffic";
  user: ReminderUser;
  email: string;
  marker: string;
  adminMarker: string;
  mail: Omit<MailPayload, "to">;
  daysLeft?: number;
  expiresAt?: number;
  leftPercent?: number;
}

function collectCandidates(config: EmailReminderConfig, users: ReminderUser[], now: number) {
  const day = new Date(now).toISOString().slice(0, 10);
  const candidates: ReminderCandidate[] = [];
  for (const user of users) {
    if (user.accountEnabled === false) continue;
    const email = String(user.email || "").trim();
    // 没有邮箱的用户只在抄送管理员时才有意义。
    if (!email && !config.adminCopy) continue;

    if (config.expiryReminder && user.expiresAt) {
      const expiresAt = new Date(user.expiresAt).getTime();
      const daysLeft = Math.max(0, Math.ceil((expiresAt - now) / DAY_MS));
      if (Number.isFinite(expiresAt) && expiresAt - now > -DAY_MS && daysLeft <= EXPIRY_REMINDER_DAYS) {
        candidates.push({
          kind: "expiry", user, email, daysLeft, expiresAt,
          marker: `emailReminder:expiry:${daysLeft}:${user.id}:${day}`,
          adminMarker: `emailReminder:adminExpiry:${daysLeft}:${user.id}:${day}`,
          mail: {
            subject: "ForwardX 套餐到期提醒",
            text: `你的 ForwardX 套餐${daysLeft === 0 ? "已到期" : `将在 ${daysLeft} 天内到期`}，请及时续费或联系管理员。`,
          },
        });
      }
    }

    const limit = Number(user.trafficLimit || 0);
    if (config.trafficReminder && limit > 0) {
      const used = Number(user.trafficUsed || 0);
      const leftPercent = Math.max(0, Math.round(((limit - used) / limit) * 100));
      if (leftPercent <= config.trafficReminderThreshold) {
        candidates.push({
          kind: "traffic", user, email, leftPercent,
          marker: `emailReminder:traffic:${user.id}:${day}`,
          adminMarker: `emailReminder:adminTraffic:${user.id}:${day}`,
          mail: {
            subject: "ForwardX 流量余量提醒",
            text: `你的 ForwardX 流量剩余约 ${leftPercent}%，请及时续费或联系管理员。`,
          },
        });
      }
    }
  }
  return candidates;
}

/**
 * 每位用户每类提醒每天最多发一封；单个用户发送失败不影响其他用户。
 * 开启抄送管理员后，本轮新触发的提醒会汇总成一封邮件发给管理员。
 */
export async function runEmailReminderSweep(deps: EmailReminderDeps = defaultDeps) {
  const result = { userSent: 0, userFailed: 0, adminEntries: 0, adminSent: false, aborted: false };
  const config = await deps.getConfig();
  if (!config.enabled || (!config.expiryReminder && !config.trafficReminder)) return result;

  const users = await deps.listUsers();
  const candidates = collectCandidates(config, users, deps.now());
  if (!candidates.length) return result;

  const markers = await deps.getMarkers(candidates.flatMap((candidate) =>
    config.adminCopy ? [candidate.marker, candidate.adminMarker] : [candidate.marker]));
  const digest: Array<AdminDigestEntry & { adminMarker: string }> = [];
  let consecutiveFailures = 0;

  for (const candidate of candidates) {
    let outcome: ReminderOutcome;
    if (!candidate.email) {
      outcome = "no-email";
    } else if (markers[candidate.marker]) {
      outcome = "already-sent";
    } else {
      try {
        await deps.sendMail({ to: candidate.email, ...candidate.mail });
        await deps.setMarkers([candidate.marker]);
        outcome = "sent";
        result.userSent++;
        consecutiveFailures = 0;
      } catch (error) {
        outcome = "failed";
        result.userFailed++;
        // 收件地址被拒只影响这一位用户，不计入 SMTP 故障。
        if ((error as { cause?: { code?: string } })?.cause?.code !== "EENVELOPE") consecutiveFailures++;
        deps.logError(`[Scheduler] Email reminder to user ${candidate.user.id} failed:`, error);
      }
    }
    if (consecutiveFailures >= MAX_CONSECUTIVE_SEND_FAILURES) {
      result.aborted = true;
      deps.logError("[Scheduler] Email reminders paused until the next sweep after repeated send failures");
      return result;
    }
    if (config.adminCopy && !markers[candidate.adminMarker]) {
      const { kind, user, daysLeft, expiresAt, leftPercent, adminMarker } = candidate;
      digest.push({ kind, user, outcome, daysLeft, expiresAt, leftPercent, adminMarker });
    }
  }

  if (!digest.length) return result;
  result.adminEntries = digest.length;
  const recipients = resolveAdminCopyRecipients(config.adminCopyTo, users);
  if (!recipients.length) {
    deps.logError("[Scheduler] Admin copy skipped: no recipient address and no admin account has an email");
    return result;
  }
  try {
    await deps.sendMail({ to: recipients.join(", "), ...buildAdminReminderDigest(digest) });
    await deps.setMarkers(digest.map((entry) => entry.adminMarker));
    result.adminSent = true;
  } catch (error) {
    deps.logError("[Scheduler] Admin reminder copy failed:", error);
  }
  return result;
}
