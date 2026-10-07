import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { GOOGLE_CALLBACK_PATH, GOOGLE_AUTH_MESSAGES, type GoogleAuthErrorCode } from "../shared/googleAuth";
import { getSetting } from "./repositories/settingsRepository";

// The credential key is deliberately recognized by config-audit/support redaction.
export const GOOGLE_SETTINGS_KEY = "googleOAuthCredentials";
export const GOOGLE_FLOW_COOKIE = "forwardx_google_flow";
export const GOOGLE_FLOW_TTL_MS = 10 * 60_000;
export type GoogleSettings = { enabled: boolean; clientId: string; clientSecret: string; redirectUri: string };
export class GoogleAuthError extends Error {
  constructor(public readonly code: GoogleAuthErrorCode) { super(GOOGLE_AUTH_MESSAGES[code]); }
}

export function normalizeGoogleRedirectUri(raw: string) {
  try {
    const url = new URL(raw.trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== GOOGLE_CALLBACK_PATH
      || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) return "";
    return url.href;
  } catch { return ""; }
}

export function readGoogleSettings(raw: string | null | undefined): GoogleSettings {
  let data: any = {};
  try { data = JSON.parse(raw || "{}"); } catch { /* disabled when malformed */ }
  return {
    enabled: data?.enabled === true,
    clientId: typeof data?.clientId === "string" ? data.clientId.trim() : "",
    clientSecret: typeof data?.clientSecret === "string" ? data.clientSecret.trim() : "",
    redirectUri: typeof data?.redirectUri === "string" ? normalizeGoogleRedirectUri(data.redirectUri) : "",
  };
}
export const getGoogleSettings = async () => readGoogleSettings(await getSetting(GOOGLE_SETTINGS_KEY));
export const googleConfigured = (config: GoogleSettings) => !!(config.clientId && config.clientSecret && config.redirectUri);
export const googleSettingsSummary = (config: GoogleSettings) => ({
  enabled: config.enabled, configured: googleConfigured(config), clientId: config.clientId,
  redirectUri: config.redirectUri, secretConfigured: !!config.clientSecret,
});
const fingerprint = (config: GoogleSettings) => crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

type GoogleFlow = { expiresAt: number; browserHash: string; nonce: string; verifier: string; configHash: string;
  userId?: number; sid?: string };

// Short-lived, bounded, single-use state. A panel restart requires restarting login,
// never accepting an unverified callback. Parallel browser tabs fail closed.
export class GoogleFlowStore {
  private flows = new Map<string, GoogleFlow>();
  private rates = new Map<string, { count: number; until: number }>();
  private nextPrune = 0;
  constructor(private readonly maxSize = 10_000) {}
  create(config: GoogleSettings, ip: string, binding?: { userId: number; sid: string }, now = Date.now()) {
    if (!config.enabled || !googleConfigured(config)) throw new GoogleAuthError("disabled");
    if (now >= this.nextPrune) {
      for (const [key, item] of this.flows) if (item.expiresAt <= now) this.flows.delete(key);
      for (const [key, item] of this.rates) if (item.until <= now) this.rates.delete(key);
      this.nextPrune = now + 30_000;
    }
    const entry = this.rates.get(ip);
    if (this.flows.size >= this.maxSize || (!entry && this.rates.size >= this.maxSize)) throw new GoogleAuthError("rate_limited");
    const rate = entry && entry.until > now ? entry : { count: 0, until: now + GOOGLE_FLOW_TTL_MS };
    if (++rate.count > 20) throw new GoogleAuthError("rate_limited");
    this.rates.set(ip, rate);
    const state = crypto.randomBytes(32).toString("base64url");
    const browserToken = crypto.randomBytes(32).toString("base64url");
    const flow: GoogleFlow = { expiresAt: now + GOOGLE_FLOW_TTL_MS, browserHash: digest(browserToken),
      nonce: crypto.randomBytes(32).toString("base64url"), verifier: crypto.randomBytes(48).toString("base64url"),
      configHash: fingerprint(config), ...binding };
    this.flows.set(state, flow);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
      response_type: "code", scope: "openid email profile", state, nonce: flow.nonce,
      code_challenge: crypto.createHash("sha256").update(flow.verifier).digest("base64url"),
      code_challenge_method: "S256", prompt: "select_account" }).toString();
    return { url: url.href, browserToken };
  }
  consume(state: unknown, browserToken: unknown, config: GoogleSettings, now = Date.now()) {
    if (typeof state !== "string" || typeof browserToken !== "string" || state.length > 128 || browserToken.length > 128) throw new GoogleAuthError("invalid_state");
    const flow = this.flows.get(state);
    if (!flow || flow.expiresAt <= now || digest(browserToken) !== flow.browserHash) throw new GoogleAuthError("invalid_state");
    this.flows.delete(state);
    if (!config.enabled || !googleConfigured(config) || fingerprint(config) !== flow.configHash) throw new GoogleAuthError("disabled");
    return flow;
  }
}
export const googleFlows = new GoogleFlowStore();

