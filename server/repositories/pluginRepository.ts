import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
import { eq } from "drizzle-orm";
import { hosts, pluginAssets, plugins } from "../../drizzle/schema";
import {
  BUILTIN_PLUGIN_STORE_ITEMS,
  DEFAULT_PLUGIN_MANIFEST,
  PLUGIN_ACTION_TYPES,
  PLUGIN_AGENT_EXECUTORS,
  PLUGIN_AGENT_INTERPRETERS,
  PLUGIN_AGENT_OUTPUT_TYPES,
  PLUGIN_AGENT_TARGETS,
  PLUGIN_EXTENSION_POINTS,
  PLUGIN_HTTP_AUTH_TYPES,
  PLUGIN_HTTP_METHODS,
  PLUGIN_HTTP_RESPONSE_TYPES,
  PLUGIN_MANIFEST_VERSION,
  PLUGIN_PERMISSION_KEYS,
  PLUGIN_USAGE_VIEW_TYPES,
  PLUGIN_USAGE_FIELD_TYPES,
  PLUGIN_SECURITY_MODEL,
  PLUGIN_SETTING_FIELD_TYPES,
  PLUGIN_PAGE_CONTENT_TYPES,
  type ForwardxPluginManifest,
  type PluginActionDefinition,
  type PluginAgentRequestDefinition,
  type PluginExtensionPoint,
  type PluginFeatureDescription,
  type PluginHttpAuthDefinition,
  type PluginHttpRequestDefinition,
  type PluginPageDefinition,
  type PluginPermissionKey,
  type PluginSettingField,
  type PluginStoreItem,
  type PluginUsageFieldDefinition,
  type PluginUsageOperationOption,
  type PluginUsageOperationSelector,
  type PluginUsageSelectorCopy,
  type PluginUsageViewDefinition,
} from "../../shared/pluginTypes";
import { executeRaw, getDatabaseKind, getDb, insertAndGetId, nowDate } from "../dbRuntime";
import { AGENT_PLUGIN_TASK_VERSION, isAgentVersionAtLeast } from "../agentRouteUtils";
import { enqueuePluginAgentTaskGroup, getPluginAgentTaskGroup } from "../pluginAgentTasks";
import { assertSafePluginHttpUrl } from "../ssrf";

const GITHUB_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)(?:[/?#].*)?$/i;
const FORWARDX_REPO_URL = "https://github.com/poouo/Forwardx";
const MANIFEST_CANDIDATES = ["forwardx-plugin.json", "plugin.json", ".forwardx/plugin.json"];
const OFFICIAL_STORE_PATH = "plugins/official-store.json";
const MAX_PLUGIN_UPLOAD_BYTES = PLUGIN_SECURITY_MODEL.maxUploadBytes;
const MAX_PLUGIN_ASSET_BYTES = PLUGIN_SECURITY_MODEL.maxAssetBytes;
const MAX_PLUGIN_ASSETS = 96;
const MAX_PLUGIN_FIELDS = 50;
const MAX_PLUGIN_PAGES = 12;
const MAX_PLUGIN_ACTIONS = 20;
const MAX_PLUGIN_FEATURES = 12;
const MAX_PLUGIN_USAGE_VIEWS = 8;
const MAX_PLUGIN_PACKAGE_BYTES = 5 * 1024 * 1024;
const MAX_PLUGIN_HTTP_TEMPLATE_BYTES = 64 * 1024;
const MAX_PLUGIN_HTTP_RESPONSE_BYTES = PLUGIN_SECURITY_MODEL.maxHttpResponseBytes;
const MAX_PLUGIN_HTTP_TIMEOUT_MS = 30 * 1000;
const DEFAULT_PLUGIN_HTTP_TIMEOUT_MS = 10 * 1000;
const PLUGIN_HOST_ASSET_ROOT = "/var/lib/forwardx-agent/plugins";
const MAX_PLUGIN_PACKAGE_FILES = 160;
const PACKAGE_MANIFEST_CANDIDATES = ["forwardx-plugin.json", "plugin.json", ".forwardx/plugin.json"];
const AUTO_DISCOVER_DATA_ROOTS = ["data/"];
const DATA_ASSET_EXTENSIONS = new Set([".txt", ".list", ".dat", ".json", ".tsv", ".csv", ".md", ".conf", ".yaml", ".yml"]);
const BUNDLED_PLUGIN_ROOT = path.resolve(process.cwd(), "plugins");
const MAX_WHITELIST_USAGE_HOSTS = 256;
const MAX_WHITELIST_USAGE_ASSETS = 16;
const MAX_WHITELIST_USAGE_SYNC_BYTES = 1024 * 1024;
const OFFICIAL_STORE_CACHE_TTL_MS = 10 * 60 * 1000;
const PLUGIN_WARN_THROTTLE_MS = 5 * 60 * 1000;
const PACKAGE_ASSET_EXTENSIONS = new Set([
  ...DATA_ASSET_EXTENSIONS,
  ".html",
  ".htm",
  ".css",
  ".svg",
  ".sh",
  ".py",
]);
const SKIPPED_DATA_PATH_PREFIXES = [".github/", "node_modules/", "dist/", "build/", "tests/"];
let officialStoreCache: { items: PluginStoreItem[]; checkedAt: number } | null = null;
let officialStoreFetchInFlight: Promise<PluginStoreItem[]> | null = null;
const pluginWarnCache = new Map<string, number>();

type GithubTreeItem = {
  path?: string;
  type?: string;
  size?: number;
};

type AssetSyncResult = {
  total: number;
  synced: number;
  skipped: number;
  paths: string[];
  errors: string[];
};

type AssetDeclaration = {
  contentType: string;
  remotePath: string;
  isData: boolean;
};

type PluginPackageFile = {
  path: string;
  content: Buffer;
};

export type HostAssetSyncUsageConfig = {
  enabled: boolean;
  hostIds: number[];
  assetPaths: string[];
  mode: "sync-files";
  operation?: string;
  fieldValues?: Record<string, unknown>;
  note?: string;
  cleanupHostIds?: number[];
  updatedAt?: string;
};

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function pluginSettingsValues(manifest: ForwardxPluginManifest): Record<string, unknown> {
  const values = (manifest as any)?.settingsValues;
  return values && typeof values === "object" && !Array.isArray(values) ? { ...values } : {};
}

function normalizePositiveIds(values: unknown) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isInteger(value) && value > 0)))
    .slice(0, MAX_WHITELIST_USAGE_HOSTS);
}

function normalizeUsageAssetPaths(values: unknown) {
  if (!Array.isArray(values)) return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const value of values.slice(0, MAX_WHITELIST_USAGE_ASSETS)) {
    try {
      const path = normalizeAssetPath(value);
      if (!path.startsWith("data/") || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    } catch {
      continue;
    }
  }
  return paths;
}

function usageViewAssetMode(view?: PluginUsageViewDefinition | null) {
  return view?.assetMode === "all-plugin-assets" ? "all-plugin-assets" : "selected-assets";
}

function defaultUsageOperation(view?: PluginUsageViewDefinition | null) {
  const options = view?.operationSelector?.options || [];
  const declaredDefault = String(view?.operationSelector?.defaultValue || "").trim();
  if (declaredDefault && options.some((option) => option.value === declaredDefault)) return declaredDefault;
  return options[0]?.value || "sync-files";
}

function normalizeUsageOperation(value: unknown, view?: PluginUsageViewDefinition | null) {
  const operation = normalizePluginId(value).slice(0, 40);
  const options = view?.operationSelector?.options || [];
  if (!options.length) return operation || defaultUsageOperation(view);
  return options.some((option) => option.value === operation) ? operation : defaultUsageOperation(view);
}

function normalizeUsageFieldValues(value: unknown, view?: PluginUsageViewDefinition | null) {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const fields = view?.fields || [];
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const incoming = raw[field.key] !== undefined ? raw[field.key] : field.defaultValue;
    if (field.type === "boolean") {
      values[field.key] = incoming === true;
      continue;
    }
    if (field.type === "multi-select") {
      const allowed = new Set((field.options || []).map((option) => option.value));
      const selected = Array.isArray(incoming)
        ? incoming.map((item) => String(item || "").trim()).filter((item) => item && (!allowed.size || allowed.has(item)))
        : [];
      values[field.key] = Array.from(new Set(selected)).slice(0, 80);
      continue;
    }
    const textLimit = field.type === "textarea" ? 10000 : 1000;
    const text = String(incoming ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").slice(0, textLimit);
    if (field.type === "select" && field.options?.length) {
      const allowed = new Set(field.options.map((option: { value: string }) => option.value));
      values[field.key] = allowed.has(text) ? text : String(field.defaultValue || field.options[0]?.value || "");
      continue;
    }
    values[field.key] = text;
  }
  return values;
}

function normalizeHostAssetSyncUsage(value: unknown, view?: PluginUsageViewDefinition | null): HostAssetSyncUsageConfig {
  const raw = value && typeof value === "object" ? value as any : {};
  return {
    enabled: raw.enabled === true,
    hostIds: normalizePositiveIds(raw.hostIds),
    assetPaths: normalizeUsageAssetPaths(raw.assetPaths),
    mode: "sync-files",
    operation: normalizeUsageOperation(raw.operation || raw.action, view),
    fieldValues: normalizeUsageFieldValues(raw.fieldValues, view),
    note: String(raw.note || "").trim().slice(0, 500) || undefined,
    cleanupHostIds: normalizePositiveIds(raw.cleanupHostIds),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
  };
}

function usageStorageKey(plugin: { pluginId?: string | null; manifest?: ForwardxPluginManifest }, usageViewId = "default") {
  const view = (plugin.manifest?.usageViews || []).find((item) => item.id === usageViewId)
    || (plugin.manifest?.usageViews || []).find((item) => item.type === "host-asset-sync");
  return view?.storageKey || `${normalizePluginId(plugin.pluginId)}.${normalizePluginId(view?.id || usageViewId)}.usage`;
}

function normalizeUsageStorageKey(value: unknown) {
  const key = String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "").slice(0, 80);
  return key || undefined;
}

function hostAssetSyncDir(pluginId: string, view?: PluginUsageViewDefinition | null) {
  void view;
  return `${PLUGIN_HOST_ASSET_ROOT}/${assertPluginId(pluginId)}`;
}

function firstHostAssetSyncView(manifest?: ForwardxPluginManifest) {
  return (manifest?.usageViews || []).find((item) => item.type === "host-asset-sync") || null;
}

