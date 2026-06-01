import crypto from "crypto";

export type LookingGlassMethod = "ping" | "ping6" | "traceroute" | "traceroute6" | "mtr" | "mtr6" | "tcp";
export type LookingGlassTaskState = "queued" | "running" | "success" | "error" | "timeout";

export type LookingGlassAgentTask = {
  taskId: string;
  method: LookingGlassMethod;
  target: string;
  resolvedAddress: string;
  resolvedAddresses: string[];
  family: number;
  port?: number;
  createdAt: string;
};

export type LookingGlassAgentResult = {
  taskId: string;
  method: LookingGlassMethod;
  target: string;
  port?: number;
  resolvedAddress: string;
  resolvedAddresses: string[];
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  error?: string;
};

export type LookingGlassTaskStatus = LookingGlassAgentResult & {
  status: LookingGlassTaskState;
  createdAt: string;
  updatedAt: string;
};

type TaskState = {
  hostId: number;
  task: LookingGlassAgentTask;
  status: LookingGlassTaskState;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  updatedAt: string;
  error?: string;
  timer: NodeJS.Timeout;
};

const queues = new Map<number, LookingGlassAgentTask[]>();
const states = new Map<string, TaskState>();

const TERMINAL_STATES = new Set<LookingGlassTaskState>(["success", "error", "timeout"]);

function nowIso() {
  return new Date().toISOString();
}

function toStatus(state: TaskState): LookingGlassTaskStatus {
  return {
    taskId: state.task.taskId,
    method: state.task.method,
    target: state.task.target,
    port: state.task.port,
    resolvedAddress: state.task.resolvedAddress,
    resolvedAddresses: state.task.resolvedAddresses,
    output: state.output,
    exitCode: state.exitCode,
    timedOut: state.timedOut,
    durationMs: state.durationMs,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    error: state.error,
    status: state.status,
    createdAt: state.task.createdAt,
    updatedAt: state.updatedAt,
  };
}

function markTimeout(taskId: string) {
  const state = states.get(taskId);
  if (!state || TERMINAL_STATES.has(state.status)) return;
  const finishedAt = nowIso();
  state.status = "timeout";
  state.timedOut = true;
  state.exitCode = 1;
  state.finishedAt = finishedAt;
  state.updatedAt = finishedAt;
  state.error = "Agent 执行网络测试超时，请确认目标主机在线";
  state.output = `${state.output ? `${state.output}\n` : ""}${state.error}`;
}

export function enqueueLookingGlassAgentTask(
  hostId: number,
  input: Omit<LookingGlassAgentTask, "taskId" | "createdAt">,
  timeoutMs = 60_000,
) {
  const task: LookingGlassAgentTask = {
    ...input,
    taskId: crypto.randomUUID(),
    createdAt: nowIso(),
  };
  const queue = queues.get(hostId) || [];
  queue.push(task);
  queues.set(hostId, queue.slice(-20));

  const timer = setTimeout(() => markTimeout(task.taskId), timeoutMs);
  const state: TaskState = {
    hostId,
    task,
    status: "queued",
    output: "任务已创建，等待 Agent 拉取执行...",
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    startedAt: task.createdAt,
    finishedAt: "",
    updatedAt: task.createdAt,
    timer,
  };
  states.set(task.taskId, state);

  return { task, status: toStatus(state) };
}

export function takeLookingGlassAgentTasks(hostId: number, limit = 4) {
  const queue = queues.get(hostId) || [];
  const tasks = queue.splice(0, limit);
  if (queue.length > 0) queues.set(hostId, queue);
  else queues.delete(hostId);
  for (const task of tasks) {
    const state = states.get(task.taskId);
    if (!state || TERMINAL_STATES.has(state.status)) continue;
    const startedAt = nowIso();
    state.status = "running";
    state.startedAt = startedAt;
    state.updatedAt = startedAt;
    state.output = "Agent 已拉取任务，正在启动测试命令...";
  }
  return tasks;
}

export function updateLookingGlassAgentTaskProgress(
  hostId: number,
  result: Partial<LookingGlassAgentResult> & { taskId: string },
) {
  const state = states.get(result.taskId);
  if (!state || state.hostId !== hostId || TERMINAL_STATES.has(state.status)) return false;
  const updatedAt = nowIso();
  state.status = "running";
  state.output = String(result.output ?? state.output);
  state.durationMs = Number(result.durationMs ?? state.durationMs) || 0;
  state.startedAt = String(result.startedAt || state.startedAt || updatedAt);
  state.updatedAt = updatedAt;
  if (result.error) state.error = String(result.error);
  return true;
}

export function completeLookingGlassAgentTask(hostId: number, result: LookingGlassAgentResult) {
  const state = states.get(result.taskId);
  if (!state || state.hostId !== hostId) return false;
  clearTimeout(state.timer);
  const updatedAt = nowIso();
  state.status = result.timedOut ? "timeout" : result.exitCode === 0 ? "success" : "error";
  state.output = String(result.output || "");
  state.exitCode = result.exitCode === undefined ? null : result.exitCode;
  state.timedOut = !!result.timedOut;
  state.durationMs = Number(result.durationMs || 0);
  state.startedAt = String(result.startedAt || state.startedAt || updatedAt);
  state.finishedAt = String(result.finishedAt || updatedAt);
  state.updatedAt = updatedAt;
  state.error = result.error;
  setTimeout(() => states.delete(result.taskId), 15 * 60 * 1000);
  return true;
}

export function getLookingGlassAgentTaskStatus(hostId: number, taskId: string) {
  const state = states.get(taskId);
  if (!state || state.hostId !== hostId) return null;
  return toStatus(state);
}
