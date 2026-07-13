import * as db from "../db";

export type AiProvider = "deepseek" | "siliconflow" | "custom";

export const DEFAULT_AI_PROVIDER: AiProvider = "deepseek";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
export const DEFAULT_SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";
export const DEFAULT_SILICONFLOW_MODEL = "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B";
export const DEFAULT_DEEPSEEK_MAX_TOKENS = 1024;
export const DEFAULT_DEEPSEEK_TEMPERATURE = 0.2;

export type AiProviderConfigRuntime = {
  provider: AiProvider;
  configured: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
};

export type ForwardxAiSettings = AiProviderConfigRuntime & {
  enabled: boolean;
  chatCompletionsUrl: string;
  maxTokens: number;
  temperature: number;
  telegramUserManageEnabled: boolean;
  telegramAutoRecallEnabled: boolean;
  telegramAutoRecallSeconds: number;
  redemptionEnabled: boolean;
  discountEnabled: boolean;
};

export const AI_PROVIDER_SETTING_KEYS: Record<AiProvider, { apiKey: string; baseUrl: string; model: string }> = {
  deepseek: {
    apiKey: "deepseekApiKeyDeepseek",
    baseUrl: "deepseekBaseUrlDeepseek",
    model: "deepseekModelDeepseek",
  },
  siliconflow: {
    apiKey: "deepseekApiKeySiliconflow",
    baseUrl: "deepseekBaseUrlSiliconflow",
    model: "deepseekModelSiliconflow",
  },
  custom: {
    apiKey: "deepseekApiKeyCustom",
    baseUrl: "deepseekBaseUrlCustom",
    model: "deepseekModelCustom",
  },
};

type RawAiSettings = Record<string, string | null | undefined>;

export function normalizeDeepSeekNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

export function normalizeAiProvider(value: unknown): AiProvider {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "siliconflow") return "siliconflow";
  if (raw === "custom") return "custom";
  return DEFAULT_AI_PROVIDER;
}

export function normalizeAiApiKey(value: unknown) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  raw = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
  raw = raw.replace(/^bearer\s+/i, "").trim();
  return raw.replace(/^["'`]+|["'`]+$/g, "").trim();
}

export function getAiProviderDefaultBaseUrl(provider: AiProvider) {
  return provider === "siliconflow" ? DEFAULT_SILICONFLOW_BASE_URL : DEFAULT_DEEPSEEK_BASE_URL;
}

export function getAiProviderDefaultModel(provider: AiProvider) {
  return provider === "siliconflow" ? DEFAULT_SILICONFLOW_MODEL : DEFAULT_DEEPSEEK_MODEL;
}

export function getAiProviderSettingKeys(provider: AiProvider) {
  return AI_PROVIDER_SETTING_KEYS[provider];
}

export function readAiProviderConfig(all: RawAiSettings, provider: AiProvider): AiProviderConfigRuntime {
  const providerKeys = getAiProviderSettingKeys(provider);
  const defaultBaseUrl = getAiProviderDefaultBaseUrl(provider);
  const defaultModel = getAiProviderDefaultModel(provider);
  const legacyApiKey = provider === DEFAULT_AI_PROVIDER ? normalizeAiApiKey(all.deepseekApiKey) : "";
  const legacyBaseUrl = provider === DEFAULT_AI_PROVIDER ? String(all.deepseekBaseUrl || "").trim() : "";
  const legacyModel = provider === DEFAULT_AI_PROVIDER ? String(all.deepseekModel || "").trim() : "";
  const apiKey = normalizeAiApiKey(all[providerKeys.apiKey]) || legacyApiKey;
  const baseUrl = String(all[providerKeys.baseUrl] || legacyBaseUrl || defaultBaseUrl).trim().replace(/\/+$/, "") || defaultBaseUrl;
  const model = String(all[providerKeys.model] || legacyModel || defaultModel).trim() || defaultModel;
  return { provider, apiKey, configured: !!apiKey, baseUrl, model };
}

export function buildAiProviderConfigMap(all: RawAiSettings): Record<AiProvider, AiProviderConfigRuntime> {
  return {
    deepseek: readAiProviderConfig(all, "deepseek"),
    siliconflow: readAiProviderConfig(all, "siliconflow"),
    custom: readAiProviderConfig(all, "custom"),
  };
}

export function buildAiChatCompletionsUrl(baseUrl: string) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

export function normalizeTelegramAiAutoRecallSeconds(value: unknown) {
  return Math.floor(normalizeDeepSeekNumber(value, 60, 30, 1200));
}

export function resolveForwardxAiSettings(all: RawAiSettings): ForwardxAiSettings {
  const provider = normalizeAiProvider(all.deepseekProvider);
  const providerConfig = readAiProviderConfig(all, provider);
  return {
    ...providerConfig,
    enabled: all.deepseekAiEnabled === "true",
    chatCompletionsUrl: buildAiChatCompletionsUrl(providerConfig.baseUrl),
    maxTokens: normalizeDeepSeekNumber(all.deepseekMaxTokens, DEFAULT_DEEPSEEK_MAX_TOKENS, 128, 8192),
    temperature: normalizeDeepSeekNumber(all.deepseekTemperature, DEFAULT_DEEPSEEK_TEMPERATURE, 0, 2),
    telegramUserManageEnabled: all.telegramAiUserManageEnabled !== "false",
    telegramAutoRecallEnabled: all.telegramAiAutoRecallEnabled === "true",
    telegramAutoRecallSeconds: normalizeTelegramAiAutoRecallSeconds(all.telegramAiAutoRecallSeconds),
    redemptionEnabled: all.redemptionEnabled !== "false",
    discountEnabled: all.discountEnabled !== "false",
  };
}

const AI_SETTINGS_CACHE_TTL_MS = 3_000;
let cachedSettings: { expiresAt: number; value: ForwardxAiSettings } | null = null;

export function clearForwardxAiSettingsCache() {
  cachedSettings = null;
}

export async function getForwardxAiSettings(options: { forceRefresh?: boolean } = {}) {
  const now = Date.now();
  if (!options.forceRefresh && cachedSettings && cachedSettings.expiresAt > now) return cachedSettings.value;
  const value = resolveForwardxAiSettings(await db.getAllSettings());
  cachedSettings = { expiresAt: now + AI_SETTINGS_CACHE_TTL_MS, value };
  return value;
}