function safeAgentPluginAssetName(assetPath: string) {
  return normalizeAssetPath(assetPath)
    .replace(/^data\//, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160) || "whitelist.txt";
}

function formatByteLimit(bytes: number) {
  if (bytes >= 1024 * 1024) return `${Math.floor(bytes / 1024 / 1024)}MB`;
  if (bytes >= 1024) return `${Math.floor(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function warnPluginThrottled(key: string, message: string) {
  const now = Date.now();
  const last = pluginWarnCache.get(key) || 0;
  if (now - last < PLUGIN_WARN_THROTTLE_MS) return;
  pluginWarnCache.set(key, now);
  console.warn(message);
}

function uniqueValidPermissions(values: unknown): PluginPermissionKey[] {
  const allowed = new Set<string>(PLUGIN_PERMISSION_KEYS);
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((item) => String(item || "").trim()).filter((item) => allowed.has(item)))) as PluginPermissionKey[];
}

function uniqueValidExtensionPoints(values: unknown): PluginExtensionPoint[] {
  const allowed = new Set<string>(PLUGIN_EXTENSION_POINTS);
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((item) => String(item || "").trim()).filter((item) => allowed.has(item)))) as PluginExtensionPoint[];
}

function normalizePluginId(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
}

function assertPluginId(value: unknown) {
  const id = normalizePluginId(value);
  if (!id || !/^[a-z0-9][a-z0-9._-]{1,127}$/.test(id)) {
    throw new Error("插件 ID 只能包含小写字母、数字、点、短横线或下划线，长度至少 2 位");
  }
  return id;
}

function normalizeVersion(value: unknown) {
  const text = String(value || "").trim().replace(/^v/i, "");
  return text.slice(0, 64) || "0.0.0";
}

function normalizeOptionalText(value: unknown, maxLength: number) {
  return String(value || "").trim().slice(0, maxLength) || undefined;
}

function normalizeDateText(value: unknown) {
  const text = String(value || "").trim().slice(0, 32);
  if (!text) return undefined;
  if (/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(text)) return text;
  return text;
}

function normalizeTags(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")).filter(Boolean)))
    .slice(0, 12)
    .map((item) => item.slice(0, 32));
}

function normalizeAssetPath(value: unknown) {
  const path = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .trim();
  if (!path || path.includes("..") || path.startsWith(".") || /[\u0000-\u001f]/.test(path)) {
    throw new Error("插件资产路径不合法");
  }
  return path.slice(0, 240);
}

function normalizeOptionalLogo(value: unknown) {
  const logo = String(value || "").trim();
  if (!logo) return undefined;
  if (/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,[a-z0-9+/=]+$/i.test(logo)) return logo.slice(0, 200000);
  if (/^https?:\/\//i.test(logo)) return logo.slice(0, 512);
  return undefined;
}

function normalizeSettingFields(value: unknown): PluginSettingField[] {
  if (!Array.isArray(value)) return [];
  const allowedTypes = new Set<string>(PLUGIN_SETTING_FIELD_TYPES);
  const seen = new Set<string>();
  return value.slice(0, MAX_PLUGIN_FIELDS).flatMap((item: any) => {
    const key = normalizePluginId(item?.key).slice(0, 80);
    if (!key || seen.has(key)) return [];
    const type = String(item?.type || "text").trim();
    if (!allowedTypes.has(type)) return [];
    seen.add(key);
    const field: PluginSettingField = {
      key,
      label: String(item?.label || key).trim().slice(0, 80) || key,
      type: type as PluginSettingField["type"],
      description: String(item?.description || "").trim().slice(0, 240) || undefined,
      placeholder: String(item?.placeholder || "").trim().slice(0, 160) || undefined,
      required: item?.required === true,
      defaultValue: typeof item?.defaultValue === "boolean" || typeof item?.defaultValue === "number" || typeof item?.defaultValue === "string"
        ? item.defaultValue
        : undefined,
      min: Number.isFinite(Number(item?.min)) ? Number(item.min) : undefined,
      max: Number.isFinite(Number(item?.max)) ? Number(item.max) : undefined,
      options: Array.isArray(item?.options)
        ? item.options.slice(0, 40).flatMap((option: any) => {
            const optionValue = String(option?.value ?? "").trim().slice(0, 120);
            if (!optionValue) return [];
            return [{
              value: optionValue,
              label: String(option?.label || optionValue).trim().slice(0, 120) || optionValue,
            }];
          })
        : undefined,
    };
    return [field];
  });
}

function normalizeHttpRecord(value: unknown, maxEntries: number, maxValueLength: number): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value).slice(0, maxEntries)) {
    const cleanKey = String(key || "").trim().slice(0, 120);
    if (!cleanKey || /[\u0000-\u001f]/.test(cleanKey)) continue;
    result[cleanKey] = String(rawValue ?? "").slice(0, maxValueLength);
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeHttpAuth(value: unknown): PluginHttpAuthDefinition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as any;
  const allowedTypes = new Set<string>(PLUGIN_HTTP_AUTH_TYPES);
  const type = allowedTypes.has(String(raw.type || "")) ? String(raw.type) as PluginHttpAuthDefinition["type"] : "none";
  if (type === "none") return undefined;
  const auth: PluginHttpAuthDefinition = { type };
  if (type === "bearer") {
    auth.token = String(raw.token ?? "").slice(0, 1000);
  } else if (type === "header") {
    auth.header = String(raw.header || "").trim().slice(0, 120);
    auth.value = String(raw.value ?? "").slice(0, 1000);
  } else if (type === "cookie") {
    auth.cookieName = String(raw.cookieName || "").trim().slice(0, 120);
    auth.cookieValue = String(raw.cookieValue ?? "").slice(0, 2000);
  }
  return auth;
}

function normalizeHttpBodyTemplate(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  const encoded = JSON.stringify(value);
  if (encoded && Buffer.byteLength(encoded, "utf8") > MAX_PLUGIN_HTTP_TEMPLATE_BYTES) return undefined;
  if (typeof value === "string") return value.slice(0, MAX_PLUGIN_HTTP_TEMPLATE_BYTES);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 80).map(normalizeHttpBodyTemplate);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      const cleanKey = String(key || "").trim().slice(0, 120);
      if (!cleanKey) continue;
      result[cleanKey] = normalizeHttpBodyTemplate(item);
    }
    return result;
  }
  return undefined;
}

function normalizeHttpRequest(value: unknown): PluginHttpRequestDefinition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as any;
  const allowedMethods = new Set<string>(PLUGIN_HTTP_METHODS);
  const method = String(raw.method || "GET").trim().toUpperCase();
  if (!allowedMethods.has(method)) return undefined;
  const responseTypes = new Set<string>(PLUGIN_HTTP_RESPONSE_TYPES);
  const responseType = responseTypes.has(String(raw.responseType || "")) ? String(raw.responseType) as PluginHttpRequestDefinition["responseType"] : "auto";
  const timeoutValue = Math.floor(Number(raw.timeoutMs || DEFAULT_PLUGIN_HTTP_TIMEOUT_MS));
  const timeoutMs = Number.isFinite(timeoutValue)
    ? Math.max(1000, Math.min(MAX_PLUGIN_HTTP_TIMEOUT_MS, timeoutValue))
    : DEFAULT_PLUGIN_HTTP_TIMEOUT_MS;
  const request: PluginHttpRequestDefinition = {
    method: method as PluginHttpRequestDefinition["method"],
    url: normalizeOptionalText(raw.url, 2000),
    baseUrlSetting: normalizePluginId(raw.baseUrlSetting).slice(0, 80) || undefined,
    path: normalizeOptionalText(raw.path, 1200),
    headers: normalizeHttpRecord(raw.headers, 40, 2000),
    query: normalizeHttpRecord(raw.query, 40, 2000),
    body: normalizeHttpBodyTemplate(raw.body),
    timeoutMs,
    responseType,
    auth: normalizeHttpAuth(raw.auth),
  };
  if (!request.url && (!request.baseUrlSetting || !request.path)) return undefined;
  return request;
}

function normalizePluginAgentEntry(value: unknown) {
  const entry = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!entry || entry.startsWith("/") || entry.includes("..") || /[\u0000-\u001f]/.test(entry)) return undefined;
  if (!/^[A-Za-z0-9._/-]{1,240}$/.test(entry)) return undefined;
  return entry;
}

function normalizePluginAgentRequest(value: unknown): PluginAgentRequestDefinition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as any;
  const executors = new Set<string>(PLUGIN_AGENT_EXECUTORS);
  const executor = String(raw.executor || "script").trim();
  if (!executors.has(executor)) return undefined;
  const entry = normalizePluginAgentEntry(raw.entry);
  if (!entry) return undefined;
  const interpreters = new Set<string>(PLUGIN_AGENT_INTERPRETERS);
  const interpreter = interpreters.has(String(raw.interpreter || ""))
    ? String(raw.interpreter) as PluginAgentRequestDefinition["interpreter"]
    : "bash";
  const outputTypes = new Set<string>(PLUGIN_AGENT_OUTPUT_TYPES);
  const outputType = outputTypes.has(String(raw.outputType || ""))
    ? String(raw.outputType) as PluginAgentRequestDefinition["outputType"]
    : "json";
  const targets = new Set<string>(PLUGIN_AGENT_TARGETS);
  const target = targets.has(String(raw.target || ""))
    ? String(raw.target) as PluginAgentRequestDefinition["target"]
    : "usage-hosts";
  const timeoutValue = Math.floor(Number(raw.timeoutMs || DEFAULT_PLUGIN_HTTP_TIMEOUT_MS));
  const timeoutMs = Number.isFinite(timeoutValue)
    ? Math.max(1000, Math.min(MAX_PLUGIN_HTTP_TIMEOUT_MS, timeoutValue))
    : DEFAULT_PLUGIN_HTTP_TIMEOUT_MS;
  const request: PluginAgentRequestDefinition = {
    executor: executor as PluginAgentRequestDefinition["executor"],
    interpreter,
    target,
    usageViewId: normalizePluginId(raw.usageViewId).slice(0, 80) || undefined,
    entry,
    arguments: Array.isArray(raw.arguments || raw.args)
      ? (raw.arguments || raw.args).slice(0, 24).map((item: unknown) => String(item ?? "").slice(0, 512))
      : [],
    timeoutMs,
    outputType,
  };
  return request;
}

function normalizePluginPages(value: unknown): PluginPageDefinition[] {
  if (!Array.isArray(value)) return [];
  const contentTypes = new Set<string>(PLUGIN_PAGE_CONTENT_TYPES);
  const seen = new Set<string>();
  return value.slice(0, MAX_PLUGIN_PAGES).flatMap((item: any) => {
    const id = normalizePluginId(item?.id).slice(0, 80);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const contentType = contentTypes.has(String(item?.contentType || "")) ? String(item.contentType) as PluginPageDefinition["contentType"] : "markdown";
    let assetPath: string | undefined;
    if (item?.assetPath) {
      try {
        assetPath = normalizeAssetPath(item.assetPath);
      } catch {
        assetPath = undefined;
      }
    }
    return [{
      id,
      title: String(item?.title || id).trim().slice(0, 100) || id,
      description: String(item?.description || "").trim().slice(0, 240) || undefined,
      contentType,
      content: String(item?.content || "").slice(0, 30000) || undefined,
      assetPath,
    }];
  });
}

function normalizePluginActions(value: unknown): PluginActionDefinition[] {
  if (!Array.isArray(value)) return [];
  const allowedTypes = new Set<string>(PLUGIN_ACTION_TYPES);
  const seen = new Set<string>();
  return value.slice(0, MAX_PLUGIN_ACTIONS).flatMap((item: any) => {
    const id = normalizePluginId(item?.id).slice(0, 80);
    if (!id || seen.has(id)) return [];
    const type = String(item?.type || "noop").trim();
    if (!allowedTypes.has(type)) return [];
    seen.add(id);
    const action: PluginActionDefinition = {
      id,
      label: String(item?.label || id).trim().slice(0, 100) || id,
      type: type as PluginActionDefinition["type"],
      description: String(item?.description || "").trim().slice(0, 240) || undefined,
      confirmRequired: item?.confirmRequired === true,
      inputSchema: normalizeSettingFields(item?.inputSchema || item?.inputs),
      request: normalizeHttpRequest(item?.request),
      agent: normalizePluginAgentRequest(item?.agent),
    };
    if (action.type === "agent.request" && !action.agent) return [];
    if (!action.inputSchema?.length) delete (action as any).inputSchema;
    if (!action.request) delete (action as any).request;
    if (!action.agent) delete (action as any).agent;
    return [action];
  });
}

function normalizeUsageSelectorCopy(value: unknown): PluginUsageSelectorCopy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  const copy: PluginUsageSelectorCopy = {
    title: normalizeOptionalText(raw.title, 100),
    description: normalizeOptionalText(raw.description, 240),
    selectedLabel: normalizeOptionalText(raw.selectedLabel, 80),
    emptyText: normalizeOptionalText(raw.emptyText, 160),
    selectAllLabel: normalizeOptionalText(raw.selectAllLabel, 40),
    clearLabel: normalizeOptionalText(raw.clearLabel, 40),
    hidden: raw.hidden === true,
  };
  return Object.values(copy).some(Boolean) ? copy : undefined;
}

function normalizeUsageNoteField(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  const field = {
    label: normalizeOptionalText(raw.label, 80),
    placeholder: normalizeOptionalText(raw.placeholder, 180),
  };
  return Object.values(field).some(Boolean) ? field : undefined;
}

function normalizeUsageFooter(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  const footer = {
    title: normalizeOptionalText(raw.title, 120),
    description: normalizeOptionalText(raw.description, 240),
    submitLabel: normalizeOptionalText(raw.submitLabel, 80),
  };
  return Object.values(footer).some(Boolean) ? footer : undefined;
}

function normalizeUsageOperationSelector(value: unknown): PluginUsageOperationSelector | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  const seen = new Set<string>();
  const options: PluginUsageOperationOption[] | undefined = Array.isArray(raw.options)
    ? raw.options.slice(0, 12).flatMap((option: any) => {
        const optionValue = normalizePluginId(option?.value).slice(0, 40);
        if (!optionValue || seen.has(optionValue)) return [];
        seen.add(optionValue);
        return [{
          value: optionValue,
          label: String(option?.label || optionValue).trim().slice(0, 80) || optionValue,
          description: normalizeOptionalText(option?.description, 180),
        }];
      })
    : undefined;
  const defaultValue = normalizePluginId(raw.defaultValue).slice(0, 40) || undefined;
  const selector: PluginUsageOperationSelector = {
    label: normalizeOptionalText(raw.label, 80),
    description: normalizeOptionalText(raw.description, 240),
    defaultValue: defaultValue && (!options?.length || options.some((option: PluginUsageOperationOption) => option.value === defaultValue)) ? defaultValue : undefined,
    options,
  };
  return Object.values(selector).some((item) => Array.isArray(item) ? item.length > 0 : Boolean(item)) ? selector : undefined;
}

function normalizeUsageFields(value: unknown): PluginUsageFieldDefinition[] {
  if (!Array.isArray(value)) return [];
  const allowedTypes = new Set<string>(PLUGIN_USAGE_FIELD_TYPES);
  const seen = new Set<string>();
  return value.slice(0, MAX_PLUGIN_FIELDS).flatMap((item: any) => {
    const key = normalizePluginId(item?.key).slice(0, 80);
    if (!key || seen.has(key)) return [];
    const type = String(item?.type || "text").trim();
    if (!allowedTypes.has(type)) return [];
    seen.add(key);
    const options: Array<{ value: string; label: string }> | undefined = Array.isArray(item?.options)
      ? item.options.slice(0, 80).flatMap((option: any) => {
          const optionValue = String(option?.value ?? "").trim().slice(0, 120);
          if (!optionValue) return [];
          return [{
            value: optionValue,
            label: String(option?.label || optionValue).trim().slice(0, 120) || optionValue,
          }];
        })
      : undefined;
    let defaultValue: PluginUsageFieldDefinition["defaultValue"];
    if (type === "boolean") {
      defaultValue = item?.defaultValue === true;
    } else if (type === "multi-select") {
      const allowed = new Set((options || []).map((option: { value: string }) => option.value));
      defaultValue = Array.isArray(item?.defaultValue)
        ? item.defaultValue.map((option: unknown) => String(option || "").trim()).filter((option: string) => !allowed.size || allowed.has(option)).slice(0, 80)
        : [];
    } else if (typeof item?.defaultValue === "string" || typeof item?.defaultValue === "number") {
      defaultValue = String(item.defaultValue).slice(0, type === "textarea" ? 10000 : 1000);
    }
    return [{
      key,
      label: String(item?.label || key).trim().slice(0, 80) || key,
      type: type as PluginUsageFieldDefinition["type"],
      description: normalizeOptionalText(item?.description, 240),
      placeholder: normalizeOptionalText(item?.placeholder, 180),
      defaultValue,
      options,
      required: item?.required === true,
    }];
  });
}

function normalizePluginUsageViews(value: unknown): PluginUsageViewDefinition[] {
  if (!Array.isArray(value)) return [];
  const allowedTypes = new Set<string>(PLUGIN_USAGE_VIEW_TYPES);
  const seen = new Set<string>();
  return value.slice(0, MAX_PLUGIN_USAGE_VIEWS).flatMap((item: any) => {
    const id = normalizePluginId(item?.id).slice(0, 80);
    if (!id || seen.has(id)) return [];
    const type = String(item?.type || "").trim();
    if (!allowedTypes.has(type)) return [];
    seen.add(id);
    return [{
      id,
      type: type as PluginUsageViewDefinition["type"],
      title: String(item?.title || id).trim().slice(0, 120) || id,
      description: normalizeOptionalText(item?.description, 300),
      storageKey: normalizeUsageStorageKey(item?.storageKey),
      enableLabel: normalizeOptionalText(item?.enableLabel, 80),
      targetDirectory: undefined,
      assetMode: item?.assetMode === "all-plugin-assets" ? "all-plugin-assets" : "selected-assets",
      preserveAssetPaths: item?.preserveAssetPaths === true,
      disabledTitle: normalizeOptionalText(item?.disabledTitle, 100),
      disabledDescription: normalizeOptionalText(item?.disabledDescription, 240),
      hostSelector: normalizeUsageSelectorCopy(item?.hostSelector),
      assetSelector: normalizeUsageSelectorCopy(item?.assetSelector),
      operationSelector: normalizeUsageOperationSelector(item?.operationSelector),
      fields: normalizeUsageFields(item?.fields),
      noteField: normalizeUsageNoteField(item?.noteField),
      footer: normalizeUsageFooter(item?.footer),
    }];
  });
}

function normalizePluginAssets(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, MAX_PLUGIN_ASSETS).flatMap((item: any) => {
    let path = "";
    try {
      path = normalizeAssetPath(item?.path);
    } catch {
      return [];
    }
    if (!path || seen.has(path)) return [];
    seen.add(path);
    const maxBytes = Math.max(1, Math.min(MAX_PLUGIN_ASSET_BYTES, Math.floor(Number(item?.maxBytes || MAX_PLUGIN_ASSET_BYTES))));
    return [{
      path,
      label: String(item?.label || path).trim().slice(0, 120) || path,
      description: String(item?.description || "").trim().slice(0, 240) || undefined,
      contentType: String(item?.contentType || "text/plain;charset=utf-8").trim().slice(0, 128) || "text/plain;charset=utf-8",
      maxBytes,
    }];
  });
}

function normalizePluginData(value: unknown): ForwardxPluginManifest["data"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  const type = raw.type === "generic" ? "generic" : undefined;
  const repository = /^https:\/\/github\.com\/[^/\s]+\/[^/\s#?]+/i.test(String(raw.repository || "").trim())
    ? String(raw.repository).trim().slice(0, 512)
    : undefined;
  const branch = String(raw.branch || "").trim().slice(0, 128) || undefined;
  const autoDiscover = raw.autoDiscover === true;
  const files = Array.isArray(raw.files)
    ? raw.files.slice(0, MAX_PLUGIN_ASSETS).flatMap((item: unknown) => {
        try {
          return [normalizeAssetPath(item)];
        } catch {
          return [];
        }
      })
    : undefined;
  if (!type && !autoDiscover && (!files || files.length === 0)) return undefined;
  return { type, repository, branch, autoDiscover, files };
}

function normalizePluginFeatures(value: unknown): PluginFeatureDescription[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PLUGIN_FEATURES).flatMap((item: any) => {
    const title = String(typeof item === "string" ? item : item?.title || "").trim().slice(0, 80);
    if (!title) return [];
    return [{
      title,
      description: typeof item === "string" ? undefined : String(item?.description || "").trim().slice(0, 180) || undefined,
    }];
  });
}

function normalizeStoreItem(input: any): PluginStoreItem | null {
  try {
    const id = assertPluginId(input?.id);
    const repository = String(input?.repository || "").trim();
    githubRepoParts(repository);
    return {
      id,
      name: String(input?.name || id).trim().slice(0, 120) || id,
      description: String(input?.description || "").trim().slice(0, 500) || "ForwardX 插件",
      detailsMarkdown: normalizeOptionalText(input?.detailsMarkdown || input?.detailMarkdown || input?.longDescription, 5000),
      features: normalizePluginFeatures(input?.features),
      version: normalizeOptionalText(input?.version, 64),
      releaseDate: normalizeDateText(input?.releaseDate),
      updatedAt: normalizeDateText(input?.updatedAt),
      changelog: normalizeOptionalText(input?.changelog, 1000),
      tags: normalizeTags(input?.tags),
      license: normalizeOptionalText(input?.license, 64),
      repository,
      branch: String(input?.branch || "main").trim().slice(0, 128) || "main",
      manifestPath: String(input?.manifestPath || "forwardx-plugin.json").trim().slice(0, 256) || "forwardx-plugin.json",
      homepage: String(input?.homepage || repository).trim().slice(0, 512) || repository,
      author: String(input?.author || "ForwardX").trim().slice(0, 120) || "ForwardX",
      logo: normalizeOptionalLogo(input?.logo),
      packageRepository: String(input?.packageRepository || "").trim().slice(0, 512) || undefined,
      packageBranch: String(input?.packageBranch || "").trim().slice(0, 128) || undefined,
      packageUrl: /^https?:\/\//i.test(String(input?.packageUrl || "").trim()) ? String(input.packageUrl).trim().slice(0, 512) : undefined,
      packagePath: String(input?.packagePath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").slice(0, 256) || undefined,
      bundledPath: input?.builtIn === true ? normalizeBundledPath(input?.bundledPath) : undefined,
      category: (["data", "integration", "ui", "automation"].includes(String(input?.category))
        ? String(input.category)
        : "integration") as PluginStoreItem["category"],
      permissions: uniqueValidPermissions(input?.permissions),
      extensionPoints: uniqueValidExtensionPoints(input?.extensionPoints),
      official: input?.official !== false,
      builtIn: input?.builtIn === true,
    };
  } catch {
    return null;
  }
}

function normalizeManifest(input: any, fallback?: Partial<ForwardxPluginManifest>): ForwardxPluginManifest {
  const merged = { ...(fallback || {}), ...(input || {}) };
  const id = assertPluginId(merged.id);
  const name = String(merged.name || id).trim().slice(0, 120) || id;
  const manifest: ForwardxPluginManifest = {
    ...DEFAULT_PLUGIN_MANIFEST,
    schemaVersion: PLUGIN_MANIFEST_VERSION,
    id,
    name,
    version: normalizeVersion(merged.version),
    description: String(merged.description || "").trim().slice(0, 1000) || undefined,
    detailsMarkdown: normalizeOptionalText(merged.detailsMarkdown || merged.detailMarkdown || merged.longDescription, 5000),
    features: normalizePluginFeatures(merged.features),
    author: String(merged.author || "").trim().slice(0, 120) || undefined,
    logo: normalizeOptionalLogo(merged.logo),
    releaseDate: normalizeDateText(merged.releaseDate),
    updatedAt: normalizeDateText(merged.updatedAt),
    changelog: normalizeOptionalText(merged.changelog, 2000),
    tags: normalizeTags(merged.tags),
    license: normalizeOptionalText(merged.license, 64),
    homepage: String(merged.homepage || "").trim().slice(0, 512) || undefined,
    repository: String(merged.repository || "").trim().slice(0, 512) || undefined,
    minPanelVersion: String(merged.minPanelVersion || "").trim().slice(0, 64) || undefined,
    permissions: uniqueValidPermissions(merged.permissions),
    extensionPoints: uniqueValidExtensionPoints(merged.extensionPoints),
    settingsSchema: normalizeSettingFields(merged.settingsSchema),
    pages: normalizePluginPages(merged.pages),
    actions: normalizePluginActions(merged.actions),
    usageViews: normalizePluginUsageViews(merged.usageViews),
    assets: normalizePluginAssets(merged.assets),
    data: normalizePluginData(merged.data),
  };
  return manifest;
}

function githubRepoParts(repository: string) {
  const match = String(repository || "").trim().match(GITHUB_RE);
  if (!match) throw new Error("当前仅支持 GitHub 仓库地址，例如 https://github.com/owner/repo");
  return { owner: match[1], repo: match[2].replace(/\.git$/i, "") };
}

function githubRawUrl(repository: string, branch: string, filePath: string) {
  const { owner, repo } = githubRepoParts(repository);
  const cleanPath = String(filePath || "").replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch).replace(/%2F/g, "/")}/${cleanPath}`;
}

function githubArchiveUrl(repository: string, branch: string) {
  const { owner, repo } = githubRepoParts(repository);
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(branch).replace(/%2F/g, "/")}`;
}

function githubTreeApiUrl(repository: string, branch: string) {
  const { owner, repo } = githubRepoParts(repository);
  return `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ForwardX-Plugin-Installer",
      Accept: "application/json,text/plain,*/*",
    },
  });
  if (!response.ok) {
    throw new Error(`请求失败 ${response.status}`);
  }
  return await response.text();
}

