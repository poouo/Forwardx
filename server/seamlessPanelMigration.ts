import crypto from "node:crypto";
import { Router } from "express";
import { APP_VERSION, AGENT_VERSION } from "../shared/versions";
import { exportMigrationSnapshot, fetchSnapshotFromOldPanelWithApproval, verifyTargetPanelIdentity, buildMigrationRuntimeExpectations, type MigrationSnapshot, type MigrationJob } from "./migration";
import { getDatabaseKind, queryRaw, quoteDbIdentifier as q } from "./dbRuntime";
import { closeAgentControlStreams } from "./agentEvents";
import { normalizePanelUrl } from "./agentPanelUrl";
import { getSeamlessMigrationState, persistSeamlessMigrationState, seamlessInternal, drainSeamlessActivities, expireSeamlessFreeze, type SeamlessMigrationState } from "./seamlessMigrationState";
import { assertEmptySeamlessTarget, importSeamlessSnapshot } from "./seamlessMigrationImport";
import { assertSafeOutboundUrl } from "./ssrf";
import { isAgentVersionAtLeast } from "./agentRouteUtils";
import { startBackgroundServices } from "./backgroundServices";
import { markLocalSetupComplete } from "./setupState";
import type { PanelMigrationScope } from "../shared/panelMigration";

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const reports = new Map<number, { at: number; rules: number[]; tunnels: number[] }>();
let resuming = false;

export function recordSeamlessRuntimeReport(hostId: number, localState: any) {
  const state = getSeamlessMigrationState();
  if (state?.role !== "target" || state.phase !== "verifying" || !localState || !Array.isArray(localState.rules) || !Array.isArray(localState.tunnels)) return;
  if (!state.requiredHosts?.includes(hostId)) return;
  reports.set(hostId, {
    at: Date.now(),
    rules: localState.rules.filter((rule: any) => rule.ready !== false).map((rule: any) => Number(rule.ruleId)),
    tunnels: localState.tunnels.filter((tunnel: any) => tunnel.ready !== false).map((tunnel: any) => Number(tunnel.tunnelId)),
  });
}

export function seamlessRuntimeReadiness(state: SeamlessMigrationState) {
  const readyHosts = (state.requiredHosts || []).filter((id) => {
    const report = reports.get(id);
    return report && Date.now() - report.at < 90_000;
  });
  const rules = new Set(readyHosts.flatMap((id) => reports.get(id)!.rules));
  const tunnels = new Set(readyHosts.flatMap((id) => reports.get(id)!.tunnels));
  return { pendingHosts: (state.requiredHosts || []).filter((id) => !readyHosts.includes(id)),
    pendingRules: (state.requiredRules || []).filter((id) => !rules.has(id)),
    pendingTunnels: (state.requiredTunnels || []).filter((id) => !tunnels.has(id)) };
}

