import nodemailer from "nodemailer";
import * as db from "./db";
import {
  buildSmtpTransportOptions,
  effectiveSmtpSecurityMode,
  resolveSmtpSecurityMode,
  smtpErrorMessage,
  withSmtpOperationTimeout,
} from "./smtpTransport";

export interface MailPayload {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

export async function getEmailConfig() {
  const settings = await db.getAllSettings();
  const port = Number(settings.emailPort || 587);
  const security = resolveSmtpSecurityMode(settings.emailSecurity, port, settings.emailSecure === "true");
  return {
    enabled: settings.emailEnabled === "true",
    host: settings.emailHost || "",
    port,
    security,
    secure: effectiveSmtpSecurityMode(security, port) === "implicit-tls",
    user: settings.emailUser || "",
    password: settings.emailPassword || "",
    from: settings.emailFrom || settings.emailUser || "",
    verifyRegistration: settings.emailVerifyRegistration === "true",
    whitelistEnabled: settings.emailWhitelistEnabled === "true",
    whitelist: settings.emailWhitelist || "",
    expiryReminder: settings.emailExpiryReminder === "true",
    trafficReminder: settings.emailTrafficReminder === "true",
    trafficReminderThreshold: Number(settings.emailTrafficReminderThreshold || 20),
  };
}

export async function sendMail(payload: MailPayload) {
  const config = await getEmailConfig();
  if (!config.enabled) return { skipped: true, reason: "email disabled" };
  if (!config.host || !config.from) throw new Error("邮件服务未配置完整");

  const transporter = nodemailer.createTransport(buildSmtpTransportOptions(config));
  try {
    const result = await withSmtpOperationTimeout(
      transporter.sendMail({
        from: config.from,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
      }),
      undefined,
      () => transporter.close(),
    );
    return { skipped: false, messageId: result.messageId };
  } catch (error) {
    throw new Error(smtpErrorMessage(error, config.port, config.security));
  } finally {
    transporter.close();
  }
}

export async function sendVerificationCode(to: string, code: string) {
  return sendMail({
    to,
    subject: "ForwardX 验证码",
    text: `你的 ForwardX 验证码是 ${code}，5 分钟内有效。`,
  });
}