async function fetchBuffer(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ForwardX-Plugin-Installer",
      Accept: "application/gzip,application/zip,application/octet-stream,*/*",
    },
  });
  if (!response.ok) {
    throw new Error(`请求失败 ${response.status}`);
  }
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_PLUGIN_PACKAGE_BYTES) {
    throw new Error(`插件包不能超过 ${Math.floor(MAX_PLUGIN_PACKAGE_BYTES / 1024 / 1024)}MB`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_PLUGIN_PACKAGE_BYTES) {
    throw new Error(`插件包不能超过 ${Math.floor(MAX_PLUGIN_PACKAGE_BYTES / 1024 / 1024)}MB`);
  }
  return buffer;
}

function contentTypeForPath(assetPath: string) {
  const lower = assetPath.toLowerCase();
  if (lower.endsWith(".json")) return "application/json;charset=utf-8";
  if (lower.endsWith(".md")) return "text/markdown;charset=utf-8";
  if (lower.endsWith(".tsv")) return "text/tab-separated-values;charset=utf-8";
  if (lower.endsWith(".csv")) return "text/csv;charset=utf-8";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml;charset=utf-8";
  return "text/plain;charset=utf-8";
}

function extensionOfPath(assetPath: string) {
  const name = assetPath.split("/").pop() || "";
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

function isDataAssetCandidate(assetPath: string, size = 0) {
  const cleanPath = assetPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const lower = cleanPath.toLowerCase();
  if (!lower || lower.includes("..") || lower.startsWith(".")) return false;
  if (SKIPPED_DATA_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;
  if (!AUTO_DISCOVER_DATA_ROOTS.some((root) => lower.startsWith(root))) return false;
  if (!DATA_ASSET_EXTENSIONS.has(extensionOfPath(lower))) return false;
  if (size > MAX_PLUGIN_ASSET_BYTES) return false;
  return true;
}

function isPackageAssetCandidate(assetPath: string, size = 0) {
  const cleanPath = assetPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const lower = cleanPath.toLowerCase();
  if (!lower || lower.includes("..") || lower.startsWith(".")) return false;
  if (SKIPPED_DATA_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;
  if (PACKAGE_MANIFEST_CANDIDATES.includes(lower)) return false;
  if (!PACKAGE_ASSET_EXTENSIONS.has(extensionOfPath(lower))) return false;
  if (size > MAX_PLUGIN_ASSET_BYTES) return false;
  return true;
}

function isHostSyncAssetCandidate(assetPath: string, size = 0) {
  const lower = assetPath.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  if (lower === "source.json" || lower === "package.json") return false;
  return isPackageAssetCandidate(assetPath, size) || isDataAssetCandidate(assetPath, size);
}

function normalizePackageEntryPath(rawPath: string) {
  const normalized = rawPath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .trim();
  const lower = normalized.toLowerCase();
  if (!normalized || normalized.includes("..") || /[\u0000-\u001f]/.test(normalized)) return "";
  if (normalized.startsWith(".") && !PACKAGE_MANIFEST_CANDIDATES.includes(lower)) return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts.join("/");
}

function normalizeBundledPath(value: unknown) {
  const clean = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .trim();
  if (!clean || clean.includes("..") || clean.startsWith(".") || /[\u0000-\u001f]/.test(clean)) return undefined;
  const pathValue = clean.startsWith("plugins/") ? clean : `plugins/${clean}`;
  return pathValue.slice(0, 256);
}

function resolveBundledPluginDir(bundledPath: string) {
  const clean = normalizeBundledPath(bundledPath);
  if (!clean) throw new Error("内置插件路径不合法");
  const resolved = path.resolve(process.cwd(), clean);
  const root = BUNDLED_PLUGIN_ROOT;
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("内置插件路径不在 plugins 目录内");
  }
  return { dir: resolved, path: clean };
}

async function availableBundledPath(bundledPath: string | undefined | null) {
  if (!bundledPath) return undefined;
  try {
    const bundled = resolveBundledPluginDir(bundledPath);
    await fs.access(path.join(bundled.dir, "forwardx-plugin.json"));
    return bundled.path;
  } catch {
    return undefined;
  }
}

function readZipPackage(buffer: Buffer): PluginPackageFile[] {
  const files: PluginPackageFile[] = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && files.length < MAX_PLUGIN_PACKAGE_FILES) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    if (flags & 0x08) throw new Error("插件 ZIP 暂不支持 data descriptor 格式");
    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLength;
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (nameEnd > buffer.length || dataEnd > buffer.length) throw new Error("插件 ZIP 内容不完整");
    const entryPath = normalizePackageEntryPath(buffer.slice(nameStart, nameEnd).toString("utf8"));
    offset = dataEnd;
    if (!entryPath || entryPath.endsWith("/")) continue;
    if (uncompressedSize > MAX_PLUGIN_ASSET_BYTES && !PACKAGE_MANIFEST_CANDIDATES.includes(entryPath.toLowerCase())) continue;
    const compressed = buffer.slice(dataStart, dataEnd);
    let content: Buffer;
    if (method === 0) {
      content = compressed;
    } else if (method === 8) {
      content = zlib.inflateRawSync(compressed);
    } else {
      continue;
    }
    if (content.byteLength !== uncompressedSize) throw new Error(`插件 ZIP 文件大小校验失败: ${entryPath}`);
    files.push({ path: entryPath, content });
  }
  return files;
}