async function googleJson(url: string, init?: RequestInit) {
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("provider");
    const text = await response.text();
    if (text.length > 128_000) throw new Error("size");
    return JSON.parse(text);
  } catch { throw new GoogleAuthError("provider_error"); }
}

type GoogleJwk = crypto.JsonWebKey & { kid: string; alg?: string; use?: string };
let keyCache: { keys: GoogleJwk[]; expiresAt: number } | null = null;
let keyRequest: Promise<GoogleJwk[]> | null = null;
let lastKeyFetch = 0;
async function googleSigningKey(kid: string) {
  const now = Date.now();
  const cached = keyCache?.keys.find(key => key.kid === kid);
  if (cached && keyCache!.expiresAt > now) return cached;
  if (!keyRequest && now - lastKeyFetch >= 30_000) {
    lastKeyFetch = now;
    keyRequest = googleJson("https://www.googleapis.com/oauth2/v3/certs").then(data => {
      if (!Array.isArray(data?.keys) || data.keys.length > 16) throw new GoogleAuthError("provider_error");
      const keys = data.keys.filter((key: any) => key.kty === "RSA" && key.use === "sig" && key.alg === "RS256" && typeof key.kid === "string") as GoogleJwk[];
      keyCache = { keys, expiresAt: Date.now() + 30 * 60_000 };
      return keys;
    }).finally(() => { keyRequest = null; });
  }
  if (keyRequest) await keyRequest;
  const key = keyCache?.expiresAt && keyCache.expiresAt > Date.now() ? keyCache.keys.find(item => item.kid === kid) : undefined;
  if (!key) throw new GoogleAuthError("invalid_identity");
  return key;
}

export function verifyGoogleClaims(token: string, key: crypto.KeyObject, clientId: string, nonce: string) {
  try {
    const claims = jwt.verify(token, key, { algorithms: ["RS256"], audience: clientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"], clockTolerance: 30 });
    if (typeof claims === "string" || claims.nonce !== nonce || claims.email_verified !== true
      || typeof claims.sub !== "string" || !/^[a-zA-Z0-9_-]{1,255}$/.test(claims.sub)
      || typeof claims.exp !== "number" || typeof claims.iat !== "number" || claims.iat > Date.now() / 1000 + 30
      || (claims.azp !== undefined && claims.azp !== clientId)
      || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId)
      || !z.string().email().max(254).safeParse(claims.email).success) throw new Error("claims");
    return { subject: claims.sub, email: String(claims.email).trim().toLowerCase(), name: String(claims.name || "").trim().slice(0, 24) };
  } catch { throw new GoogleAuthError("invalid_identity"); }
}

let activeExchanges = 0;
export async function exchangeGoogleCode(config: GoogleSettings, flow: GoogleFlow, code: unknown) {
  // Bound outbound work without creating a queue of waiting login promises.
  if (activeExchanges >= 32) throw new GoogleAuthError("rate_limited");
  activeExchanges++;
  try { return await exchangeCode(config, flow, code); }
  finally { activeExchanges--; }
}
async function exchangeCode(config: GoogleSettings, flow: GoogleFlow, code: unknown) {
  if (typeof code !== "string" || !code || code.length > 4096) throw new GoogleAuthError("invalid_identity");
  const data = await googleJson("https://oauth2.googleapis.com/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirectUri, grant_type: "authorization_code", code_verifier: flow.verifier }) });
  if (typeof data?.id_token !== "string" || data.id_token.length > 16_384) throw new GoogleAuthError("invalid_identity");
  const decoded = jwt.decode(data.id_token, { complete: true });
  if (!decoded || decoded.header.alg !== "RS256" || typeof decoded.header.kid !== "string" || decoded.header.kid.length > 256) throw new GoogleAuthError("invalid_identity");
  const jwk = await googleSigningKey(decoded.header.kid);
  let key: crypto.KeyObject;
  try { key = crypto.createPublicKey({ key: jwk, format: "jwk" }); } catch { throw new GoogleAuthError("invalid_identity"); }
  return verifyGoogleClaims(data.id_token, key, config.clientId, flow.nonce);
}
