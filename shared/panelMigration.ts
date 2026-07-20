export const PANEL_MIGRATION_SCOPES = ["essential", "full"] as const;

export type PanelMigrationScope = (typeof PANEL_MIGRATION_SCOPES)[number];

export function normalizePanelMigrationScope(value: unknown): PanelMigrationScope {
  return String(value || "").trim().toLowerCase() === "essential" ? "essential" : "full";
}

export function panelMigrationScopeLabel(scope: PanelMigrationScope) {
  return scope === "essential" ? "关键数据迁移" : "全量迁移";
}
