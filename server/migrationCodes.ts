const migrationCodes = new Map<string, { expiresAt: number; createdAt: number }>();
const takeoverTokens = new Map<string, {
  expiresAt: number;
  createdAt: number;
  targetPanelUrl: string;
  status: "issued" | "prepared";
  preparedAt?: number;
}>();
const migrationRequests = new Map<string, {
  id: string;
  code: string;
  targetPanelUrl: string;
  status: "pending" | "approved" | "rejected" | "used";
  createdAt: number;
  expiresAt: number;
  approvedAt?: number;
  rejectedAt?: number;
}>();
const MIGRATION_CODE_TTL_MS = 5 * 60 * 1000;
const TAKEOVER_TOKEN_TTL_MS = 60 * 60 * 1000;
const PREPARED_TAKEOVER_TTL_MS = 60 * 60 * 1000;
const MIGRATION_CODE_LENGTH = 24;

function cleanupMigrationCodes() {
  const now = Date.now();
  for (const [code, entry] of migrationCodes) {
    if (entry.expiresAt <= now) migrationCodes.delete(code);
  }
  for (const [token, entry] of takeoverTokens) {
    if (entry.expiresAt <= now) takeoverTokens.delete(token);
  }
  for (const [id, request] of migrationRequests) {
    if (request.expiresAt <= now || (request.status !== "used" && !migrationCodes.has(request.code))) {
      migrationRequests.delete(id);
    }
  }
}

function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

function normalizePanelUrl(url: string) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function randomToken(length = 48) {
  let token = "";
  while (token.length < length) {
    token += crypto.randomUUID().replace(/-/g, "");
  }
  return token.slice(0, length).toUpperCase();
}

function takeMigrationCodeEntry(code: string) {
  cleanupMigrationCodes();
  const normalized = normalizeCode(code);
  const entry = migrationCodes.get(normalized);
  migrationCodes.delete(normalized);
  return entry && entry.expiresAt > Date.now() ? entry : null;
}

export function createMigrationCode() {
  cleanupMigrationCodes();
  migrationCodes.clear();
  migrationRequests.clear();
  const code = randomToken(MIGRATION_CODE_LENGTH);
  const now = Date.now();
  const entry = { createdAt: now, expiresAt: now + MIGRATION_CODE_TTL_MS };
  migrationCodes.set(code, entry);
  return { code, expiresAt: entry.expiresAt, expiresInSeconds: MIGRATION_CODE_TTL_MS / 1000 };
}

export function consumeMigrationCode(code: string) {
  return !!takeMigrationCodeEntry(code);
}

export function getCurrentMigrationCode() {
  cleanupMigrationCodes();
  const now = Date.now();
  let current: { code: string; expiresAt: number; createdAt: number } | null = null;
  for (const [code, entry] of migrationCodes) {
    if (!current || entry.createdAt > current.createdAt) {
      current = { code, ...entry };
    }
  }
  if (!current) return null;
  const pendingRequest = [...migrationRequests.values()]
    .filter((request) => request.code === current?.code && request.status !== "used")
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  return {
    code: current.code,
    expiresAt: current.expiresAt,
    expiresInSeconds: Math.max(0, Math.ceil((current.expiresAt - now) / 1000)),
    pendingRequest: pendingRequest
      ? {
          id: pendingRequest.id,
          targetPanelUrl: pendingRequest.targetPanelUrl,
          status: pendingRequest.status,
          createdAt: pendingRequest.createdAt,
          expiresAt: pendingRequest.expiresAt,
          approvedAt: pendingRequest.approvedAt,
          rejectedAt: pendingRequest.rejectedAt,
        }
      : null,
  };
}

export function createMigrationRequest(code: string, targetPanelUrl: string) {
  cleanupMigrationCodes();
  const normalized = normalizeCode(code);
  const entry = migrationCodes.get(normalized);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  const normalizedTarget = targetPanelUrl.trim();
  const existing = [...migrationRequests.values()]
    .filter((request) => request.code === normalized && request.targetPanelUrl === normalizedTarget && request.status !== "used")
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (existing) return existing;
  const now = Date.now();
  const request = {
    id: randomToken(24),
    code: normalized,
    targetPanelUrl: normalizedTarget,
    status: "pending" as const,
    createdAt: now,
    expiresAt: entry.expiresAt,
  };
  migrationRequests.set(request.id, request);
  return request;
}

export function getMigrationRequest(requestId: string, code: string) {
  cleanupMigrationCodes();
  const request = migrationRequests.get(normalizeCode(requestId));
  if (!request || request.code !== normalizeCode(code)) return null;
  return request;
}

