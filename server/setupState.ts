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
