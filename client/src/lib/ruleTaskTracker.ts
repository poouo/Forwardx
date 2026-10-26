import type { RuleTaskAction, RuleTaskSnapshot } from "@shared/ruleTaskQueue";
import { mobileAuth } from "./mobileAuth";
import { t } from "@/i18n";

export type TrackedRuleTask = { ownerId: number; scope: string; instanceId: string; task: RuleTaskSnapshot; lost?: boolean };
let tasks: TrackedRuleTask[] = [];
let scope = "";
const listeners = new Set<() => void>();
function boundedTasks(rows: TrackedRuleTask[]) {
  const pending = rows.filter(row => !row.task.finishedAt && !row.lost);
  return [...pending, ...rows.filter(row => row.task.finishedAt || row.lost).slice(-(20 - pending.length))].slice(0, 20);
}
export const ruleTaskTracker = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot: () => tasks,
};
export function ruleTaskScope(userId: number) {
  const panel = mobileAuth.isNative ? mobileAuth.getPanelUrl() : typeof window === "undefined" ? "" : window.location.origin;
  return `${panel}:${userId}`;
}
function publish() {
  try { sessionStorage.setItem(`forwardx.ruleTasks:${scope}`, JSON.stringify(tasks.filter(row => !row.task.finishedAt && !row.lost).map(row => ({ ...row, task: { ...row.task, results: undefined } })))); } catch { /* optional tab recovery */ }
  for (const listener of listeners) listener();
}
export function configureRuleTasks(userId: number) {
  const next = ruleTaskScope(userId);
  if (next === scope) return;
  scope = next; tasks = [];
  try {
    const saved = JSON.parse(sessionStorage.getItem(`forwardx.ruleTasks:${scope}`) || "[]");
    if (Array.isArray(saved)) tasks = saved.filter(row => row?.scope === scope && row.ownerId === userId && typeof row.instanceId === "string"
      && /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(row.task?.id)
      && typeof row.task.title === "string" && row.task.title.length <= 80 && ["queued", "running"].includes(row.task.state)
      && !row.task.finishedAt && row.task.total > 0 && row.task.total <= 5000 && row.task.completed <= row.task.total
      && ["total", "completed", "succeeded", "failed", "skipped", "cancelled"].every(key => Number.isSafeInteger(row.task[key]) && row.task[key] >= 0)
      && row.task.completed === row.task.succeeded + row.task.failed + row.task.skipped + row.task.cancelled).slice(0, 20);
  } catch { /* ignore malformed storage */ }
  publish();
}
export function registerRuleTask(userId: number, instanceId: string, task: RuleTaskSnapshot) {
  configureRuleTasks(userId);
  const existing = tasks.find(row => row.task.id === task.id);
  tasks = boundedTasks([...tasks.filter(row => row !== existing), { ownerId: userId, scope, instanceId, task }]);
  publish();
}
export function updateRuleTasks(userId: number, instanceId: string, ids: string[], snapshots: Array<RuleTaskSnapshot | null>) {
  const expectedScope = ruleTaskScope(userId);
  if (scope !== expectedScope) return;
  tasks = tasks.map(row => {
    const index = ids.indexOf(row.task.id);
    if (index < 0 || row.scope !== expectedScope || row.task.finishedAt || row.lost) return row;
    const task = snapshots[index];
    return row.instanceId !== instanceId || !task ? { ...row, lost: true } : { ...row, task };
  });
  publish();
}
export function dismissRuleTask(id: string) {
  tasks = tasks.filter(row => row.task.id !== id || !row.task.finishedAt && !row.lost); publish();
}
export function waitForRuleTask(userId: number, id: string): Promise<RuleTaskSnapshot> {
  const expectedScope = ruleTaskScope(userId);
  return new Promise((resolve, reject) => {
    const check = () => {
      const row = tasks.find(row => row.task.id === id && row.scope === expectedScope);
      if (!row || row.lost) { unsubscribe(); reject(Error(t("任务记录已丢失或过期，请核对规则后再操作，不要重复提交"))); }
      else if (row.task.finishedAt) { unsubscribe(); resolve(row.task); }
    };
    const unsubscribe = ruleTaskTracker.subscribe(check);
    check();
  });
}

type SubmissionApi = {
  enqueue(input: { requestId: string; title: string; actions: RuleTaskAction[] }): Promise<{ instanceId: string; task: RuleTaskSnapshot }>;
  lookup(input: { requestId: string }): Promise<{ instanceId: string; task: RuleTaskSnapshot | null }>;
};
export async function submitRuleTask(api: SubmissionApi, userId: number, title: string, actions: RuleTaskAction[], onAccepted?: () => void) {
  configureRuleTasks(userId);
  const expectedScope = ruleTaskScope(userId);
  // getRandomValues also works on ordinary HTTP panels, unlike randomUUID.
  const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  let accepted;
  try { accepted = await api.enqueue({ requestId, title, actions }); }
  catch (error) {
    // The enqueue response can be lost after acceptance. Look it up, never
    // blindly submit another job (especially creates) with a different ID.
    const existing = await api.lookup({ requestId }).catch(() => null);
    if (!existing?.task) {
      const code = (error as any)?.data?.code;
      if (code && !["INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE", "TIMEOUT"].includes(code)) throw error;
      throw Error(t("任务提交结果暂无法确认，请核对规则后再操作，不要重复提交"));
    }
    accepted = { instanceId: existing.instanceId, task: existing.task };
  }
  if (scope !== expectedScope) {
    try {
      const key = `forwardx.ruleTasks:${expectedScope}`;
      const saved = JSON.parse(sessionStorage.getItem(key) || "[]");
      const own = Array.isArray(saved) ? saved.filter(row => row?.ownerId === userId && row.scope === expectedScope && row.task?.id !== accepted.task.id) : [];
      sessionStorage.setItem(key, JSON.stringify(boundedTasks([...own, { ownerId: userId, scope: expectedScope, instanceId: accepted.instanceId, task: accepted.task }])));
    } catch { /* optional recovery */ }
    throw Error(t("任务已提交，请使用原账号查看执行情况"));
  }
  registerRuleTask(userId, accepted.instanceId, accepted.task);
  onAccepted?.();
  return waitForRuleTask(userId, accepted.task.id);
}