export function approveMigrationRequest(requestId: string) {
  cleanupMigrationCodes();
  const request = migrationRequests.get(normalizeCode(requestId));
  if (!request || request.status !== "pending") return null;
  request.status = "approved";
  request.approvedAt = Date.now();
  migrationRequests.set(request.id, request);
  return request;
}

export function rejectMigrationRequest(requestId: string) {
  cleanupMigrationCodes();
  const request = migrationRequests.get(normalizeCode(requestId));
  if (!request || request.status !== "pending") return null;
  request.status = "rejected";
  request.rejectedAt = Date.now();
  migrationRequests.set(request.id, request);
  return request;
}

export function consumeApprovedMigrationRequest(requestId: string, code: string, targetPanelUrl: string) {
  const request = getMigrationRequest(requestId, code);
  if (!request || request.status !== "approved" || request.targetPanelUrl !== targetPanelUrl.trim()) return null;
  const entry = takeMigrationCodeEntry(code);
  if (!entry) return null;
  request.status = "used";
  migrationRequests.set(request.id, request);
  const now = Date.now();
  const takeoverToken = randomToken(48);
  const takeoverEntry = {
    createdAt: now,
    expiresAt: now + TAKEOVER_TOKEN_TTL_MS,
    targetPanelUrl: normalizePanelUrl(targetPanelUrl),
    status: "issued" as const,
  };
  takeoverTokens.set(takeoverToken, takeoverEntry);
  return {
    takeoverToken,
    expiresAt: takeoverEntry.expiresAt,
    expiresInSeconds: TAKEOVER_TOKEN_TTL_MS / 1000,
  };
}

export function consumeMigrationCodeForTakeover(code: string) {
  const entry = takeMigrationCodeEntry(code);
  if (!entry) return null;
  const now = Date.now();
  const takeoverToken = randomToken(48);
  const takeoverEntry = {
    createdAt: now,
    expiresAt: now + TAKEOVER_TOKEN_TTL_MS,
    targetPanelUrl: "",
    status: "issued" as const,
  };
  takeoverTokens.set(takeoverToken, takeoverEntry);
  return {
    takeoverToken,
    expiresAt: takeoverEntry.expiresAt,
    expiresInSeconds: TAKEOVER_TOKEN_TTL_MS / 1000,
  };
}

export function prepareTakeoverToken(token: string, targetPanelUrl: string) {
  cleanupMigrationCodes();
  const normalized = normalizeCode(token);
  const entry = takeoverTokens.get(normalized);
  const target = normalizePanelUrl(targetPanelUrl);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  if (entry.targetPanelUrl && entry.targetPanelUrl !== target) return null;
  const anotherPrepared = [...takeoverTokens.entries()].some(([candidateToken, candidate]) => (
    candidateToken !== normalized && candidate.status === "prepared" && candidate.expiresAt > Date.now()
  ));
  if (anotherPrepared) return null;
  const now = Date.now();
  entry.status = "prepared";
  entry.preparedAt = entry.preparedAt || now;
  entry.targetPanelUrl = target;
  entry.expiresAt = now + PREPARED_TAKEOVER_TTL_MS;
  takeoverTokens.set(normalized, entry);
  return { ...entry };
}

export function abortTakeoverToken(token: string, targetPanelUrl: string) {
  cleanupMigrationCodes();
  const normalized = normalizeCode(token);
  const entry = takeoverTokens.get(normalized);
  if (!entry || entry.targetPanelUrl !== normalizePanelUrl(targetPanelUrl)) return false;
  takeoverTokens.delete(normalized);
  return true;
}

export function validatePreparedTakeoverToken(token: string, targetPanelUrl: string) {
  cleanupMigrationCodes();
  const entry = takeoverTokens.get(normalizeCode(token));
  return !!entry
    && entry.expiresAt > Date.now()
    && entry.status === "prepared"
    && entry.targetPanelUrl === normalizePanelUrl(targetPanelUrl);
}

export function consumeTakeoverToken(token: string, targetPanelUrl = "") {
  cleanupMigrationCodes();
  const normalized = normalizeCode(token);
  const entry = takeoverTokens.get(normalized);
  const target = normalizePanelUrl(targetPanelUrl);
  if (!entry || entry.expiresAt <= Date.now()) return false;
  if (target && entry.targetPanelUrl && entry.targetPanelUrl !== target) return false;
  if (entry.status !== "prepared") return false;
  takeoverTokens.delete(normalized);
  return true;
}
