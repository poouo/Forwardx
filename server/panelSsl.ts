import fs from "fs";
import net from "net";
import path from "path";
import tls from "tls";
import crypto from "crypto";
import { spawn } from "child_process";
import type { ServerOptions } from "https";
import { ENV } from "./env";
import { getAllSettings } from "./repositories/settingsRepository";

export type PanelSslSettings = {
  enabled: boolean;
  mode: "path" | "pem";
  certPath: string;
  keyPath: string;
  certPem: string;
  keyPem: string;
};

export type PanelSslRuntimeConfig = {
  enabled: boolean;
  settings: PanelSslSettings;
  options?: ServerOptions;
  error?: string;
};

export type GeneratedPanelSslCertificate = {
  certPath: string;
  keyPath: string;
  hosts: string[];
  days: number;
};

export function readPanelSslSettings(all: Record<string, string | null | undefined>): PanelSslSettings {
  const storedEnabled = all.panelSslEnabled;
  const mode = all.panelSslMode === "pem" ? "pem" : "path";
  return {
    enabled: storedEnabled === undefined || storedEnabled === null
      ? ENV.panelSslEnabled
      : storedEnabled === "true",
    mode,
    certPath: String(all.panelSslCertPath ?? ENV.panelSslCertPath ?? "").trim(),
    keyPath: String(all.panelSslKeyPath ?? ENV.panelSslKeyPath ?? "").trim(),
    certPem: String(all.panelSslCertPem ?? "").trim(),
    keyPem: String(all.panelSslKeyPem ?? "").trim(),
  };
}

function normalizePem(value: string) {
  return `${String(value || "").trim()}\n`;
}

function validatePanelSslPem(settings: PanelSslSettings): ServerOptions {
  const certText = normalizePem(settings.certPem);
  const keyText = normalizePem(settings.keyPem);
  if (!settings.certPem || !settings.keyPem) {
    throw new Error("粘贴证书模式下必须填写证书内容和私钥内容");
  }
  if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(certText)) {
    throw new Error("证书内容不是有效的 PEM 证书");
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/.test(keyText)) {
    throw new Error("私钥内容不是有效的 PEM 私钥");
  }

  try {
    tls.createSecureContext({ cert: certText, key: keyText });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`证书或私钥校验失败：${message}`);
  }
  return { cert: certText, key: keyText };
}

export async function validatePanelSslConfig(settings: PanelSslSettings): Promise<ServerOptions | null> {
  if (!settings.enabled) return null;
  if (settings.mode === "pem") return validatePanelSslPem(settings);

  if (!settings.certPath || !settings.keyPath) {
    throw new Error("开启面板 SSL 后必须填写证书文件和私钥文件路径");
  }

  let cert: Buffer;
  let key: Buffer;
  try {
    [cert, key] = await Promise.all([
      fs.promises.readFile(settings.certPath),
      fs.promises.readFile(settings.keyPath),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`证书或私钥文件读取失败：${message}`);
  }

  try {
    tls.createSecureContext({ cert, key });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`证书或私钥校验失败：${message}`);
  }

  return { cert, key };
}

function normalizeSelfSignedHost(value: string) {
  let host = String(value || "").trim();
  if (!host) return "";
  if (/^https?:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "";
    }
  }
  host = host.replace(/^\[/, "").replace(/\]$/, "").replace(/\.+$/, "");
  if (!host) return "";
  if (net.isIP(host)) return host;
  if (host.includes(":")) return "";
  if (host.length > 253) return "";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(host)) return "";
  if (host.split(".").some((part) => !part || part.length > 63 || part.startsWith("-") || part.endsWith("-"))) return "";
  return host.toLowerCase();
}

function defaultPanelSslCertDir() {
  const configured = String(process.env.FORWARDX_PANEL_SSL_CERT_DIR || "").trim();
  if (configured) return configured;
  if (process.platform === "win32") return path.resolve(process.cwd(), "data", "certs");
  return path.join(path.dirname(ENV.sqlitePath || "/data/forwardx.db"), "certs");
}

function runOpenSsl(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("openssl", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("openssl 执行超时"));
    }, 15000);

    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === "ENOENT") reject(new Error("系统未安装 openssl，无法自动生成自签证书"));
      else reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const output = Buffer.concat(chunks).toString("utf8").trim();
      reject(new Error(output || `openssl exited with code ${code}`));
    });
  });
}

export async function generateSelfSignedPanelSslCertificate(inputHosts: string[] = [], days = 825): Promise<GeneratedPanelSslCertificate> {
  const hostSet = new Set<string>();
  for (const host of inputHosts) {
    const normalized = normalizeSelfSignedHost(host);
    if (normalized) hostSet.add(normalized);
  }
  hostSet.add("localhost");
  hostSet.add("127.0.0.1");

  const hosts = Array.from(hostSet).slice(0, 20);
  const san = hosts.map((host) => (net.isIP(host) ? `IP:${host}` : `DNS:${host}`)).join(",");
  const cn = (hosts.find((host) => !net.isIP(host)) || "ForwardX Panel").replace(/[\/\\]/g, "-").slice(0, 64);
  const normalizedDays = Math.min(3650, Math.max(1, Math.floor(Number(days) || 825)));
  const certDir = defaultPanelSslCertDir();
  await fs.promises.mkdir(certDir, { recursive: true });

  const suffix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const tempCertPath = path.join(certDir, `.panel-selfsigned-${suffix}.crt`);
  const tempKeyPath = path.join(certDir, `.panel-selfsigned-${suffix}.key`);
  const certPath = path.join(certDir, "panel-selfsigned.crt");
  const keyPath = path.join(certDir, "panel-selfsigned.key");

  try {
    await runOpenSsl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      String(normalizedDays),
      "-subj",
      `/CN=${cn}`,
      "-addext",
      `subjectAltName=${san}`,
      "-keyout",
      tempKeyPath,
      "-out",
      tempCertPath,
    ]);
    await validatePanelSslConfig({
      enabled: true,
      mode: "path",
      certPath: tempCertPath,
      keyPath: tempKeyPath,
      certPem: "",
      keyPem: "",
    });
    await fs.promises.rm(certPath, { force: true }).catch(() => undefined);
    await fs.promises.rm(keyPath, { force: true }).catch(() => undefined);
    await fs.promises.rename(tempCertPath, certPath);
    await fs.promises.rename(tempKeyPath, keyPath);
    await fs.promises.chmod(keyPath, 0o600).catch(() => undefined);
    return { certPath, keyPath, hosts, days: normalizedDays };
  } finally {
    await fs.promises.rm(tempCertPath, { force: true }).catch(() => undefined);
    await fs.promises.rm(tempKeyPath, { force: true }).catch(() => undefined);
  }
}

export async function loadPanelSslRuntimeConfig(): Promise<PanelSslRuntimeConfig> {
  let all: Record<string, string | null | undefined> = {};
  try {
    all = await getAllSettings();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[PanelSSL] Settings unavailable: ${message}; using environment SSL settings only`);
  }
  const settings = readPanelSslSettings(all);
  if (!settings.enabled) return { enabled: false, settings };

  try {
    const options = await validatePanelSslConfig(settings);
    return { enabled: true, settings, options: options || undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[PanelSSL] ${message}; falling back to HTTP`);
    return { enabled: false, settings, error: message };
  }
}