function readTarGzPackage(buffer: Buffer): PluginPackageFile[] {
  const tar = zlib.gunzipSync(buffer, { maxOutputLength: MAX_PLUGIN_PACKAGE_BYTES * 8 });
  const files: PluginPackageFile[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length && files.length < MAX_PLUGIN_PACKAGE_FILES) {
    const header = tar.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = header.slice(0, 100).toString("utf8").replace(/\0.*$/, "");
    const rawPrefix = header.slice(345, 500).toString("utf8").replace(/\0.*$/, "");
    const typeFlag = header.slice(156, 157).toString("utf8") || "0";
    const sizeText = header.slice(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8) || 0;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error("插件 tar.gz 内容不完整");
    const entryPath = normalizePackageEntryPath(rawPrefix ? `${rawPrefix}/${rawName}` : rawName);
    if ((typeFlag === "0" || typeFlag === "\0") && entryPath) {
      files.push({ path: entryPath, content: tar.slice(dataStart, dataEnd) });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function readPluginPackage(buffer: Buffer, fileName = "") {
  if (buffer.byteLength <= 0) throw new Error("插件包为空");
  if (buffer.byteLength > MAX_PLUGIN_PACKAGE_BYTES) {
    throw new Error(`插件包不能超过 ${Math.floor(MAX_PLUGIN_PACKAGE_BYTES / 1024 / 1024)}MB`);
  }
  const lowerName = fileName.toLowerCase();
  if (buffer.slice(0, 2).toString("hex") === "504b" || lowerName.endsWith(".zip")) {
    return readZipPackage(buffer);
  }
  if (buffer.slice(0, 2).toString("hex") === "1f8b" || lowerName.endsWith(".tar.gz") || lowerName.endsWith(".tgz")) {
    return readTarGzPackage(buffer);
  }
  throw new Error("插件包仅支持 .zip、.tar.gz 或 .tgz");
}

function stripPackageRoot(files: PluginPackageFile[]) {
  if (!files.length) return files;
  if (files.some((file) => PACKAGE_MANIFEST_CANDIDATES.includes(file.path.toLowerCase()))) return files;
  const firstSegments = Array.from(new Set(files.map((file) => file.path.split("/")[0]).filter(Boolean)));
  if (firstSegments.length !== 1) return files;
  const root = `${firstSegments[0]}/`;
  const stripped = files.flatMap((file) => {
    if (!file.path.startsWith(root)) return [];
    const path = file.path.slice(root.length);
    return path ? [{ ...file, path }] : [];
  });
  return stripped.some((file) => PACKAGE_MANIFEST_CANDIDATES.includes(file.path.toLowerCase())) ? stripped : files;
}

function pluginPackageManifest(files: PluginPackageFile[]) {
  for (const candidate of PACKAGE_MANIFEST_CANDIDATES) {
    const file = files.find((item) => item.path.toLowerCase() === candidate);
    if (file) {
      try {
        return { manifest: JSON.parse(file.content.toString("utf8")), path: file.path };
      } catch {
        throw new Error(`${file.path} 不是有效 JSON`);
      }
    }
  }
  throw new Error("插件包内未找到 forwardx-plugin.json");
}

async function collectLocalPluginFiles(rootDir: string, relativeDir = ""): Promise<PluginPackageFile[]> {
  let entries: any[];
  try {
    entries = await fs.readdir(path.join(rootDir, relativeDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: PluginPackageFile[] = [];
  for (const entry of entries) {
    if (files.length >= MAX_PLUGIN_PACKAGE_FILES) break;
    const relativePath = normalizeAssetPath(path.posix.join(relativeDir.replace(/\\/g, "/"), String(entry.name)));
    if (entry.isDirectory()) {
      files.push(...await collectLocalPluginFiles(rootDir, relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const lower = relativePath.toLowerCase();
    if (!PACKAGE_MANIFEST_CANDIDATES.includes(lower) && !isPackageAssetCandidate(relativePath) && !isDataAssetCandidate(relativePath)) continue;
    const fullPath = path.join(rootDir, relativePath);
    const stat = await fs.stat(fullPath);
    if (!PACKAGE_MANIFEST_CANDIDATES.includes(lower) && stat.size > MAX_PLUGIN_ASSET_BYTES) continue;
    files.push({ path: relativePath, content: await fs.readFile(fullPath) });
  }
  return files;
}

async function localBundledPluginFiles(bundledPath: string) {
  const bundled = resolveBundledPluginDir(bundledPath);
  const files = await collectLocalPluginFiles(bundled.dir);
  if (!files.some((file) => file.path === "forwardx-plugin.json")) {
    throw new Error(`内置插件文件缺失: ${bundled.path}`);
  }
  return files;
}

async function syncBundledPluginAssets(pluginId: string, bundledPath: string): Promise<AssetSyncResult> {
  const files = await localBundledPluginFiles(bundledPath);
  const dataFiles = files
    .filter((file) => isDataAssetCandidate(file.path, file.content.byteLength))
    .sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"))
    .slice(0, MAX_PLUGIN_ASSETS);
  const result: AssetSyncResult = {
    total: dataFiles.length,
    synced: 0,
    skipped: 0,
    paths: [],
    errors: [],
  };
  for (const file of dataFiles) {
    try {
      await upsertPluginAsset(pluginId, file.path, file.content.toString("utf8"), contentTypeForPath(file.path));
      result.synced += 1;
      result.paths.push(file.path);
    } catch (error) {
      result.skipped += 1;
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${file.path}: ${message}`);
      warnPluginThrottled(`local-sync:${pluginId}:${file.path}`, `[Plugin] local asset sync skipped plugin=${pluginId} path=${file.path}: ${message}`);
    }
  }
  await prunePluginDataAssets(pluginId, result.paths);
  return result;
}

async function fetchGithubTree(repository: string, branch: string): Promise<GithubTreeItem[]> {
  const text = await fetchText(githubTreeApiUrl(repository, branch));
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.tree)) return [];
  return parsed.tree;
}

async function discoverGithubDataAssets(repository: string, branch: string) {
  try {
    const tree = await fetchGithubTree(repository, branch);
    return tree
      .filter((item) => item?.type === "blob" && isDataAssetCandidate(String(item.path || ""), Number(item.size || 0)))
      .map((item) => normalizeAssetPath(item.path))
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
      .slice(0, MAX_PLUGIN_ASSETS);
  } catch (error) {
    console.warn(`[Plugin] data asset discovery skipped repository=${repository}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function tryFetchGithubManifest(repository: string, branch: string, preferredPath?: string | null) {
  const candidates = Array.from(new Set([preferredPath, ...MANIFEST_CANDIDATES].filter(Boolean).map(String)));
  const errors: string[] = [];
  for (const filePath of candidates) {
    try {
      const text = await fetchText(githubRawUrl(repository, branch, filePath));
      return { manifest: JSON.parse(text), path: filePath };
    } catch (error) {
      errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`未找到插件 manifest (${errors.join("; ")})`);
}

async function fetchOfficialStoreItems(): Promise<PluginStoreItem[]> {
  if (officialStoreCache && Date.now() - officialStoreCache.checkedAt < OFFICIAL_STORE_CACHE_TTL_MS) {
    return officialStoreCache.items;
  }
  if (officialStoreFetchInFlight) return officialStoreFetchInFlight;
  officialStoreFetchInFlight = (async () => {
  try {
    const text = await fetchText(githubRawUrl(FORWARDX_REPO_URL, "main", OFFICIAL_STORE_PATH));
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const normalized = items.flatMap((item: any) => {
      const next = normalizeStoreItem(item);
      return next ? [next] : [];
    });
    const result = normalized.length ? normalized : BUILTIN_PLUGIN_STORE_ITEMS;
    officialStoreCache = { items: result, checkedAt: Date.now() };
    return result;
  } catch (error) {
    warnPluginThrottled("official-store", `[Plugin] official store fallback: ${error instanceof Error ? error.message : String(error)}`);
    officialStoreCache = { items: BUILTIN_PLUGIN_STORE_ITEMS, checkedAt: Date.now() };
    return BUILTIN_PLUGIN_STORE_ITEMS;
  } finally {
    officialStoreFetchInFlight = null;
  }
  })();
  return officialStoreFetchInFlight;
}

async function findStoreFallbackItem(input: { id?: string | null; repository?: string | null }) {
  const repository = String(input.repository || "").trim();
  const id = String(input.id || "").trim();
  const candidates = [
    ...BUILTIN_PLUGIN_STORE_ITEMS,
    ...(await fetchOfficialStoreItems()),
  ];
  return candidates.find((item) => (id && item.id === id) || (repository && item.repository === repository));
}

async function bundledPathForPlugin(plugin: any) {
  const sourcePath = normalizeBundledPath(plugin?.sourceUrl);
  if (plugin?.sourceType === "local" && sourcePath) return await availableBundledPath(sourcePath);
  const storeItem = await findStoreFallbackItem({
    id: plugin?.pluginId,
    repository: plugin?.manifest?.data?.repository || plugin?.repository || plugin?.sourceUrl,
  });
  if (storeItem?.packageUrl || storeItem?.packagePath) return undefined;
  return await availableBundledPath(storeItem?.bundledPath);
}

function builtinFallbackManifest(storeItem: PluginStoreItem): ForwardxPluginManifest {
  return normalizeManifest({
    id: storeItem.id,
    name: storeItem.name,
    version: storeItem.version || "0.0.0",
    description: storeItem.description,
    detailsMarkdown: storeItem.detailsMarkdown,
    features: storeItem.features,
    author: storeItem.author || "poouo",
    logo: storeItem.logo,
    releaseDate: storeItem.releaseDate,
    updatedAt: storeItem.updatedAt,
    changelog: storeItem.changelog,
    tags: storeItem.tags,
    license: storeItem.license,
    homepage: storeItem.homepage,
    repository: storeItem.packageRepository || storeItem.repository,
    permissions: storeItem.permissions,
    extensionPoints: storeItem.extensionPoints,
    pages: [
      {
        id: "overview",
        title: "插件说明",
        contentType: "markdown",
        content: "该插件由 ForwardX 内置适配，用于把中国区域白名单脚本、预制数据和配置下发到选中的 Agent 主机。",
      },
    ],
    actions: [
      {
        id: "read-agent-status",
        label: "读取主机状态",
        type: "agent.request",
        description: "从已选主机读取实际白名单配置、防火墙后端、规则数量和持久化状态。",
        agent: {
          executor: "script",
          interpreter: "bash",
          target: "usage-hosts",
          usageViewId: "sync-to-hosts",
          entry: "forwardx-agent-run.sh",
          arguments: ["status-json"],
          timeoutMs: 15000,
          outputType: "json",
        },
      },
      {
        id: "refresh-whitelist-source",
        label: "刷新插件数据",
        type: "data.asset.refresh",
        description: "从插件源重新同步 data 目录中的数据文件。",
        confirmRequired: true,
      },
    ],
    usageViews: [
      {
        id: "sync-to-hosts",
        type: "host-asset-sync",
        storageKey: "chinaRegionWhitelistUsage",
        title: "主机白名单同步",
        description: "选择主机和白名单数据后，Agent 会把文件同步到目标主机的 /var/lib/forwardx-agent/plugins/china-region-whitelist。",
        enableLabel: "启用同步",
        hostSelector: {
          title: "生效主机",
          selectedLabel: "已选",
          selectAllLabel: "全选",
          clearLabel: "清空",
        },
        assetSelector: {
          title: "同步内容",
          selectedLabel: "已选",
          clearLabel: "清空",
        },
        noteField: {
          label: "备注",
          placeholder: "例如：同步到国内入口主机，供后续规则或脚本读取",
        },
        footer: {
          title: "当前方式：同步文件到主机本地目录。",
          description: "保存后，目标主机下次 Agent 心跳会收到更新。",
          submitLabel: "保存使用配置",
        },
      },
    ],
    data: {
      type: "generic",
      repository: storeItem.packageRepository || FORWARDX_REPO_URL,
      branch: storeItem.packageBranch || storeItem.branch || "main",
      autoDiscover: true,
    },
  });
}

function serializeManifest(manifest: ForwardxPluginManifest) {
  return JSON.stringify(manifest, null, 2);
}

function sha256(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function upsertPlugin(manifest: ForwardxPluginManifest, source: {
  sourceType: "github" | "upload" | "local";
  sourceUrl?: string | null;
  branch?: string | null;
  manifestPath?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const builtin = BUILTIN_PLUGIN_STORE_ITEMS.find((item) => item.id === manifest.id);
  if (builtin) {
    const trustedRepository = String(builtin.packageRepository || builtin.repository || "").trim();
    const trustedSource = source.sourceType === "local"
      || (source.sourceType === "github" && !!trustedRepository && source.sourceUrl === trustedRepository);
    if (!trustedSource) {
      throw new Error(`插件 ID ${manifest.id} 是内置插件保留标识，不能由第三方包覆盖`);
    }
  }
  const now = nowDate();
  const existing = await db.select().from(plugins).where(eq(plugins.pluginId, manifest.id)).limit(1);
  if (existing[0]) {
    const existingManifest = parseJson<any>(existing[0].manifestJson, {});
    if (existingManifest?.settingsValues && typeof existingManifest.settingsValues === "object" && !(manifest as any).settingsValues) {
      (manifest as any).settingsValues = existingManifest.settingsValues;
    }
  }
  const payload = {
    pluginId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description || null,
    author: manifest.author || null,
    homepage: manifest.homepage || null,
    repository: manifest.repository || source.sourceUrl || null,
    sourceType: source.sourceType,
    sourceUrl: source.sourceUrl || null,
    branch: source.branch || null,
    manifestPath: source.manifestPath || null,
    manifestJson: serializeManifest(manifest),
    permissionsJson: JSON.stringify(manifest.permissions || []),
    extensionPointsJson: JSON.stringify(manifest.extensionPoints || []),
    status: existing[0]?.status || "disabled",
    installedAt: existing[0]?.installedAt || now,
    updatedAt: now,
    lastError: null,
  } as any;
  if (existing[0]) {
    await db.update(plugins).set(payload).where(eq(plugins.pluginId, manifest.id));
    return existing[0].id;
  }
  return await insertAndGetId("plugins", payload);
}

async function upsertPluginAsset(pluginId: string, assetPath: string, content: string, contentType = "text/plain;charset=utf-8") {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const cleanPath = normalizeAssetPath(assetPath);
  const nowSec = Math.floor(Date.now() / 1000);
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_PLUGIN_ASSET_BYTES) {
    throw new Error(`插件资产 ${cleanPath} 不能超过 ${Math.floor(MAX_PLUGIN_ASSET_BYTES / 1024)}KB`);
  }
  const hash = sha256(content);
  if (getDatabaseKind() === "sqlite") {
    await executeRaw(
      "INSERT INTO plugin_assets (pluginId, path, contentType, size, sha256, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pluginId, path) DO UPDATE SET contentType=excluded.contentType, size=excluded.size, sha256=excluded.sha256, content=excluded.content, updatedAt=excluded.updatedAt",
      [pluginId, cleanPath, contentType, size, hash, content, nowSec, nowSec],
    );
  } else if (getDatabaseKind() === "postgresql") {
    await executeRaw(
      'INSERT INTO plugin_assets ("pluginId", path, "contentType", size, sha256, content, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT ("pluginId", path) DO UPDATE SET "contentType"=excluded."contentType", size=excluded.size, sha256=excluded.sha256, content=excluded.content, "updatedAt"=excluded."updatedAt"',
      [pluginId, cleanPath, contentType, size, hash, content, nowSec, nowSec],
    );
  } else {
    await executeRaw(
      "INSERT INTO plugin_assets (pluginId, path, contentType, size, sha256, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE contentType=VALUES(contentType), size=VALUES(size), sha256=VALUES(sha256), content=VALUES(content), updatedAt=VALUES(updatedAt)",
      [pluginId, cleanPath, contentType, size, hash, content, nowSec, nowSec],
    );
  }
}

async function prunePluginDataAssets(pluginId: string, keepPaths: string[]) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const keep = new Set(keepPaths.map((item) => normalizeAssetPath(item)));
  const rows = await db.select().from(pluginAssets).where(eq(pluginAssets.pluginId, pluginId));
  for (const row of rows as any[]) {
    const assetPath = String(row?.path || "");
    if (!assetPath.startsWith("data/") || keep.has(assetPath)) continue;
    await db.delete(pluginAssets).where(eq(pluginAssets.id, row.id));
  }
}

function resolvePluginDataSource(manifest: ForwardxPluginManifest, repository: string, branch: string) {
  const dataRepository = String(manifest.data?.repository || "").trim();
  const dataBranch = String(manifest.data?.branch || "").trim();
  return {
    repository: dataRepository || repository,
    branch: dataBranch || branch,
  };
}

function remotePathFromManifest(manifestPath: string | null | undefined, assetPath: string) {
  const cleanAssetPath = normalizeAssetPath(assetPath);
  const cleanManifestPath = String(manifestPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const baseDir = cleanManifestPath.includes("/") ? cleanManifestPath.slice(0, cleanManifestPath.lastIndexOf("/") + 1) : "";
  return normalizeAssetPath(`${baseDir}${cleanAssetPath}`);
}

async function syncGithubDeclaredAssets(manifest: ForwardxPluginManifest, repository: string, branch: string, manifestPath?: string | null): Promise<AssetSyncResult> {
  const declarations = new Map<string, AssetDeclaration>();
  for (const asset of manifest.assets || []) {
    declarations.set(asset.path, {
      contentType: asset.contentType || "text/plain;charset=utf-8",
      remotePath: remotePathFromManifest(manifestPath, asset.path),
      isData: false,
    });
  }
  for (const page of manifest.pages || []) {
    if (page.assetPath && !declarations.has(page.assetPath)) {
      declarations.set(page.assetPath, {
        contentType: page.contentType === "markdown" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
        remotePath: remotePathFromManifest(manifestPath, page.assetPath),
        isData: false,
      });
    }
  }
  for (const filePath of manifest.data?.files || []) {
    const path = normalizeAssetPath(filePath);
    if (!declarations.has(path)) {
      declarations.set(path, {
        contentType: contentTypeForPath(path),
        remotePath: remotePathFromManifest(manifestPath, path),
        isData: true,
      });
    }
  }
  if (manifest.data?.autoDiscover) {
    const dataSource = resolvePluginDataSource(manifest, repository, branch);
    for (const assetPath of await discoverGithubDataAssets(dataSource.repository, dataSource.branch)) {
      if (!declarations.has(assetPath)) {
        declarations.set(assetPath, {
          contentType: contentTypeForPath(assetPath),
          remotePath: assetPath,
          isData: true,
        });
      }
    }
  }
  const entries = Array.from(declarations.entries()).slice(0, MAX_PLUGIN_ASSETS);
  const result: AssetSyncResult = {
    total: entries.length,
    synced: 0,
    skipped: 0,
    paths: [],
    errors: [],
  };
  for (const [assetPath, declaration] of entries) {
    try {
      const dataSource = declaration.isData
        ? resolvePluginDataSource(manifest, repository, branch)
        : { repository, branch };
      const content = await fetchText(githubRawUrl(dataSource.repository, dataSource.branch, declaration.remotePath));
      await upsertPluginAsset(manifest.id, assetPath, content, declaration.contentType);
      result.synced += 1;
      result.paths.push(assetPath);
    } catch (error) {
      result.skipped += 1;
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${assetPath}: ${message}`);
      console.warn(`[Plugin] asset sync skipped plugin=${manifest.id} path=${assetPath}: ${message}`);
    }
  }
  return result;
}

function normalizePluginRow(row: any) {
  const manifest = parseJson<ForwardxPluginManifest>(row?.manifestJson, {
    id: row?.pluginId,
    name: row?.name,
    version: row?.version,
    permissions: [],
    extensionPoints: [],
  } as any);
  return {
    ...row,
    manifest,
    permissions: parseJson<PluginPermissionKey[]>(row?.permissionsJson, []),
    extensionPoints: parseJson<PluginExtensionPoint[]>(row?.extensionPointsJson, []),
  };
}

export async function getPluginStoreItems() {
  const onlineItems = await fetchOfficialStoreItems();
  const merged = new Map<string, PluginStoreItem>();
  for (const item of BUILTIN_PLUGIN_STORE_ITEMS) merged.set(item.id, { ...item, official: true });
  for (const item of onlineItems) merged.set(item.id, item);
  return Array.from(merged.values());
}

export function getPluginDeveloperCapabilities() {
  return {
    manifestVersion: PLUGIN_MANIFEST_VERSION,
    securityModel: PLUGIN_SECURITY_MODEL,
    permissions: PLUGIN_PERMISSION_KEYS,
    extensionPoints: PLUGIN_EXTENSION_POINTS,
    settingFieldTypes: PLUGIN_SETTING_FIELD_TYPES,
    pageContentTypes: PLUGIN_PAGE_CONTENT_TYPES,
    actionTypes: PLUGIN_ACTION_TYPES,
    actionInputFieldTypes: PLUGIN_SETTING_FIELD_TYPES,
    httpMethods: PLUGIN_HTTP_METHODS,
    httpResponseTypes: PLUGIN_HTTP_RESPONSE_TYPES,
    httpAuthTypes: PLUGIN_HTTP_AUTH_TYPES,
    agentExecutors: PLUGIN_AGENT_EXECUTORS,
    agentInterpreters: PLUGIN_AGENT_INTERPRETERS,
    agentOutputTypes: PLUGIN_AGENT_OUTPUT_TYPES,
    agentTargets: PLUGIN_AGENT_TARGETS,
    agentMinimumVersion: AGENT_PLUGIN_TASK_VERSION,
  };
}

export async function listPlugins() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(plugins);
  return rows.map(normalizePluginRow);
}

export async function getPlugin(pluginId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const id = assertPluginId(pluginId);
  const rows = await db.select().from(plugins).where(eq(plugins.pluginId, id)).limit(1);
  return rows[0] ? normalizePluginRow(rows[0]) : undefined;
}

export async function listPluginAssets(pluginId: string) {
  const db = await getDb();
  if (!db) return [];
  const id = assertPluginId(pluginId);
  return await db.select().from(pluginAssets).where(eq(pluginAssets.pluginId, id));
}

export async function getPluginUsage(pluginId: string, usageViewId?: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = assertPluginId(pluginId);
  const plugin = await getPlugin(id);
  if (!plugin) throw new Error("插件不存在");
  const usageView = (plugin.manifest.usageViews || []).find((item: PluginUsageViewDefinition) => item.id === usageViewId)
    || firstHostAssetSyncView(plugin.manifest);
  if (!usageView || usageView.type !== "host-asset-sync") throw new Error("插件没有声明可用的主机同步使用页");
  const settings = pluginSettingsValues(plugin.manifest);
  const usage = normalizeHostAssetSyncUsage(settings[usageStorageKey(plugin, usageView.id)], usageView);
  const declaredAssets = new Map<string, any>((plugin.manifest.assets || []).map((asset: any) => [String(asset.path || ""), asset]));
  const [hostRows, assetRows] = await Promise.all([
    db.select({
      id: hosts.id,
      name: hosts.name,
      ip: hosts.ip,
      isOnline: hosts.isOnline,
      lastHeartbeat: hosts.lastHeartbeat,
    }).from(hosts),
    db.select().from(pluginAssets).where(eq(pluginAssets.pluginId, id)),
  ]);
  const allAssetsMode = usageViewAssetMode(usageView) === "all-plugin-assets";
  const assets = assetRows
    .filter((asset: any) => {
      const assetPath = String(asset?.path || "");
      return allAssetsMode
        ? isHostSyncAssetCandidate(assetPath, Number(asset?.size || 0))
        : assetPath.startsWith("data/");
    })
    .map((asset: any) => ({
      path: asset.path,
      label: declaredAssets.get(String(asset.path || ""))?.label || asset.path,
      description: declaredAssets.get(String(asset.path || ""))?.description || "",
      size: asset.size,
      sha256: asset.sha256,
      updatedAt: asset.updatedAt,
      contentType: asset.contentType,
    }))
    .sort((a: any, b: any) => String(a.path).localeCompare(String(b.path), "zh-Hans-CN"));
  return { plugin, usageView, usage, hosts: hostRows, assets };
}

export async function savePluginUsage(pluginId: string, usageViewId: string | null | undefined, input: Partial<HostAssetSyncUsageConfig>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = assertPluginId(pluginId);
  const plugin = await getPlugin(id);
  if (!plugin) throw new Error("插件不存在");
  const usageView = (plugin.manifest.usageViews || []).find((item: PluginUsageViewDefinition) => item.id === usageViewId)
    || firstHostAssetSyncView(plugin.manifest);
  if (!usageView || usageView.type !== "host-asset-sync") throw new Error("插件没有声明可保存的主机同步使用页");
  const key = usageStorageKey(plugin, usageView.id);
  const previousUsage = normalizeHostAssetSyncUsage(pluginSettingsValues(plugin.manifest)[key], usageView);
  const knownHosts = await db.select({ id: hosts.id }).from(hosts);
  const knownHostIds = new Set(knownHosts.map((host: any) => Number(host.id)));
  const knownAssetRows = await db.select({ path: pluginAssets.path, size: pluginAssets.size }).from(pluginAssets).where(eq(pluginAssets.pluginId, id));
  const knownAssetSizeByPath = new Map<string, number>(knownAssetRows.map((asset: any) => [String(asset.path || ""), Number(asset.size || 0)]));
  const allAssetsMode = usageViewAssetMode(usageView) === "all-plugin-assets";
  const knownAssetPaths = new Set<string>(knownAssetRows.map((asset: any) => String(asset.path || "")).filter((path: string) => (
    allAssetsMode
      ? isHostSyncAssetCandidate(path, knownAssetSizeByPath.get(path) || 0)
      : path.startsWith("data/")
  )));
  const nextUsage = normalizeHostAssetSyncUsage({
    enabled: input.enabled === true,
    hostIds: normalizePositiveIds(input.hostIds).filter((hostId) => knownHostIds.has(hostId)),
    assetPaths: allAssetsMode ? [] : normalizeUsageAssetPaths(input.assetPaths).filter((path) => knownAssetPaths.has(path)),
    mode: "sync-files",
    operation: input.operation,
    fieldValues: input.fieldValues,
    note: input.note,
    updatedAt: new Date().toISOString(),
  }, usageView);
  if (id === "china-region-whitelist" && nextUsage.fieldValues) {
    nextUsage.fieldValues["region-codes"] = chinaRegionWhitelistCodes(nextUsage);
  }
  if (nextUsage.enabled && nextUsage.hostIds.length === 0) throw new Error("请选择至少一台生效主机");
  if (nextUsage.enabled && !allAssetsMode && nextUsage.assetPaths.length === 0) throw new Error("请选择至少一个白名单文件");
  if (nextUsage.enabled) {
    for (const field of usageView.fields || []) {
      if (!field.required) continue;
      const value = nextUsage.fieldValues?.[field.key];
      const empty = Array.isArray(value) ? value.length === 0 : String(value ?? "").trim() === "";
      if (empty) throw new Error(`请填写 ${field.label}`);
    }
  }
  const assetSizeByPath = knownAssetSizeByPath;
  const allSyncAssetPaths = allAssetsMode
    ? knownAssetRows
      .map((asset: any) => String(asset.path || ""))
      .filter((assetPath: string) => isHostSyncAssetCandidate(assetPath, assetSizeByPath.get(assetPath) || 0))
    : nextUsage.assetPaths;
  const totalSelectedBytes = allSyncAssetPaths.reduce((sum: number, assetPath: string) => sum + (assetSizeByPath.get(assetPath) || 0), 0);
  if (nextUsage.enabled && totalSelectedBytes > MAX_WHITELIST_USAGE_SYNC_BYTES) {
    throw new Error(`选中的白名单文件总大小不能超过 ${formatByteLimit(MAX_WHITELIST_USAGE_SYNC_BYTES)}，请减少同步文件数量`);
  }
  const nextActiveHostIds = new Set(nextUsage.enabled ? nextUsage.hostIds : []);
  nextUsage.cleanupHostIds = Array.from(new Set([
    ...(previousUsage.cleanupHostIds || []),
    ...(previousUsage.enabled ? previousUsage.hostIds : []),
  ]))
    .filter((hostId) => knownHostIds.has(hostId) && !nextActiveHostIds.has(hostId))
    .slice(0, MAX_WHITELIST_USAGE_HOSTS);
  const manifest = { ...(plugin.manifest as any) } as ForwardxPluginManifest;
  const settings = pluginSettingsValues(manifest);
  settings[key] = nextUsage;
  (manifest as any).settingsValues = settings;
  await db.update(plugins).set({ manifestJson: JSON.stringify(manifest, null, 2), updatedAt: nowDate(), lastError: null } as any)
    .where(eq(plugins.pluginId, id));
  return getPluginUsage(id, usageView.id);
}

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function bashConfigValue(value: string) {
  return shellQuote(String(value || ""));
}

function safeAgentRelativePath(assetPath: string) {
  const clean = normalizeAssetPath(assetPath);
  if (clean.startsWith(".") || clean.includes("../")) throw new Error("插件资产路径不合法");
  return clean;
}

function writeTextFileCommands(targetPath: string, content: string) {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const targetDir = path.posix.dirname(targetPath);
  return [
    `mkdir -p ${shellQuote(targetDir)}`,
    `printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(targetPath)}`,
  ];
}

function normalizeWhitespaceList(value: unknown) {
  return String(value || "")
    .replace(/[，,、;\n\r\t]+/g, " ")
    .split(" ")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeWhitelistAsns(value: unknown) {
  return normalizeWhitespaceList(value)
    .map((item) => item.replace(/^as/i, ""))
    .filter((item) => /^[0-9]{1,10}$/.test(item))
    .map((item) => `AS${item}`)
    .slice(0, 40)
    .join(" ");
}

function normalizeWhitelistPortPolicies(value: unknown) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n|；/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(";")
    .slice(0, 5000);
}

function normalizeWhitelistForwardIfaces(value: unknown) {
  return normalizeWhitespaceList(value)
    .filter((item) => /^[A-Za-z0-9_.:-]{1,64}\+?$/.test(item))
    .slice(0, 32)
    .join(" ");
}

function usageStringField(usage: HostAssetSyncUsageConfig, key: string) {
  return String(usage.fieldValues?.[key] ?? "");
}

function usageArrayField(usage: HostAssetSyncUsageConfig, key: string) {
  const value = usage.fieldValues?.[key];
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function chinaRegionWhitelistCodes(usage: HostAssetSyncUsageConfig) {
  const selected = Array.from(new Set(usageArrayField(usage, "region-codes")
    .filter((code) => code === "CN" || /^[0-9]{6}$/.test(code))))
    .slice(0, 40);
  // CN is the default option in historical configurations. Province mode must
  // take precedence when both were persisted, otherwise CN opens the whitelist
  // for every domestic address and hides the intended province restriction.
  const provinces = selected.filter((code) => code !== "CN");
  return provinces.length > 0 ? provinces : ["CN"];
}

function buildChinaRegionWhitelistConfig(usage: HostAssetSyncUsageConfig, targetDir: string) {
  const codes = chinaRegionWhitelistCodes(usage);
  const backend = ["auto", "nft", "iptables"].includes(usageStringField(usage, "firewall-backend"))
    ? usageStringField(usage, "firewall-backend")
    : "auto";
  const forwardMode = ["all", "none", "selected"].includes(usageStringField(usage, "forward-mode"))
    ? usageStringField(usage, "forward-mode")
    : "all";
  const forwardIfaces = forwardMode === "selected" ? normalizeWhitelistForwardIfaces(usage.fieldValues?.["forward-ifaces"]) : "";
  const asns = normalizeWhitelistAsns(usage.fieldValues?.asns);
  const portPolicies = normalizeWhitelistPortPolicies(usage.fieldValues?.["port-policies"]);
  return [
    "# Generated by ForwardX china-region-whitelist plugin.",
    `CN_CODES=${bashConfigValue(codes.join(" "))}`,
    `CN_ASNS=${bashConfigValue(asns)}`,
    `CN_PORT_POLICIES=${bashConfigValue(portPolicies)}`,
    `CN_FORWARD_MODE=${bashConfigValue(forwardMode)}`,
    `CN_FORWARD_IFACES=${bashConfigValue(forwardIfaces)}`,
    `CN_FIREWALL_BACKEND=${bashConfigValue(backend)}`,
    `CN_ROOT=${bashConfigValue(targetDir)}`,
    `CN_RUNTIME_DIR=${bashConfigValue("/var/lib/china-region-whitelist")}`,
    `CN_ASN_CACHE_DIR=${bashConfigValue("/var/lib/china-region-whitelist/asn")}`,
    "",
  ].join("\n");
}

function buildChinaRegionWhitelistOperationCommands(usage: HostAssetSyncUsageConfig, targetDir: string, signature: string) {
  const operation = usage.operation || "sync";
  if (operation === "sync") {
    return [`echo ${shellQuote("[ForwardX Plugin] china-region-whitelist synced files and config")}`];
  }
  const commandByOperation: Record<string, string> = {
    status: "status",
    "dry-run": "dry-run-config",
    apply: "apply-config",
    clear: "clear",
    "update-asn": "update-asn",
  };
  const runnerCommand = commandByOperation[operation];
  if (!runnerCommand) return [];
  const markerDir = "/var/lib/forwardx-agent/plugin-actions";
  const markerFile = `${markerDir}/china-region-whitelist-${operation}.sha256`;
  const run = [
    `mkdir -p ${shellQuote(markerDir)}`,
    `cd ${shellQuote(targetDir)}`,
    `chmod +x ./install.sh ./bootstrap.sh ./forwardx-agent-run.sh 2>/dev/null || true`,
    `CN_CONFIG_FILE=/etc/china-region-whitelist.conf bash ./forwardx-agent-run.sh ${runnerCommand}`,
  ].join(" && ");
  if (operation === "status") return [run];
  return [
    `mkdir -p ${shellQuote(markerDir)}; if [ "$(cat ${shellQuote(markerFile)} 2>/dev/null || true)" = ${shellQuote(signature)} ]; then echo ${shellQuote(`[ForwardX Plugin] china-region-whitelist ${operation} already applied`)}; else ${run} && printf '%s' ${shellQuote(signature)} > ${shellQuote(markerFile)}; fi`,
  ];
}

export async function buildPluginHostAssetSyncActions(hostId: number) {
  const db = await getDb();
  if (!db) return [];
  const currentHostId = Number(hostId);
  if (!Number.isInteger(currentHostId) || currentHostId <= 0) return [];
  const pluginRows = await db.select().from(plugins);
  const tasks: Array<{ pluginId: string; usageViewId: string; forwardType: string; commands: string[] }> = [];
  for (const row of pluginRows) {
    const plugin = normalizePluginRow(row);
    const usageView = firstHostAssetSyncView(plugin.manifest);
    if (!usageView) continue;
    const settings = pluginSettingsValues(plugin.manifest);
    const usage = normalizeHostAssetSyncUsage(settings[usageStorageKey(plugin, usageView.id)], usageView);
    const allAssetsMode = usageViewAssetMode(usageView) === "all-plugin-assets";
    const hasUsageConfig = usage.enabled || usage.hostIds.length > 0 || usage.assetPaths.length > 0 || !!usage.note || !!usage.cleanupHostIds?.length;
    if (!hasUsageConfig) continue;
    const targetDir = hostAssetSyncDir(plugin.pluginId, usageView);
    const hasSyncTargets = allAssetsMode || usage.assetPaths.length > 0;
    const isChinaRegionWhitelist = plugin.pluginId === "china-region-whitelist";
    const shouldCleanup = usage.cleanupHostIds?.includes(currentHostId)
      || ((plugin.status !== "enabled" || !usage.enabled || !hasSyncTargets) && usage.hostIds.includes(currentHostId));
    if (shouldCleanup) {
      const commands = isChinaRegionWhitelist
        ? [
            `if [ -x ${shellQuote(`${targetDir}/forwardx-agent-run.sh`)} ]; then CN_CONFIG_FILE=/etc/china-region-whitelist.conf bash ${shellQuote(`${targetDir}/forwardx-agent-run.sh`)} clear 2>/dev/null || true; fi`,
            `rm -rf ${shellQuote(targetDir)} 2>/dev/null || true`,
          ]
        : [`rm -rf ${shellQuote(targetDir)} 2>/dev/null || true`];
      tasks.push({
        pluginId: plugin.pluginId,
        usageViewId: usageView.id,
        forwardType: `plugin-${plugin.pluginId}-${usageView.id}-sync`,
        commands,
      });
      continue;
    }
    if (plugin.status !== "enabled" || !usage.enabled || !usage.hostIds.includes(currentHostId) || !hasSyncTargets) continue;
    const rows = await db.select().from(pluginAssets).where(eq(pluginAssets.pluginId, plugin.pluginId));
    const byPath = new Map<string, any>(rows.map((asset: any) => [String(asset.path || ""), asset]));
    let totalBytes = 0;
    const skippedPaths: string[] = [];
    const preservePaths = allAssetsMode || usageView.preserveAssetPaths === true;
    const selectedAssetRows: any[] = allAssetsMode
      ? rows
        .filter((asset: any) => isHostSyncAssetCandidate(String(asset.path || ""), Number(asset.size || 0)))
        .sort((a: any, b: any) => String(a.path || "").localeCompare(String(b.path || ""), "zh-Hans-CN"))
      : usage.assetPaths.flatMap((assetPath: string) => {
          const asset = byPath.get(assetPath);
          return asset ? [asset] : [];
        });
    const files: Array<{ source: string; fileName: string; sha256: string; size: number; content: string }> = selectedAssetRows.flatMap((asset: any) => {
      const assetPath = String(asset?.path || "");
      const content = String(asset?.content || "");
      if (!asset || !content) return [];
      const size = Buffer.byteLength(content, "utf8");
      if (totalBytes + size > MAX_WHITELIST_USAGE_SYNC_BYTES) {
        skippedPaths.push(assetPath);
        return [];
      }
      totalBytes += size;
      return [{
        source: assetPath,
        fileName: preservePaths ? safeAgentRelativePath(assetPath) : safeAgentPluginAssetName(assetPath),
        sha256: String(asset.sha256 || sha256(content)),
        size,
        content,
      }];
    });
    if (files.length === 0) continue;
    const operationSignature = sha256(JSON.stringify({
      pluginId: plugin.pluginId,
      usageViewId: usageView.id,
      operation: usage.operation || defaultUsageOperation(usageView),
      fieldValues: usage.fieldValues || {},
      note: usage.note || "",
      updatedAt: usage.updatedAt || "",
      targetDir,
      files: files.map(({ source, sha256, size }) => ({ source, sha256, size })),
    }));
    const manifest = {
      pluginId: plugin.pluginId,
      pluginVersion: plugin.version,
      usageViewId: usageView.id,
      mode: usage.mode,
      operation: usage.operation || defaultUsageOperation(usageView),
      fieldValues: usage.fieldValues || {},
      note: usage.note || "",
      updatedAt: usage.updatedAt || "",
      files: files.map(({ content: _content, ...file }: { source: string; fileName: string; sha256: string; size: number; content: string }) => file),
      skipped: skippedPaths,
    };
    const commands = [
      `mkdir -p ${shellQuote(targetDir)}`,
      `find ${shellQuote(targetDir)} -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true`,
    ];
    for (const file of files) {
      const target = `${targetDir}/${file.fileName}`;
      commands.push(...writeTextFileCommands(target, file.content));
    }
    const manifestEncoded = Buffer.from(JSON.stringify(manifest, null, 2), "utf8").toString("base64");
    commands.push(`printf '%s' ${shellQuote(manifestEncoded)} | base64 -d > ${shellQuote(`${targetDir}/manifest.json`)}`);
    if (isChinaRegionWhitelist) {
      const config = buildChinaRegionWhitelistConfig(usage, targetDir);
      commands.push(...writeTextFileCommands(`${targetDir}/forwardx-generated.conf`, config));
      commands.push(...writeTextFileCommands("/etc/china-region-whitelist.conf", config));
      commands.push(...buildChinaRegionWhitelistOperationCommands(usage, targetDir, operationSignature));
    }
    tasks.push({ pluginId: plugin.pluginId, usageViewId: usageView.id, forwardType: `plugin-${plugin.pluginId}-${usageView.id}-sync`, commands });
  }
  return tasks;
}

export async function installPluginFromGithub(input: {
  repository: string;
  branch?: string | null;
  manifestPath?: string | null;
  fallbackStoreId?: string | null;
}) {
  const repository = String(input.repository || "").trim();
  const branch = String(input.branch || "").trim() || "main";
  githubRepoParts(repository);
  let manifest: ForwardxPluginManifest;
  let manifestPath = input.manifestPath || null;
  try {
    const fetched = await tryFetchGithubManifest(repository, branch, input.manifestPath);
    manifest = normalizeManifest(fetched.manifest, { repository });
    manifestPath = fetched.path;
  } catch (error) {
    const fallback = await findStoreFallbackItem({ id: input.fallbackStoreId, repository });
    if (!fallback) throw error;
    manifest = builtinFallbackManifest(fallback);
    manifestPath = fallback.manifestPath || null;
  }
  manifest.repository = manifest.repository || repository;
  await upsertPlugin(manifest, { sourceType: "github", sourceUrl: repository, branch, manifestPath });
  await upsertPluginAsset(manifest.id, "source.json", JSON.stringify({
    repository,
    branch,
    archiveUrl: githubArchiveUrl(repository, branch),
    installedAt: new Date().toISOString(),
    manifestPath,
  }, null, 2), "application/json");
  await syncGithubDeclaredAssets(manifest, repository, branch, manifestPath);
  return await getPlugin(manifest.id);
}

export async function installPluginFromPackage(input: {
  content: Buffer;
  fileName?: string | null;
  sourceType?: "github" | "upload" | "local";
  sourceUrl?: string | null;
  branch?: string | null;
  manifestPath?: string | null;
}) {
  const files = stripPackageRoot(readPluginPackage(input.content, input.fileName || ""));
  if (files.length > MAX_PLUGIN_PACKAGE_FILES) throw new Error(`插件包文件不能超过 ${MAX_PLUGIN_PACKAGE_FILES} 个`);
  const manifestFile = pluginPackageManifest(files);
  const manifest = normalizeManifest(manifestFile.manifest, {
    repository: input.sourceUrl || undefined,
  });
  const sourceManifestPath = input.manifestPath || manifestFile.path;
  await upsertPlugin(manifest, {
    sourceType: input.sourceType || "upload",
    sourceUrl: input.sourceUrl || null,
    branch: input.branch || null,
    manifestPath: sourceManifestPath,
  });
  await upsertPluginAsset(manifest.id, "package.json", JSON.stringify({
    fileName: input.fileName || "plugin-package",
    sourceUrl: input.sourceUrl || null,
    branch: input.branch || null,
    installedAt: new Date().toISOString(),
    manifestPath: sourceManifestPath,
    packageManifestPath: manifestFile.path,
    files: files.map((file) => ({ path: file.path, size: file.content.byteLength })),
  }, null, 2), "application/json");
  for (const file of files.slice(0, MAX_PLUGIN_PACKAGE_FILES)) {
    const lower = file.path.toLowerCase();
    if (PACKAGE_MANIFEST_CANDIDATES.includes(lower)) continue;
    if (!isPackageAssetCandidate(file.path, file.content.byteLength) && !isDataAssetCandidate(file.path, file.content.byteLength)) continue;
    await upsertPluginAsset(manifest.id, file.path, file.content.toString("utf8"), contentTypeForPath(file.path));
  }
  const sourceRepository = input.sourceUrl || manifest.repository;
  if (input.sourceType !== "local" && sourceRepository && manifest.data?.type) {
    await syncGithubDeclaredAssets(manifest, sourceRepository, input.branch || "main", sourceManifestPath);
  }
  return await getPlugin(manifest.id);
}

export async function installBundledPluginFromLocal(input: { bundledPath: string; storeItem?: PluginStoreItem | null }) {
  const bundled = resolveBundledPluginDir(input.bundledPath);
  const files = await localBundledPluginFiles(bundled.path);
  const manifestFile = pluginPackageManifest(files);
  const manifest = normalizeManifest(manifestFile.manifest, { repository: FORWARDX_REPO_URL });
  await upsertPlugin(manifest, {
    sourceType: "local",
    sourceUrl: bundled.path,
    branch: null,
    manifestPath: manifestFile.path,
  });
  await upsertPluginAsset(manifest.id, "source.json", JSON.stringify({
    source: "forwardx-bundled",
    bundledPath: bundled.path,
    storeItemId: input.storeItem?.id || null,
    installedAt: new Date().toISOString(),
    manifestPath: manifestFile.path,
    files: files.map((file) => ({ path: file.path, size: file.content.byteLength })),
  }, null, 2), "application/json");
  for (const file of files.slice(0, MAX_PLUGIN_PACKAGE_FILES)) {
    const lower = file.path.toLowerCase();
    if (PACKAGE_MANIFEST_CANDIDATES.includes(lower)) continue;
    if (!isPackageAssetCandidate(file.path, file.content.byteLength)) continue;
    await upsertPluginAsset(manifest.id, file.path, file.content.toString("utf8"), contentTypeForPath(file.path));
  }
  await syncBundledPluginAssets(manifest.id, bundled.path);
  return await getPlugin(manifest.id);
}

export async function installPluginFromPackageUrl(input: {
  url: string;
  fileName?: string | null;
  sourceUrl?: string | null;
  branch?: string | null;
  manifestPath?: string | null;
}) {
  const content = await fetchBuffer(input.url);
  return installPluginFromPackage({
    content,
    fileName: input.fileName || input.url.split("/").pop() || "plugin-package",
    sourceType: "github",
    sourceUrl: input.sourceUrl || input.url,
    branch: input.branch || null,
    manifestPath: input.manifestPath || null,
  });
}

export async function installPluginFromStoreItem(item: PluginStoreItem) {
  const packageRepository = String(item.packageRepository || "").trim();
  const packageBranch = String(item.packageBranch || item.branch || "main").trim() || "main";
  const packageErrors: string[] = [];
  if (item.packageUrl) {
    try {
      return await installPluginFromPackageUrl({
        url: item.packageUrl,
        fileName: item.packageUrl.split("/").pop() || `${item.id}.tar.gz`,
        sourceUrl: packageRepository || item.repository,
        branch: packageBranch,
        manifestPath: item.manifestPath,
      });
    } catch (error) {
      packageErrors.push(`packageUrl: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (item.packagePath) {
    const sourceRepository = packageRepository || FORWARDX_REPO_URL;
    try {
      return await installPluginFromPackageUrl({
        url: githubRawUrl(sourceRepository, packageBranch, item.packagePath),
        fileName: item.packagePath.split("/").pop() || `${item.id}.tar.gz`,
        sourceUrl: sourceRepository,
        branch: packageBranch,
        manifestPath: item.manifestPath,
      });
    } catch (error) {
      packageErrors.push(`packagePath: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (item.bundledPath) {
    try {
      return await installBundledPluginFromLocal({ bundledPath: item.bundledPath, storeItem: item });
    } catch (error) {
      packageErrors.push(`bundledPath: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (packageRepository) {
    return installPluginFromGithub({
      repository: packageRepository,
      branch: packageBranch,
      manifestPath: item.manifestPath,
      fallbackStoreId: item.id,
    });
  }
  if (packageErrors.length) {
    throw new Error(`插件下载安装失败: ${packageErrors.join("; ")}`);
  }
  return installPluginFromGithub({
    repository: item.repository,
    branch: item.branch || "main",
    manifestPath: item.manifestPath,
    fallbackStoreId: item.id,
  });
}

export async function installPluginFromUpload(content: string) {
  const size = Buffer.byteLength(content || "", "utf8");
  if (size <= 0) throw new Error("上传内容为空");
  if (size > MAX_PLUGIN_UPLOAD_BYTES) throw new Error("插件上传内容不能超过 1MB");
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("插件上传内容必须是 JSON");
  }
  const manifestSource = parsed?.manifest && typeof parsed.manifest === "object" ? parsed.manifest : parsed;
  const manifest = normalizeManifest(manifestSource);
  await upsertPlugin(manifest, { sourceType: "upload", sourceUrl: null, branch: null, manifestPath: null });
  await upsertPluginAsset(manifest.id, "uploaded.json", content, "application/json");
  if (parsed?.assets && typeof parsed.assets === "object") {
    const entries = Object.entries(parsed.assets).slice(0, MAX_PLUGIN_ASSETS);
    for (const [assetPath, value] of entries) {
      if (typeof value === "string") {
        await upsertPluginAsset(manifest.id, assetPath, value, "text/plain;charset=utf-8");
      }
    }
  }
  return await getPlugin(manifest.id);
}

export async function setPluginEnabled(pluginId: string, enabled: boolean) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = assertPluginId(pluginId);
  await db.update(plugins).set({ status: enabled ? "enabled" : "disabled", updatedAt: nowDate(), lastError: null } as any).where(eq(plugins.pluginId, id));
  return await getPlugin(id);
}

export async function uninstallPlugin(pluginId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = assertPluginId(pluginId);
  await db.delete(pluginAssets).where(eq(pluginAssets.pluginId, id));
  await db.delete(plugins).where(eq(plugins.pluginId, id));
}

export async function checkPluginUpdate(pluginId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const plugin = await getPlugin(pluginId);
  if (!plugin) throw new Error("插件不存在");
  const bundledPath = await bundledPathForPlugin(plugin);
  if (bundledPath) {
    const files = await localBundledPluginFiles(bundledPath);
    const manifestFile = pluginPackageManifest(files);
    const manifest = normalizeManifest(manifestFile.manifest, { repository: FORWARDX_REPO_URL });
    await db.update(plugins).set({
      latestVersion: manifest.version,
      manifestPath: manifestFile.path,
      sourceUrl: bundledPath,
      lastCheckedAt: nowDate(),
      lastError: null,
    } as any).where(eq(plugins.pluginId, plugin.pluginId));
    return { currentVersion: plugin.version, latestVersion: manifest.version, hasUpdate: manifest.version !== plugin.version };
  }
  if (plugin.sourceType !== "github" || !plugin.sourceUrl) {
    throw new Error("只有 GitHub 来源插件支持在线检查更新");
  }
  const branch = String(plugin.branch || "main");
  const storeItem = await findStoreFallbackItem({ id: plugin.pluginId, repository: plugin.manifest?.data?.repository || plugin.repository || plugin.sourceUrl });
  const sourceUrl = storeItem?.packageRepository || plugin.sourceUrl;
  const sourceBranch = storeItem?.packageBranch || branch;
  const preferredManifestPath = storeItem?.packageRepository ? storeItem.manifestPath : plugin.manifestPath;
  let manifest: ForwardxPluginManifest;
  let manifestPath = preferredManifestPath || null;
  try {
    const fetched = await tryFetchGithubManifest(sourceUrl, sourceBranch, preferredManifestPath);
    manifest = normalizeManifest(fetched.manifest, { repository: sourceUrl });
    manifestPath = fetched.path;
  } catch (error) {
    if (!storeItem) throw error;
    manifest = builtinFallbackManifest(storeItem);
    manifestPath = storeItem.manifestPath || null;
  }
  await db.update(plugins).set({
    latestVersion: manifest.version,
    manifestPath,
    lastCheckedAt: nowDate(),
    lastError: null,
  } as any).where(eq(plugins.pluginId, plugin.pluginId));
  return { currentVersion: plugin.version, latestVersion: manifest.version, hasUpdate: manifest.version !== plugin.version };
}

export async function refreshPluginAssets(pluginId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const plugin = await getPlugin(pluginId);
  if (!plugin) throw new Error("插件不存在");
  const bundledPath = await bundledPathForPlugin(plugin);
  if (bundledPath) {
    const syncResult = await syncBundledPluginAssets(plugin.pluginId, bundledPath);
    await db.update(plugins).set({ lastCheckedAt: nowDate(), lastError: null, updatedAt: nowDate() } as any).where(eq(plugins.pluginId, plugin.pluginId));
    return syncResult;
  }
  if (plugin.sourceType !== "github" || !plugin.sourceUrl) {
    throw new Error("只有 GitHub 来源插件支持刷新数据");
  }
  const branch = String(plugin.branch || "main");
  const syncResult = await syncGithubDeclaredAssets(plugin.manifest, plugin.sourceUrl, branch, plugin.manifestPath);
  await db.update(plugins).set({ lastCheckedAt: nowDate(), lastError: null, updatedAt: nowDate() } as any).where(eq(plugins.pluginId, plugin.pluginId));
  return syncResult;
}

export async function updatePluginFromGithub(pluginId: string) {
  const plugin = await getPlugin(pluginId);
  if (!plugin) throw new Error("插件不存在");
  const bundledPath = await bundledPathForPlugin(plugin);
  if (bundledPath) {
    return installBundledPluginFromLocal({ bundledPath });
  }
  if (plugin.sourceType !== "github" || !plugin.sourceUrl) {
    throw new Error("只有 GitHub 来源插件支持在线更新");
  }
  const storeItem = await findStoreFallbackItem({ id: plugin.pluginId, repository: plugin.manifest?.data?.repository || plugin.repository || plugin.sourceUrl });
  if (storeItem?.packagePath || storeItem?.packageUrl) {
    return installPluginFromStoreItem(storeItem);
  }
  const updated = await installPluginFromGithub({
    repository: plugin.sourceUrl,
    branch: plugin.branch || "main",
    manifestPath: plugin.manifestPath || undefined,
    fallbackStoreId: plugin.pluginId,
  });
  return updated;
}

export async function savePluginSetting(pluginId: string, key: string, value: unknown) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = assertPluginId(pluginId);
  const plugin = await getPlugin(id);
  if (!plugin) throw new Error("插件不存在");
  const settingKey = String(key || "").trim();
  const field = (plugin.manifest.settingsSchema || []).find((item: PluginSettingField) => item.key === settingKey);
  if (!field) throw new Error("插件没有声明该设置项");
  const settings = (plugin.manifest as any)?.settingsValues && typeof (plugin.manifest as any).settingsValues === "object"
    ? { ...(plugin.manifest as any).settingsValues }
    : {};
  let nextValue: unknown = value;
  if (field.type === "boolean") {
    nextValue = value === true;
  } else if (field.type === "number") {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) throw new Error("该设置项需要数字");
    if (field.min !== undefined && numberValue < field.min) throw new Error(`该设置项不能小于 ${field.min}`);
    if (field.max !== undefined && numberValue > field.max) throw new Error(`该设置项不能大于 ${field.max}`);
    nextValue = numberValue;
  } else {
    nextValue = String(value ?? "").slice(0, field.type === "textarea" ? 10000 : 1000);
    if (field.required && !String(nextValue).trim()) throw new Error("该设置项不能为空");
    if (field.type === "url" && String(nextValue).trim() && !/^https?:\/\//i.test(String(nextValue))) {
      throw new Error("URL 设置项必须以 http:// 或 https:// 开头");
    }
    if (field.type === "select" && field.options?.length) {
      const allowed = new Set(field.options.map((option: { value: string }) => option.value));
      if (!allowed.has(String(nextValue))) throw new Error("该设置项的选项不合法");
    }
  }
  settings[settingKey] = nextValue;
  const manifest = { ...(plugin.manifest as any), settingsValues: settings } as ForwardxPluginManifest;
  await db.update(plugins).set({ manifestJson: JSON.stringify(manifest, null, 2), updatedAt: nowDate() } as any).where(eq(plugins.pluginId, id));
  return await getPlugin(id);
}

function defaultActionInputValue(field: PluginSettingField) {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.type === "boolean") return false;
  return "";
}

function normalizeActionInputValues(fields: PluginSettingField[] | undefined, value: unknown) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result: Record<string, unknown> = {};
  for (const field of fields || []) {
    const incoming = raw[field.key] !== undefined ? raw[field.key] : defaultActionInputValue(field);
    if (field.type === "boolean") {
      result[field.key] = incoming === true;
      continue;
    }
    if (field.type === "number") {
      const numberText = String(incoming ?? "").trim();
      if (!numberText && !field.required) {
        result[field.key] = "";
        continue;
      }
      const numberValue = Number(numberText);
      if (!Number.isFinite(numberValue)) throw new Error(`请填写有效的${field.label}`);
      if (field.min !== undefined && numberValue < field.min) throw new Error(`${field.label}不能小于 ${field.min}`);
      if (field.max !== undefined && numberValue > field.max) throw new Error(`${field.label}不能大于 ${field.max}`);
      result[field.key] = numberValue;
      continue;
    }
    const textLimit = field.type === "textarea" ? 10000 : 1000;
    const text = String(incoming ?? "").slice(0, textLimit);
    if (field.required && !text.trim()) throw new Error(`请填写${field.label}`);
    if (field.type === "url" && text.trim() && !/^https?:\/\//i.test(text.trim())) {
      throw new Error(`${field.label}必须以 http:// 或 https:// 开头`);
    }
    if (field.type === "select" && field.options?.length) {
      const allowed = new Set(field.options.map((option: { value: string }) => option.value));
      result[field.key] = allowed.has(text) ? text : String(field.defaultValue || field.options[0]?.value || "");
      continue;
    }
    result[field.key] = text;
  }
  return result;
}

function pluginHasPermission(plugin: any, permission: PluginPermissionKey) {
  const manifestPermissions = Array.isArray(plugin?.manifest?.permissions) ? plugin.manifest.permissions : [];
  const rowPermissions = Array.isArray(plugin?.permissions) ? plugin.permissions : [];
  return manifestPermissions.includes(permission) || rowPermissions.includes(permission);
}

function collectPluginSecretValues(plugin: any) {
  const settings = pluginSettingsValues(plugin?.manifest || {});
  const secrets: string[] = [];
  for (const field of plugin?.manifest?.settingsSchema || []) {
    const key = String(field?.key || "");
    const value = String(settings[key] ?? "");
    const lowerKey = key.toLowerCase();
    if (value && (field?.type === "password" || /token|secret|password|passwd|cookie|key/.test(lowerKey))) {
      secrets.push(value);
    }
  }
  return Array.from(new Set(secrets)).filter((item) => item.length >= 4).slice(0, 40);
}

function redactText(value: string, secrets: string[]) {
  let text = String(value || "");
  for (const secret of secrets) {
    text = text.split(secret).join("***");
  }
  return text;
}

function redactJsonValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => redactJsonValue(item, secrets));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 1000)) {
      result[key] = redactJsonValue(item, secrets);
    }
    return result;
  }
  return value;
}

function templateLookup(path: string, context: { settings: Record<string, unknown>; input: Record<string, unknown>; plugin: any }) {
  const match = String(path || "").match(/^(settings|input|plugin)\.([A-Za-z0-9._-]{1,120})$/);
  if (!match) return "";
  const [, scope, key] = match;
  const normalizedKey = normalizePluginId(key).slice(0, 80);
  if (scope === "settings") return context.settings[key] ?? context.settings[normalizedKey] ?? "";
  if (scope === "input") return context.input[key] ?? context.input[normalizedKey] ?? "";
  if (scope === "plugin") {
    if (key === "id") return context.plugin?.pluginId || context.plugin?.manifest?.id || "";
    if (key === "name") return context.plugin?.name || context.plugin?.manifest?.name || "";
    if (key === "version") return context.plugin?.version || context.plugin?.manifest?.version || "";
  }
  return "";
}

function renderTemplateString(template: string, context: { settings: Record<string, unknown>; input: Record<string, unknown>; plugin: any }) {
  return String(template || "").replace(/\{\{\s*([A-Za-z]+(?:\.[A-Za-z0-9._-]{1,120})?)\s*\}\}/g, (_all, key) => {
    const value = templateLookup(key, context);
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

function renderTemplateValue(value: unknown, context: { settings: Record<string, unknown>; input: Record<string, unknown>; plugin: any }): unknown {
  if (typeof value === "string") return renderTemplateString(value, context);
  if (Array.isArray(value)) return value.map((item) => renderTemplateValue(item, context));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = renderTemplateValue(item, context);
    }
    return result;
  }
  return value;
}

function buildPluginHttpUrl(request: PluginHttpRequestDefinition, context: { settings: Record<string, unknown>; input: Record<string, unknown>; plugin: any }) {
  let urlText = "";
  if (request.url) {
    urlText = renderTemplateString(request.url, context).trim();
  } else if (request.baseUrlSetting && request.path) {
    const base = String(context.settings[request.baseUrlSetting] ?? "").trim();
    if (!base) throw new Error(`请先配置 ${request.baseUrlSetting}`);
    const renderedPath = renderTemplateString(request.path, context).trim();
    urlText = new URL(renderedPath || "/", base.endsWith("/") ? base : `${base}/`).toString();
  }
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error("插件 HTTP 请求地址无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("插件 HTTP 请求仅支持 http/https");
  for (const [key, value] of Object.entries(request.query || {})) {
    url.searchParams.set(key, renderTemplateString(value, context));
  }
  return url;
}

function buildPluginHttpHeaders(request: PluginHttpRequestDefinition, context: { settings: Record<string, unknown>; input: Record<string, unknown>; plugin: any }) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers || {})) {
    headers[key] = renderTemplateString(value, context);
  }
  const auth = request.auth;
  if (auth?.type === "bearer") {
    const token = renderTemplateString(auth.token || "", context).trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  } else if (auth?.type === "header") {
    const header = renderTemplateString(auth.header || "", context).trim();
    const value = renderTemplateString(auth.value || "", context);
    if (header && value) headers[header] = value;
  } else if (auth?.type === "cookie") {
    const cookieName = renderTemplateString(auth.cookieName || "", context).trim();
    const cookieValue = renderTemplateString(auth.cookieValue || "", context);
    if (cookieName && cookieValue) headers.Cookie = `${cookieName}=${cookieValue}`;
  }
  return headers;
}

function buildPluginHttpBody(request: PluginHttpRequestDefinition, headers: Record<string, string>, context: { settings: Record<string, unknown>; input: Record<string, unknown>; plugin: any }) {
  if (request.method === "GET" || request.body === undefined) return undefined;
  const rendered = renderTemplateValue(request.body, context);
  if (typeof rendered === "string") {
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "text/plain;charset=utf-8";
    }
    return rendered;
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json;charset=utf-8";
  }
  return JSON.stringify(rendered ?? {});
}

async function readResponseTextLimited(response: Response, maxBytes: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors after the limit has already been enforced.
      }
      throw new Error(`插件 HTTP 响应过大，不能超过 ${formatByteLimit(maxBytes)}`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function executePluginHttpAction(plugin: any, action: PluginActionDefinition, input: unknown) {
  if (!pluginHasPermission(plugin, "net:http")) throw new Error("插件未声明 net:http 权限，不能发起外部 API 请求");
  if (!action.request) throw new Error("插件动作缺少 HTTP 请求定义");
  const settings = pluginSettingsValues(plugin.manifest);
  const actionInput = normalizeActionInputValues(action.inputSchema, input);
  const context = { settings, input: actionInput, plugin };
  const secrets = collectPluginSecretValues(plugin);
  const url = buildPluginHttpUrl(action.request, context);
  const safeUrl = await assertSafePluginHttpUrl(url.toString());
  const headers = buildPluginHttpHeaders(action.request, context);
  const body = buildPluginHttpBody(action.request, headers, context);
  const timeoutMs = Math.max(1000, Math.min(MAX_PLUGIN_HTTP_TIMEOUT_MS, Number(action.request.timeoutMs || DEFAULT_PLUGIN_HTTP_TIMEOUT_MS)));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(safeUrl, {
      method: action.request.method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? `插件 HTTP 请求超时（${timeoutMs}ms）`
      : `插件 HTTP 请求失败：${error instanceof Error ? error.message : String(error)}`;
    throw new Error(redactText(message, secrets));
  } finally {
    clearTimeout(timeout);
  }
  const durationMs = Date.now() - startedAt;
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_PLUGIN_HTTP_RESPONSE_BYTES) {
    throw new Error(`插件 HTTP 响应过大，不能超过 ${formatByteLimit(MAX_PLUGIN_HTTP_RESPONSE_BYTES)}`);
  }
  const responseText = await readResponseTextLimited(response, MAX_PLUGIN_HTTP_RESPONSE_BYTES);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    responseHeaders[key] = redactText(value, secrets).slice(0, 1000);
  });
  const contentType = response.headers.get("content-type") || "";
  const shouldParseJson = action.request.responseType === "json" || (action.request.responseType !== "text" && /\bjson\b/i.test(contentType));
  let parsedBody: unknown;
  let parseError: string | undefined;
  if (shouldParseJson && responseText.trim()) {
    try {
      parsedBody = redactJsonValue(JSON.parse(responseText), secrets);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ok: response.ok,
    message: response.ok
      ? `HTTP ${response.status} 请求完成`
      : `HTTP ${response.status} ${response.statusText || "请求未成功"}`,
    result: {
      type: "http.request",
      actionId: action.id,
      url: redactText(url.toString(), secrets),
      method: action.request.method,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      durationMs,
      headers: responseHeaders,
      body: parsedBody,
      bodyText: redactText(responseText, secrets),
      parseError,
    },
  };
}

async function executePluginAgentAction(plugin: any, action: PluginActionDefinition, input: unknown) {
  if (!pluginHasPermission(plugin, "agent:execute")) throw new Error("插件未声明 agent:execute 权限，不能向 Agent 下发操作");
  if (!action.agent) throw new Error("插件动作缺少 Agent 请求定义");
  const usageView = (plugin.manifest.usageViews || []).find((item: PluginUsageViewDefinition) => item.id === action.agent?.usageViewId)
    || firstHostAssetSyncView(plugin.manifest);
  if (!usageView || usageView.type !== "host-asset-sync") throw new Error("Agent 动作需要关联主机使用页");
  const usage = normalizeHostAssetSyncUsage(pluginSettingsValues(plugin.manifest)[usageStorageKey(plugin, usageView.id)], usageView);
  if (!usage.enabled || usage.hostIds.length === 0) throw new Error("请先在插件使用页启用配置并选择生效主机");
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const hostRows = await db.select({ id: hosts.id, name: hosts.name, agentVersion: hosts.agentVersion }).from(hosts);
  const selectedHostIds = new Set(usage.hostIds);
  const targetHosts = hostRows.filter((host: any) => selectedHostIds.has(Number(host.id)));
  if (targetHosts.length === 0) throw new Error("插件配置中的目标主机已不存在");
  const unsupportedHosts = targetHosts.filter((host: any) => !isAgentVersionAtLeast(host.agentVersion, AGENT_PLUGIN_TASK_VERSION));
  if (unsupportedHosts.length > 0) {
    const names = unsupportedHosts.slice(0, 5).map((host: any) => String(host.name || `主机 ${host.id}`)).join("、");
    const suffix = unsupportedHosts.length > 5 ? ` 等 ${unsupportedHosts.length} 台主机` : "";
    throw new Error(`${names}${suffix} 需要先升级到 Agent v${AGENT_PLUGIN_TASK_VERSION} 才能执行插件操作`);
  }
  const actionInput = normalizeActionInputValues(action.inputSchema, input);
  const context = { settings: pluginSettingsValues(plugin.manifest), input: actionInput, plugin };
  const renderedArguments = (action.agent.arguments || []).map((argument) => renderTemplateString(argument, context).slice(0, 2000));
  const workingDirectory = hostAssetSyncDir(plugin.pluginId, usageView);
  const expectedRoot = `${PLUGIN_HOST_ASSET_ROOT}/${plugin.pluginId}`;
  if (workingDirectory !== expectedRoot && !workingDirectory.startsWith(`${expectedRoot}/`)) {
    throw new Error(`Agent 动作目录必须位于 ${expectedRoot}`);
  }
  const group = enqueuePluginAgentTaskGroup({
    pluginId: plugin.pluginId,
    pluginVersion: plugin.version,
    actionId: action.id,
    executor: action.agent.executor,
    interpreter: action.agent.interpreter || "bash",
    workingDirectory,
    entry: action.agent.entry,
    arguments: renderedArguments,
    timeoutMs: action.agent.timeoutMs || DEFAULT_PLUGIN_HTTP_TIMEOUT_MS,
    outputType: action.agent.outputType || "json",
    hosts: targetHosts,
  });
  return {
    ok: true,
    message: `已向 ${targetHosts.length} 台主机下发插件操作`,
    result: {
      type: "agent.request",
      actionId: action.id,
      groupId: group?.groupId,
      body: group,
    },
  };
}

export async function runPluginAction(pluginId: string, actionId: string, input?: unknown) {
  const plugin = await getPlugin(pluginId);
  if (!plugin) throw new Error("插件不存在");
  if (plugin.status !== "enabled") throw new Error("插件未启用");
  const action = (plugin.manifest.actions || []).find((item: PluginActionDefinition) => item.id === actionId);
  if (!action) throw new Error("插件没有声明该动作");
  if (action.type === "http.request") {
    return executePluginHttpAction(plugin, action, input);
  }
  if (action.type === "agent.request") {
    return executePluginAgentAction(plugin, action, input);
  }
  if (action.type === "noop") {
    return { ok: true, message: "动作已执行（noop）" };
  }
  if (action.type === "data.asset.refresh" || action.type === "data.whitelist.refresh") {
    const bundledPath = await bundledPathForPlugin(plugin);
    if (!bundledPath && (plugin.sourceType !== "github" || !plugin.sourceUrl)) {
      throw new Error("该动作仅支持 GitHub 来源或面板内置插件");
    }
    const [updateResult, syncResult] = await Promise.all([
      checkPluginUpdate(plugin.pluginId),
      refreshPluginAssets(plugin.pluginId),
    ]);
    return {
      ok: true,
      message: syncResult.synced > 0
        ? `已同步 ${syncResult.synced} 个数据文件`
        : "没有同步到新的数据文件",
      result: {
        update: updateResult,
        assets: syncResult,
      },
    };
  }
  throw new Error("该插件动作暂未支持");
}

export async function getPluginAgentActionStatus(pluginId: string, groupId: string) {
  const plugin = await getPlugin(pluginId);
  if (!plugin) throw new Error("插件不存在");
  const group = getPluginAgentTaskGroup(groupId);
  if (!group || group.pluginId !== plugin.pluginId) return null;
  return group;
}

export async function getEnabledPluginExtensionPoints() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(plugins).where(eq(plugins.status, "enabled"));
  return rows.map(normalizePluginRow).flatMap((plugin: any) => plugin.extensionPoints.map((point: PluginExtensionPoint) => ({
    pluginId: plugin.pluginId,
    name: plugin.name,
    point,
  })));
}
