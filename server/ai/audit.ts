import { appendPanelLog, type PanelLogLevel } from "../_core/panelLogger";

export type AiAuditEvent = {
  phase: "query" | "intent" | "preview" | "execute" | "rate_limit";
  result: "success" | "fallback" | "denied" | "failed";
  actorUserId?: number | null;
  actorRole?: string | null;
  action?: string | null;
  intent?: string | null;
  ruleId?: number | null;
  tunnelId?: number | null;
  hostId?: number | null;
  targetUserId?: number | null;
  durationMs?: number | null;
  detail?: string | null;
};

function auditValue(value: unknown) {
  const text = String(value ?? "-").replace(/[\r\n\t]+/g, " ").trim();
  return text ? text.slice(0, 120) : "-";
}

export function appendAiAudit(event: AiAuditEvent) {
  const level: PanelLogLevel = event.result === "failed"
    ? "error"
    : event.result === "denied" || event.result === "fallback"
      ? "warn"
      : "info";
  appendPanelLog(level, [
    "[AiAudit]",
    `phase=${auditValue(event.phase)}`,
    `result=${auditValue(event.result)}`,
    `actor=${auditValue(event.actorUserId)}`,
    `role=${auditValue(event.actorRole)}`,
    event.action ? `action=${auditValue(event.action)}` : "",
    event.intent ? `intent=${auditValue(event.intent)}` : "",
    event.ruleId ? `rule=${auditValue(event.ruleId)}` : "",
    event.tunnelId ? `tunnel=${auditValue(event.tunnelId)}` : "",
    event.hostId ? `host=${auditValue(event.hostId)}` : "",
    event.targetUserId ? `targetUser=${auditValue(event.targetUserId)}` : "",
    Number.isFinite(Number(event.durationMs)) ? `durationMs=${Math.max(0, Math.floor(Number(event.durationMs)))}` : "",
    event.detail ? `detail=${auditValue(event.detail)}` : "",
  ].filter(Boolean).join(" "));
}
