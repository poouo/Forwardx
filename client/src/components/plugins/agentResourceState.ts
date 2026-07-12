export type ResourceOperationKind = "read" | "create" | "update" | "delete" | "execute";

export type ResourceSourceSnapshot = {
  data?: unknown;
  loadedAt: number;
  error?: string;
  advice?: string;
  detail?: string;
  failedAt?: number;
};

export type PluginTaskFailureInfo = {
  message: string;
  advice: string;
  detail: string;
  processError: string;
  data?: unknown;
};

export function failedResourceSnapshot(
  current: ResourceSourceSnapshot | undefined,
  failure: Pick<PluginTaskFailureInfo, "message" | "advice" | "detail">,
  failedAt = Date.now(),
): ResourceSourceSnapshot {
  return {
    ...current,
    loadedAt: current?.loadedAt || 0,
    error: failure.message,
    advice: failure.advice || undefined,
    detail: failure.detail || undefined,
    failedAt,
  };
}

const ERROR_KEYS = new Set([
  "error", "errormessage", "message", "detail", "reason",
  "错误", "错误信息", "原因",
]);
const ADVICE_KEYS = new Set([
  "suggestion", "advice", "resolution", "hint",
  "处理建议", "建议", "解决方案",
]);
const META_KEYS = new Set(["success", "status", "code", ...ERROR_KEYS, ...ADVICE_KEYS]);

function valueAtPath(value: unknown, path?: string) {
  if (!path) return value;
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function displayScalar(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function structuredField(value: unknown, keys: Set<string>): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const object = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(object)) {
    if (!keys.has(key.trim().toLowerCase())) continue;
    const text = displayScalar(entry);
    if (text) return text;
  }
  for (const container of ["data", "result", "details"]) {
    const entry = Object.entries(object).find(([key]) => key.trim().toLowerCase() === container);
    const text = entry ? structuredField(entry[1], keys) : "";
    if (text) return text;
  }
  return "";
}

function parseStructuredOutput(value: unknown) {
  const text = String(value || "").trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function businessFieldSummary(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, entry]) => {
      if (META_KEYS.has(key.trim().toLowerCase())) return [];
      const text = displayScalar(entry);
      return text ? [`${key}: ${text.slice(0, 160)}`] : [];
    })
    .slice(0, 4)
    .join(" · ");
}

export function pluginTaskFailureInfo(row: any): PluginTaskFailureInfo {
  const data = row?.data ?? parseStructuredOutput(row?.output);
  const businessMessage = structuredField(data, ERROR_KEYS);
  const reportedError = String(row?.error || "").trim();
  const processError = String(
    row?.processError
      || (businessMessage && reportedError && reportedError !== businessMessage ? reportedError : ""),
  ).trim();
  const advice = String(row?.advice || structuredField(data, ADVICE_KEYS)).trim();
  const businessDetail = businessFieldSummary(data);
  const reportedDetail = String(row?.errorDetail || "").trim();
  const detail = businessDetail || (reportedDetail.startsWith("{") || reportedDetail.startsWith("[") ? "" : reportedDetail);
  const message = businessMessage
    || reportedError
    || String(row?.stderr || "").trim()
    || processError
    || "插件操作执行失败";
  return { message, advice, detail, processError, data };
}

function setValueAtPath(value: unknown, path: string | undefined, next: unknown) {
  if (!path) return next;
  const segments = path.split(".").filter(Boolean);
  if (!segments.length) return next;
  const root: Record<string, unknown> = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
  let cursor = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const child = cursor[segment];
    const clone: Record<string, unknown> = child && typeof child === "object" && !Array.isArray(child)
      ? { ...(child as Record<string, unknown>) }
      : {};
    cursor[segment] = clone;
    cursor = clone;
  }
  cursor[segments[segments.length - 1]] = next;
  return root;
}

function resultEntity(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  for (const key of ["item", "resource", "node", "record", "data", "result"]) {
    const nested = object[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  }
  if ("success" in object || "message" in object || "error" in object) {
    const resource = Object.fromEntries(Object.entries(object).filter(([key]) => !META_KEYS.has(key.trim().toLowerCase())));
    return Object.keys(resource).length ? resource : undefined;
  }
  return object;
}

function identity(value: unknown, rowKey: string) {
  return String(valueAtPath(value, rowKey) ?? "");
}

export function optimisticResourceData(input: {
  data: unknown;
  itemsPath?: string;
  rowKey?: string;
  kind: Exclude<ResourceOperationKind, "read">;
  currentRow?: unknown;
  form?: Record<string, unknown>;
  resultData?: unknown;
}) {
  const rowKey = input.rowKey || "id";
  const current = valueAtPath(input.data, input.itemsPath);
  const rows = Array.isArray(current) ? current : Array.isArray(input.data) && !input.itemsPath ? input.data : [];
  const fullResultRows = Array.isArray(input.resultData)
    ? input.resultData
    : [input.itemsPath, "items", "data.items", "result.items"]
      .filter(Boolean)
      .map((path) => valueAtPath(input.resultData, path))
      .find(Array.isArray) as unknown[] | undefined;
  if (fullResultRows) return setValueAtPath(input.data, input.itemsPath, fullResultRows);

  const selectedIdentity = identity(input.currentRow || input.form, rowKey);
  if (input.kind === "delete") {
    if (!selectedIdentity) return input.data;
    return setValueAtPath(input.data, input.itemsPath, rows.filter((row) => identity(row, rowKey) !== selectedIdentity));
  }

  const returned = resultEntity(input.resultData);
  const candidate = {
    ...(input.currentRow && typeof input.currentRow === "object" ? input.currentRow as Record<string, unknown> : {}),
    ...(input.form || {}),
    ...(returned || {}),
  };
  const candidateIdentity = identity(candidate, rowKey);
  if (input.kind === "create") {
    if (!returned && Object.keys(input.form || {}).length === 0) return input.data;
    const existingIndex = candidateIdentity ? rows.findIndex((row) => identity(row, rowKey) === candidateIdentity) : -1;
    const next = existingIndex >= 0
      ? rows.map((row, index) => index === existingIndex ? candidate : row)
      : [...rows, candidate];
    return setValueAtPath(input.data, input.itemsPath, next);
  }

  const targetIdentity = selectedIdentity || candidateIdentity;
  if (!targetIdentity) return input.data;
  const existingIndex = rows.findIndex((row) => identity(row, rowKey) === targetIdentity);
  if (existingIndex < 0) {
    return candidateIdentity ? setValueAtPath(input.data, input.itemsPath, [...rows, candidate]) : input.data;
  }
  return setValueAtPath(
    input.data,
    input.itemsPath,
    rows.map((row, index) => index === existingIndex ? candidate : row),
  );
}
