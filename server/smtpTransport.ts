export const SMTP_SECURITY_MODES = ["auto", "implicit-tls", "starttls", "none"] as const;

export type SmtpSecurityMode = (typeof SMTP_SECURITY_MODES)[number];
export type EffectiveSmtpSecurityMode = Exclude<SmtpSecurityMode, "auto">;

export const SMTP_DNS_TIMEOUT_MS = 8_000;
export const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
export const SMTP_GREETING_TIMEOUT_MS = 10_000;
export const SMTP_SOCKET_TIMEOUT_MS = 20_000;
export const SMTP_OPERATION_TIMEOUT_MS = 25_000;

const smtpSecurityModeSet = new Set<string>(SMTP_SECURITY_MODES);

export function resolveSmtpSecurityMode(raw: unknown, port: number, legacySecure = false): SmtpSecurityMode {
  const value = String(raw || "").trim().toLowerCase();
  if (smtpSecurityModeSet.has(value)) return value as SmtpSecurityMode;

  // Correct legacy configurations that used the old generic "SSL" switch.
  // Nodemailer's secure=true means implicit TLS and is invalid on port 587.
  if (port === 465 || port === 587) return "auto";
  return legacySecure ? "implicit-tls" : "auto";
}

export function effectiveSmtpSecurityMode(mode: SmtpSecurityMode, port: number): EffectiveSmtpSecurityMode {
  if (mode !== "auto") return mode;
  return port === 465 ? "implicit-tls" : "starttls";
}

export function buildSmtpTransportOptions(config: {
  host: string;
  port: number;
  security: SmtpSecurityMode;
  user?: string;
  password?: string;
}) {
  const security = effectiveSmtpSecurityMode(config.security, config.port);
  return {
    host: config.host,
    port: config.port,
    secure: security === "implicit-tls",
    requireTLS: security === "starttls",
    ignoreTLS: security === "none",
    auth: config.user ? { user: config.user, pass: config.password || "" } : undefined,
    dnsTimeout: SMTP_DNS_TIMEOUT_MS,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  };
}

export class SmtpOperationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`SMTP operation timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
    this.name = "SmtpOperationTimeoutError";
  }
}

export async function withSmtpOperationTimeout<T>(
  operation: Promise<T>,
  timeoutMs = SMTP_OPERATION_TIMEOUT_MS,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(new SmtpOperationTimeoutError(timeoutMs));
      }
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type SmtpErrorLike = Error & {
  code?: string;
  command?: string;
  response?: string;
  responseCode?: number;
};

function smtpErrorDetail(error: unknown) {
  if (!(error instanceof Error)) return String(error || "");
  const smtpError = error as SmtpErrorLike;
  return [smtpError.message, smtpError.response, smtpError.code, smtpError.command]
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function smtpErrorMessage(error: unknown, port: number, security: SmtpSecurityMode) {
  const detail = smtpErrorDetail(error);
  const normalized = detail.toLowerCase();
  const smtpError = error instanceof Error ? error as SmtpErrorLike : undefined;

  if (error instanceof SmtpOperationTimeoutError || /timed?\s*out|timeout/.test(normalized)) {
    return `SMTP 连接或发送超时，请检查服务器地址、端口和防火墙（端口 ${port}）`;
  }
  if (/wrong version number|unknown protocol|ssl routines/.test(normalized)) {
    return "SMTP TLS 模式不匹配：465 端口应使用隐式 TLS，587 端口应使用 STARTTLS";
  }
  if (smtpError?.code === "EAUTH" || smtpError?.responseCode === 535 || /authentication|invalid login|auth failed/.test(normalized)) {
    return "SMTP 登录失败，请检查用户名、密码或授权码";
  }
  if (/self[- ]signed|certificate|cert_has_expired|unable to verify/.test(normalized)) {
    return "SMTP TLS 证书校验失败，请检查服务器证书和主机名";
  }
  if (smtpError?.code === "ENOTFOUND" || smtpError?.code === "EAI_AGAIN") {
    return "无法解析 SMTP 服务器地址，请检查主机名或 DNS";
  }
  if (smtpError?.code === "ECONNREFUSED" || smtpError?.code === "ECONNECTION") {
    return `无法连接 SMTP 服务器 ${port} 端口，请检查地址、端口和网络策略`;
  }

  const mode = effectiveSmtpSecurityMode(security, port);
  const safeDetail = detail.replace(/\s+/g, " ").slice(0, 300) || "未知错误";
  return `SMTP 发送失败（${mode}）：${safeDetail}`;
}