async function remote(url: string, body?: object) {
  await assertSafeOutboundUrl(url, { allowPrivate: true, purpose: "无缝面板迁移" });
  const response = await fetch(url, { method: body ? "POST" : "GET", redirect: "manual", signal: AbortSignal.timeout(20_000),
    headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `迁移接口返回 ${response.status}`);
  return data;
}

function control(state: SeamlessMigrationState, action: string) {
  return remote(`${state.sourceUrl}/api/migration/seamless-${action}`, { id: state.id, takeoverToken: state.takeoverToken, targetPanelUrl: state.targetUrl });
}

function authorize(body: any) {
  const state = getSeamlessMigrationState();
  const candidate = hash(String(body?.takeoverToken || ""));
  if (!state || state.role !== "source" || body?.id !== state.id || normalizePanelUrl(String(body?.targetPanelUrl || "")) !== state.targetUrl
    || state.tokenHash.length !== candidate.length || !crypto.timingSafeEqual(Buffer.from(state.tokenHash), Buffer.from(candidate))) {
    throw new Error("迁移接管身份无效");
  }
  return state;
}

export const seamlessMigrationRouter = Router();
async function recoverCommittedImport() {
  const state = getSeamlessMigrationState();
  if (state?.role !== "target" || state.phase !== "verifying" || state.imported) return;
  const rows = await queryRaw(`SELECT ${q("value")} FROM ${q("system_settings")} WHERE ${q("key")} = ?`, ["seamlessMigrationImportId"]);
  if (rows[0]?.value === state.id && getSeamlessMigrationState() === state) persistSeamlessMigrationState({ ...state, imported: true });
}
seamlessMigrationRouter.get("/api/migration/seamless-status", async (_req, res) => {
  await recoverCommittedImport().catch(() => undefined);
  const state = getSeamlessMigrationState();
  res.setHeader("Cache-Control", "no-store");
  res.json({ protocol: 1, appVersion: APP_VERSION, databaseType: getDatabaseKind(),
    state: state ? { id: state.id, role: state.role, phase: state.phase, targetUrl: state.targetUrl, sourceUrl: state.sourceUrl,
      imported: state.imported, job: state.job, readiness: state.role === "target" ? (() => {
        const pending = seamlessRuntimeReadiness(state);
        return { hosts: pending.pendingHosts.length, rules: pending.pendingRules.length, tunnels: pending.pendingTunnels.length };
      })() : undefined, busy: state.role === "target" && resuming } : null });
});
for (const action of ["activate", "complete", "abort"] as const) {
  seamlessMigrationRouter.post(`/api/migration/seamless-${action}`, async (req, res) => {
    try {
      expireSeamlessFreeze();
      const state = authorize(req.body);
      if (action === "abort") {
        if (state.phase !== "frozen") throw new Error("已经转交的新面板可能收到计费数据，禁止回退旧快照");
        persistSeamlessMigrationState(null);
        startBackgroundServices();
      } else if (action === "activate") {
        if (!["frozen", "forwarding", "archived"].includes(state.phase)) throw new Error("迁移状态不允许接管");
        if (state.phase === "frozen") {
          // The target must prove this is the imported, isolated receiver. This
          // also rejects accidentally configuring a relay loop / wrong URL.
          const proof = await remote(`${state.targetUrl}/api/migration/seamless-target-ready`, {
            id: state.id, takeoverToken: req.body.takeoverToken,
          });
          if (!proof.ready || proof.id !== state.id || proof.appVersion !== APP_VERSION) throw new Error("目标面板尚未通过数据导入验证");
          if (getSeamlessMigrationState() !== state || Date.now() >= state.expiresAt) throw new Error("源面板冻结已经失效，请重新迁移");
          persistSeamlessMigrationState({ ...state, phase: "forwarding" });
          closeAgentControlStreams();
          console.info(`[Migration] Control relay activated id=${state.id}; existing forwarding processes untouched; source data retained`);
        }
      } else {
        if (!["forwarding", "archived"].includes(state.phase)) throw new Error("尚未转交 Agent 请求");
        persistSeamlessMigrationState({ ...state, phase: "archived" });
      }
      res.json({ success: true, phase: getSeamlessMigrationState()?.phase || "aborted", dataPreserved: true });
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
seamlessMigrationRouter.post("/api/migration/seamless-target-ready", (req, res) => {
  const state = getSeamlessMigrationState();
  const valid = state?.role === "target" && state.imported && req.body?.id === state.id && hash(String(req.body?.takeoverToken || "")) === state.tokenHash;
  res.status(valid ? 200 : 409).json({ ready: !!valid, id: valid ? state.id : undefined, appVersion: APP_VERSION });
});

export async function freezeAndExportSeamless(input: { sourceUrl: string; targetUrl: string; token: string; dataScope: PanelMigrationScope }) {
  if (getSeamlessMigrationState()) throw new Error("已有无缝迁移状态，不能重复迁移");
  const sourceUrl = normalizePanelUrl(input.sourceUrl), targetUrl = normalizePanelUrl(input.targetUrl);
  if (!sourceUrl || !targetUrl || sourceUrl === targetUrl) throw new Error("必须先配置正确且不同的新旧面板公开地址");
  const hosts = await queryRaw(`SELECT ${q("id")}, ${q("agentVersion")} FROM ${q("hosts")}`);
  if (hosts.some((host) => !isAgentVersionAtLeast(String(host.agentVersion || ""), AGENT_VERSION))) {
    throw new Error(`无缝迁移需要所有主机先升级至 Agent ${AGENT_VERSION} 或更高；本次不会自动升级或重启 Agent`);
  }
  const state: SeamlessMigrationState = { version: 1, id: crypto.randomUUID(), role: "source", phase: "frozen", sourceUrl, targetUrl,
    tokenHash: hash(input.token), startedAt: Date.now(), expiresAt: Date.now() + 60 * 60_000 };
  persistSeamlessMigrationState(state);
  try {
    await drainSeamlessActivities(60_000);
    const snapshot = await seamlessInternal(() => exportMigrationSnapshot(sourceUrl, { dataScope: input.dataScope, consistent: true }));
    snapshot.takeoverToken = input.token;
    snapshot.seamless = { version: 1, id: state.id, sourcePanelUrl: sourceUrl, frozenAt: state.startedAt };
    console.info(`[Migration] Source frozen id=${state.id}; consistent snapshot exported; forwarding continues`);
    return snapshot;
  } catch (error) { persistSeamlessMigrationState(null); startBackgroundServices(); throw error; }
}

function patchStoredJob(patch: Partial<MigrationJob>) {
  const state = getSeamlessMigrationState();
  if (state?.job) persistSeamlessMigrationState({ ...state, job: { ...state.job, ...patch } });
}

export async function resumeSeamlessMigration() {
  await recoverCommittedImport();
  const initial = getSeamlessMigrationState();
  if (resuming) throw new Error("迁移验证正在执行");
  if (initial?.role !== "target" || initial.phase !== "verifying" || !initial.imported || !initial.takeoverToken) throw new Error("没有可继续接管的迁移，请检查迁移状态文件");
  resuming = true;
  try {
    patchStoredJob({ status: "running", progress: 75, step: "正在转交 Agent 请求并验证运行状态", error: undefined });
    await control(initial, "activate"); // idempotent, including an ambiguous previous network timeout
    const deadline = Date.now() + 2 * 60_000;
    while (true) {
      const pending = seamlessRuntimeReadiness(initial);
      if (!pending.pendingHosts.length && !pending.pendingRules.length && !pending.pendingTunnels.length) break;
      if (Date.now() >= deadline) throw new Error(`运行验证尚未完成：${pending.pendingHosts.length} 台主机、${pending.pendingRules.length} 条规则、${pending.pendingTunnels.length} 条隧道未上报可用状态。已转交的请求继续由新面板处理，请恢复连通后继续验证；禁止启用旧数据库写入`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    // Persist target ownership before retiring source. A failed completion can
    // safely be retried; it must never unfreeze the old accounting database.
    await control(initial, "complete");
    const state = getSeamlessMigrationState()!;
    persistSeamlessMigrationState({ ...state, phase: "active", takeoverToken: undefined,
      job: { ...state.job!, status: "success", progress: 100, step: "无缝迁移完成", finishedAt: Date.now(),
        message: "新面板已接管；迁移未要求重启 Agent 或转发进程。旧数据库保留，旧地址持续作为接入网关；请在新面板重新登录。" } });
    markLocalSetupComplete();
    reports.clear();
    startBackgroundServices();
    console.info(`[Migration] Target takeover verified id=${state.id} hosts=${state.requiredHosts?.length || 0}; source data retained and original ingress URL unchanged`);
    return getSeamlessMigrationState()!.job!;
  } catch (error) {
    patchStoredJob({ status: "failed", step: "迁移等待恢复与继续验证", error: error instanceof Error ? error.message : String(error), finishedAt: Date.now() });
    throw error;
  } finally { resuming = false; }
}

export async function runSeamlessPanelMigration(input: { oldPanelUrl: string; targetPanelUrl: string; migrationCode: string; dataScope: PanelMigrationScope }, job: MigrationJob, update: (patch: Partial<MigrationJob>) => void) {
  let state: SeamlessMigrationState | null = null;
  try {
    if (getSeamlessMigrationState()) throw new Error("已有无缝迁移状态；请继续原迁移，不能重复导入");
    const oldUrl = normalizePanelUrl(input.oldPanelUrl), targetUrl = normalizePanelUrl(input.targetPanelUrl);
    if (!oldUrl || !targetUrl || oldUrl === targetUrl) throw new Error("请填写不同且有效的新旧面板地址（包含 http:// 或 https://）");
    update({ status: "running", progress: 5, step: "正在检查无缝迁移兼容性" });
    const capability = await remote(`${oldUrl}/api/migration/seamless-status`);
    if (capability.protocol !== 1 || capability.appVersion !== APP_VERSION || capability.databaseType !== getDatabaseKind() || capability.state) throw new Error("无缝迁移要求两端版本及数据库类型一致，且旧端没有其他迁移；请先升级或完成原迁移");
    await verifyTargetPanelIdentity(job, targetUrl);
    await assertEmptySeamlessTarget();
    update({ progress: 10, step: "等待旧面板管理员确认无缝迁移" });
    const transfer = await fetchSnapshotFromOldPanelWithApproval({ jobId: job.id, ...input, oldPanelUrl: oldUrl, targetPanelUrl: targetUrl,
      targetDatabaseType: getDatabaseKind(), directSqliteRequested: false, seamless: true });
    if (transfer.kind !== "snapshot" || !transfer.snapshot.seamless || !transfer.snapshot.takeoverToken || transfer.snapshot.appVersion !== APP_VERSION) throw new Error("旧面板未返回有效的无缝迁移快照");
    const snapshot: MigrationSnapshot = transfer.snapshot;
    state = { version: 1, id: snapshot.seamless!.id, role: "target", phase: "verifying", sourceUrl: oldUrl, targetUrl,
      tokenHash: hash(snapshot.takeoverToken!), takeoverToken: snapshot.takeoverToken, startedAt: Date.now(), expiresAt: Date.now() + 60 * 60_000,
      jobId: job.id, job };
    persistSeamlessMigrationState(state);
    if (normalizePanelUrl(snapshot.seamless!.sourcePanelUrl) !== oldUrl) throw new Error("旧地址与旧面板配置的公开地址不一致；请使用 Agent 原有的面板公开地址迁移");
    const identity = (rows: any[]) => Object.fromEntries(rows.map((row) => [Number(row.id), Number(row.id)]));
    const expectations = buildMigrationRuntimeExpectations(snapshot, { hosts: identity(snapshot.tables.hosts || []), tunnels: identity(snapshot.tables.tunnels || []), forwardRules: identity(snapshot.tables.forward_rules || []) });
    state = { ...state, requiredHosts: expectations.hostIds, requiredRules: expectations.ruleIds, requiredTunnels: expectations.tunnelIds };
    persistSeamlessMigrationState(state);
    await drainSeamlessActivities(60_000);
    update({ progress: 35, step: "原样导入并校验 ID、端口和运行状态" });
    await importSeamlessSnapshot(snapshot, targetUrl);
    state = { ...state, imported: true, job: { ...job, progress: 70, step: "数据校验通过，准备接管" } };
    persistSeamlessMigrationState(state);
    const result = await resumeSeamlessMigration();
    update(result);
  } catch (error) {
    // Before a committed import there can be no target writes to replay. After
    // import keep the receiver isolated and resumable; never silently restore
    // the source after a possibly successful activation.
    if (state && !getSeamlessMigrationState()?.imported) {
      try { await control(state, "abort"); persistSeamlessMigrationState(null); startBackgroundServices(); }
      catch { /* lease expires only if source never activated; keep target isolated */ }
    }
    update({ status: "failed", step: "无缝迁移未完成", error: error instanceof Error ? error.message : String(error), finishedAt: Date.now() });
    patchStoredJob(job);
  }
}
