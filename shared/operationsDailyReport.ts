export const OPERATIONS_REPORT_CONFIG_KEY = "operationsDailyReport";
export const OPERATIONS_REPORT_STATE_KEY = "operationsDailyReportDelivery";
export const OPERATIONS_REPORT_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export type OperationsReportConfig = { enabled: boolean; time: string; enabledAt: number };

export function parseOperationsReportConfig(value: string | null): OperationsReportConfig {
  let config: Partial<OperationsReportConfig> = {};
  try { config = JSON.parse(value || "{}") || {}; } catch { /* Use safe defaults. */ }
  return {
    enabled: config.enabled === true,
    time: typeof config.time === "string" && OPERATIONS_REPORT_TIME_PATTERN.test(config.time) ? config.time : "00:00",
    enabledAt: Number.isFinite(config.enabledAt) && Number(config.enabledAt) >= 0 ? Number(config.enabledAt) : 0,
  };
}
