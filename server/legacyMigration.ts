export const LEGACY_COMPAT_MIGRATION_ID = "legacy-compat-v1";

export type LegacyMigrationDatabaseKind = "sqlite" | "mysql" | "postgresql";

export interface LegacyMigrationDatabase {
  kind: LegacyMigrationDatabaseKind;
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<number>;
  transaction<T>(work: () => Promise<T>): Promise<T>;
}

export const LEGACY_SESSION_FIELDS = [
  "browserSessionToken",
  "mobileSessionToken",
  "telegramSessionToken",
] as const;

type LegacySessionField = (typeof LEGACY_SESSION_FIELDS)[number];

export type ForwardProtocolsMigration = {
  state: "missing" | "unchanged" | "pending" | "invalid";
  hasLegacyKey: boolean;
  hasCurrentKey: boolean;
  migratedValue: string | null;
  error: string | null;
};

export type LegacyMigrationReport = {
  migrationId: string;
  databaseKind: LegacyMigrationDatabaseKind;
  markerPresent: boolean;
  markerValue: string | null;
  legacyTunnelModes: number;
  forwardProtocols: ForwardProtocolsMigration;
  legacySessionValues: number;
  legacySessionUsers: number;
  currentSessionValues: number;
  pendingChanges: number;
  warnings: string[];
};

export type LegacyMigrationApplyResult = {
  before: LegacyMigrationReport;
  after: LegacyMigrationReport;
  applied: {
    tunnelModes: number;
    forwardProtocols: number;
    sessionValues: number;
  };
};

type SessionRow = Record<LegacySessionField, unknown> & { id: unknown };
type PendingSessionUpdate = { id: unknown; field: LegacySessionField; value: string };
type InspectionDetail = {
  report: LegacyMigrationReport;
  markerExists: boolean;
  forwardProtocolsSettingExists: boolean;
  pendingSessionUpdates: PendingSessionUpdate[];
};

