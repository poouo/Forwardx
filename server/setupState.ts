import crypto from "crypto";
import fs from "fs";
import path from "path";
import { clearDatabaseSetupPendingConfig, getDatabaseConfigPath, defaultSqlitePath } from "./dbRuntime";

function markerPath() {
  const configured = String(process.env.FORWARDX_SETUP_COMPLETE_MARKER || "").trim();
  if (configured) return configured;
  const configPath = getDatabaseConfigPath();
  const dataDir = path.dirname(configPath || defaultSqlitePath());
  return path.join(dataDir, ".setup-complete");
}

function bootstrapTokenPath() {
  const configured = String(process.env.FORWARDX_SETUP_BOOTSTRAP_TOKEN_PATH || "").trim();
  if (configured) return configured;
  return path.join(path.dirname(markerPath()), ".setup-bootstrap-token");
}

function configuredBootstrapToken() {
  return String(process.env.FORWARDX_SETUP_BOOTSTRAP_TOKEN || "").trim();
}

export function ensureSetupBootstrapToken() {
  if (hasLocalSetupCompleteMarker()) return null;
  const fromEnvironment = configuredBootstrapToken();
  if (fromEnvironment) return fromEnvironment;
  const file = bootstrapTokenPath();
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Generate a local secret below.
  }
  const token = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  console.warn(`[Security] Initial setup bootstrap token generated. Read ${file} on the panel host, or use the local server log token: ${token}`);
  return token;
}

export function verifySetupBootstrapToken(value: unknown) {
  const expected = ensureSetupBootstrapToken();
  const provided = String(value || "").trim();
  if (!expected || !provided) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && crypto.timingSafeEqual(expectedBytes, providedBytes);
}

export function consumeSetupBootstrapToken() {
  if (configuredBootstrapToken()) return;
  try {
    fs.unlinkSync(bootstrapTokenPath());
  } catch {
    // The completion marker and database admin check still lock setup.
  }
}

export function hasLocalSetupCompleteMarker() {
  try {
    return fs.existsSync(markerPath());
  } catch {
    return false;
  }
}

export function markLocalSetupComplete() {
  try {
    const file = markerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });
    clearDatabaseSetupPendingConfig();
  } catch {
    // The database remains the source of truth; this marker only protects setup recovery.
  }
}