function quoteIdentifier(kind: LegacyMigrationDatabaseKind, identifier: string) {
  if (kind === "mysql") {
    const tick = String.fromCharCode(96);
    return tick + identifier.replaceAll(tick, tick + tick) + tick;
  }
  return '"' + identifier.replace(/"/g, '""') + '"';
}

function countValue(value: unknown) {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export function isCurrentSessionLeaseValue(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const sid = String(parsed?.sid ?? "").trim();
    const activeAt = Number(parsed?.activeAt);
    return !!sid && Number.isFinite(activeAt) && activeAt > 0;
  } catch {
    return false;
  }
}

export function migrateLegacyForwardProtocolsValue(
  rawValue: string | null | undefined,
): ForwardProtocolsMigration {
  const raw = String(rawValue ?? "").trim();
  if (!raw) {
    return {
      state: "missing",
      hasLegacyKey: false,
      hasCurrentKey: false,
      migratedValue: null,
      error: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: "invalid",
      hasLegacyKey: false,
      hasCurrentKey: false,
      migratedValue: null,
      error: "forwardProtocols is not valid JSON",
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      state: "invalid",
      hasLegacyKey: false,
      hasCurrentKey: false,
      migratedValue: null,
      error: "forwardProtocols must be a JSON object",
    };
  }

  const settings = parsed as Record<string, unknown>;
  const hasLegacyKey = Object.prototype.hasOwnProperty.call(settings, "nginx_tls");
  const hasCurrentKey = Object.prototype.hasOwnProperty.call(settings, "nginx_stream");
  if (!hasLegacyKey) {
    return {
      state: "unchanged",
      hasLegacyKey,
      hasCurrentKey,
      migratedValue: raw,
      error: null,
    };
  }

  const migrated = { ...settings };
  if (!hasCurrentKey) migrated.nginx_stream = migrated.nginx_tls;
  delete migrated.nginx_tls;
  return {
    state: "pending",
    hasLegacyKey,
    hasCurrentKey,
    migratedValue: JSON.stringify(migrated),
    error: null,
  };
}

async function inspectDetail(db: LegacyMigrationDatabase): Promise<InspectionDetail> {
  const q = (identifier: string) => quoteIdentifier(db.kind, identifier);
  const tunnelRows = await db.query<{ count: unknown }>(
    "SELECT COUNT(*) AS count FROM " + q("tunnels")
      + " WHERE LOWER(TRIM(" + q("mode") + ")) = ?",
    ["nginx_tls"],
  );
  const legacyTunnelModes = countValue(tunnelRows[0]?.count);

  const settingRows = await db.query<{ value: unknown }>(
    "SELECT " + q("value") + " AS value FROM " + q("system_settings")
      + " WHERE " + q("key") + " = ?",
    ["forwardProtocols"],
  );
  const forwardProtocolsSettingExists = settingRows.length > 0;
  const forwardProtocols = migrateLegacyForwardProtocolsValue(
    forwardProtocolsSettingExists ? String(settingRows[0]?.value ?? "") : null,
  );

  const markerRows = await db.query<{ value: unknown }>(
    "SELECT " + q("value") + " AS value FROM " + q("system_settings")
      + " WHERE " + q("key") + " = ?",
    [LEGACY_COMPAT_MIGRATION_ID],
  );
  const markerExists = markerRows.length > 0;
  const markerValue = markerExists ? String(markerRows[0]?.value ?? "") : null;

  const selectFields = [q("id"), ...LEGACY_SESSION_FIELDS.map(q)].join(", ");
  const sessionWhere = LEGACY_SESSION_FIELDS
    .map((field) => "COALESCE(" + q(field) + ", '') <> ''")
    .join(" OR ");
  const sessionRows = await db.query<SessionRow>(
    "SELECT " + selectFields + " FROM " + q("users") + " WHERE " + sessionWhere,
  );
  const pendingSessionUpdates: PendingSessionUpdate[] = [];
  const legacySessionUserIds = new Set<unknown>();
  let currentSessionValues = 0;
  for (const row of sessionRows) {
    for (const field of LEGACY_SESSION_FIELDS) {
      const rawValue = String(row[field] ?? "");
      const value = rawValue.trim();
      if (!value) continue;
      if (isCurrentSessionLeaseValue(value)) {
        currentSessionValues += 1;
      } else {
        pendingSessionUpdates.push({ id: row.id, field, value: rawValue });
        legacySessionUserIds.add(row.id);
      }
    }
  }

  const warnings: string[] = [];
  if (forwardProtocols.state === "invalid" && forwardProtocols.error) {
    warnings.push(
      forwardProtocols.error + "; repair or remove this setting before applying the migration",
    );
  }
  const pendingChanges = legacyTunnelModes
    + (forwardProtocols.state === "pending" ? 1 : 0)
    + pendingSessionUpdates.length;

  return {
    markerExists,
    forwardProtocolsSettingExists,
    pendingSessionUpdates,
    report: {
      migrationId: LEGACY_COMPAT_MIGRATION_ID,
      databaseKind: db.kind,
      markerPresent: markerExists,
      markerValue,
      legacyTunnelModes,
      forwardProtocols,
      legacySessionValues: pendingSessionUpdates.length,
      legacySessionUsers: legacySessionUserIds.size,
      currentSessionValues,
      pendingChanges,
      warnings,
    },
  };
}

export async function inspectLegacyCompatibility(db: LegacyMigrationDatabase) {
  return (await inspectDetail(db)).report;
}

export async function applyLegacyCompatibilityMigration(
  db: LegacyMigrationDatabase,
  completedAt = new Date(),
): Promise<LegacyMigrationApplyResult> {
  const q = (identifier: string) => quoteIdentifier(db.kind, identifier);
  const nowEpoch = Math.floor(completedAt.getTime() / 1000);
  const appliedResult = await db.transaction(async () => {
    const detail = await inspectDetail(db);
    if (detail.report.forwardProtocols.state === "invalid") {
      throw new Error(
        detail.report.forwardProtocols.error || "forwardProtocols cannot be migrated",
      );
    }

    let tunnelModes = 0;
    let forwardProtocols = 0;
    let sessionValues = 0;
    if (detail.report.legacyTunnelModes > 0) {
      tunnelModes = await db.execute(
        "UPDATE " + q("tunnels") + " SET " + q("mode") + " = ?, "
          + q("updatedAt") + " = ? WHERE LOWER(TRIM(" + q("mode") + ")) = ?",
        ["nginx_stream", nowEpoch, "nginx_tls"],
      );
    }
    if (detail.report.forwardProtocols.state === "pending"
      && detail.forwardProtocolsSettingExists) {
      forwardProtocols = await db.execute(
        "UPDATE " + q("system_settings") + " SET " + q("value") + " = ?, "
          + q("updatedAt") + " = ? WHERE " + q("key") + " = ?",
        [detail.report.forwardProtocols.migratedValue, nowEpoch, "forwardProtocols"],
      );
    }
    for (const update of detail.pendingSessionUpdates) {
      sessionValues += await db.execute(
        "UPDATE " + q("users") + " SET " + q(update.field) + " = NULL WHERE "
          + q("id") + " = ? AND " + q(update.field) + " = ?",
        [update.id, update.value],
      );
    }

    const applied = { tunnelModes, forwardProtocols, sessionValues };
    const markerValue = JSON.stringify({
      migrationId: LEGACY_COMPAT_MIGRATION_ID,
      completedAt: completedAt.toISOString(),
      databaseKind: db.kind,
      applied,
    });
    if (detail.markerExists) {
      await db.execute(
        "UPDATE " + q("system_settings") + " SET " + q("value") + " = ?, "
          + q("updatedAt") + " = ? WHERE " + q("key") + " = ?",
        [markerValue, nowEpoch, LEGACY_COMPAT_MIGRATION_ID],
      );
    } else {
      await db.execute(
        "INSERT INTO " + q("system_settings") + " (" + q("key") + ", "
          + q("value") + ", " + q("updatedAt") + ") VALUES (?, ?, ?)",
        [LEGACY_COMPAT_MIGRATION_ID, markerValue, nowEpoch],
      );
    }
    return { before: detail.report, applied };
  });

  const after = await inspectLegacyCompatibility(db);
  return { ...appliedResult, after };
}
