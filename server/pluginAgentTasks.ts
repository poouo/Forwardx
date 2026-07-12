import crypto from "crypto";

export type PluginAgentTaskStatus = "queued" | "running" | "success" | "error" | "timeout";
export type PluginAgentGroupStatus = "queued" | "running" | "success" | "partial" | "error" | "timeout";

export type PluginAgentTask = {
  taskId: string;
  groupId: string;
  pluginId: string;
  pluginVersion: string;
  actionId: string;
  contextId: string;
  executor: "script";
  interpreter: "bash" | "sh" | "python3";
  workingDirectory: string;
  entry: string;
  arguments: string[];
  timeoutMs: number;
  outputType: "json" | "text";
  createdAt: string;
};

export type PluginAgentTaskResult = {
  taskId: string;
  groupId: string;
  pluginId: string;
  actionId: string;
  contextId?: string;
  success: boolean;
  output?: string;
  stderr?: string;
  data?: unknown;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

export type PluginAgentTaskHostResult = PluginAgentTaskResult & {
  hostId: number;
  hostName: string;
  status: PluginAgentTaskStatus;
};

export type PluginAgentTaskGroup = {
  groupId: string;
  pluginId: string;
  pluginVersion: string;
  actionId: string;
  contextId: string;
  createdAt: string;
  updatedAt: string;
  total: number;
  completed: number;
  done: boolean;
  status: PluginAgentGroupStatus;
  results: PluginAgentTaskHostResult[];
};

type PluginAgentTaskGroupState = PluginAgentTaskGroup & {
  timeoutTimer?: NodeJS.Timeout;
  expiresAt: number;
};

type PluginAgentTaskHost = {
  id: number;
  name?: string | null;
};

type PluginAgentTaskGroupInput = {
  pluginId: string;
  pluginVersion?: string | null;
  actionId: string;
  contextId?: string | null;
  executor: "script";
  interpreter?: "bash" | "sh" | "python3" | null;
  workingDirectory: string;
  entry: string;
  arguments?: string[] | null;
  timeoutMs?: number | null;
  outputType?: "json" | "text" | null;
  hosts: PluginAgentTaskHost[];
};

const TASK_RETENTION_MS = 15 * 60 * 1000;
const MIN_TASK_TIMEOUT_MS = 1_000;
const MAX_TASK_TIMEOUT_MS = 60_000;
const GROUP_TIMEOUT_GRACE_MS = 10_000;
const MAX_TASKS_PER_HOST = 20;
const taskQueues = new Map<number, PluginAgentTask[]>();
const taskGroups = new Map<string, PluginAgentTaskGroupState>();

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value: unknown, limit: number) {
  return String(value || "").trim().slice(0, limit);
}

function clampTaskTimeout(value: unknown) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return 15_000;
  return Math.max(MIN_TASK_TIMEOUT_MS, Math.min(MAX_TASK_TIMEOUT_MS, parsed));
}

function isTerminalTaskStatus(status: PluginAgentTaskStatus) {
  return status === "success" || status === "error" || status === "timeout";
}

function removeQueuedTasks(groupId: string) {
  for (const [hostId, queue] of taskQueues) {
    const next = queue.filter((task) => task.groupId !== groupId);
    if (next.length > 0) taskQueues.set(hostId, next);
    else taskQueues.delete(hostId);
  }
}

function refreshGroup(group: PluginAgentTaskGroupState) {
  const completed = group.results.filter((result) => isTerminalTaskStatus(result.status)).length;
  const successful = group.results.filter((result) => result.status === "success").length;
  const timedOut = group.results.filter((result) => result.status === "timeout").length;
  group.completed = completed;
  group.done = completed >= group.total;
  if (!group.done) {
    group.status = group.results.some((result) => result.status === "running") ? "running" : "queued";
    return;
  }
  if (successful === group.total) {
    group.status = "success";
  } else if (successful > 0) {
    group.status = "partial";
  } else if (timedOut === group.total) {
    group.status = "timeout";
  } else {
    group.status = "error";
  }
  group.expiresAt = Date.now() + TASK_RETENTION_MS;
  if (group.timeoutTimer) {
    clearTimeout(group.timeoutTimer);
    group.timeoutTimer = undefined;
  }
}

function expireOverdueGroups() {
  const now = Date.now();
  for (const [groupId, group] of taskGroups) {
    if (group.done && group.expiresAt <= now) {
      if (group.timeoutTimer) clearTimeout(group.timeoutTimer);
      taskGroups.delete(groupId);
    }
  }
}

function markGroupTimedOut(groupId: string) {
  const group = taskGroups.get(groupId);
  if (!group || group.done) return;
  const finishedAt = nowIso();
  for (const result of group.results) {
    if (isTerminalTaskStatus(result.status)) continue;
    result.status = "timeout";
    result.success = false;
    result.timedOut = true;
    result.finishedAt = finishedAt;
    result.error = "Agent 未在超时时间内回报插件操作结果";
    result.output = result.output || result.error;
  }
  removeQueuedTasks(groupId);
  group.updatedAt = finishedAt;
  refreshGroup(group);
}

function publicGroup(group: PluginAgentTaskGroupState): PluginAgentTaskGroup {
  const { timeoutTimer: _timeoutTimer, expiresAt: _expiresAt, ...value } = group;
  return {
    ...value,
    results: value.results.map((result) => ({ ...result })),
  };
}

export function enqueuePluginAgentTaskGroup(input: PluginAgentTaskGroupInput) {
  expireOverdueGroups();
  const pluginId = normalizeText(input.pluginId, 128);
  const actionId = normalizeText(input.actionId, 128);
  const workingDirectory = normalizeText(input.workingDirectory, 512);
  const entry = normalizeText(input.entry, 256);
  if (!pluginId || !actionId || !workingDirectory || !entry) {
    throw new Error("插件 Agent 操作缺少必要参数");
  }
  if (input.executor !== "script") throw new Error("不支持的插件 Agent 执行器");
  const interpreter = input.interpreter === "sh" || input.interpreter === "python3" ? input.interpreter : "bash";
  const outputType = input.outputType === "text" ? "text" : "json";
  const timeoutMs = clampTaskTimeout(input.timeoutMs);
  const hosts = Array.from(new Map((input.hosts || [])
    .map((host) => ({ id: Math.floor(Number(host?.id)), name: normalizeText(host?.name, 160) }))
    .filter((host) => Number.isInteger(host.id) && host.id > 0)
    .map((host) => [host.id, host]))
    .values());
  if (hosts.length === 0) throw new Error("没有可执行插件操作的主机");

  const createdAt = nowIso();
  const groupId = crypto.randomUUID();
  const argumentsList = Array.isArray(input.arguments)
    ? input.arguments.map((item) => normalizeText(item, 24 * 1024)).slice(0, 16)
    : [];
  const group: PluginAgentTaskGroupState = {
    groupId,
    pluginId,
    pluginVersion: normalizeText(input.pluginVersion, 64),
    actionId,
    contextId: normalizeText(input.contextId, 128),
    createdAt,
    updatedAt: createdAt,
    total: hosts.length,
    completed: 0,
    done: false,
    status: "queued",
    expiresAt: Date.now() + timeoutMs + GROUP_TIMEOUT_GRACE_MS + TASK_RETENTION_MS,
    results: [],
  };

  for (const host of hosts) {
    const task: PluginAgentTask = {
      taskId: crypto.randomUUID(),
      groupId,
      pluginId,
      pluginVersion: group.pluginVersion,
      actionId,
      contextId: group.contextId,
      executor: "script",
      interpreter,
      workingDirectory,
      entry,
      arguments: argumentsList,
      timeoutMs,
      outputType,
      createdAt,
    };
    group.results.push({
      taskId: task.taskId,
      groupId,
      pluginId,
      actionId,
      contextId: group.contextId,
      hostId: host.id,
      hostName: host.name || `主机 ${host.id}`,
      status: "queued",
      success: false,
      output: "任务已创建，等待 Agent 拉取执行...",
    });
    const queue = taskQueues.get(host.id) || [];
    queue.push(task);
    taskQueues.set(host.id, queue.slice(-MAX_TASKS_PER_HOST));
  }
  group.timeoutTimer = setTimeout(() => markGroupTimedOut(groupId), timeoutMs + GROUP_TIMEOUT_GRACE_MS);
  group.timeoutTimer.unref?.();
  taskGroups.set(groupId, group);
  return publicGroup(group);
}

export function takePluginAgentTasks(
  hostId: number,
  limit = 2,
  canTake: (task: PluginAgentTask) => boolean = () => true,
) {
  expireOverdueGroups();
  const id = Math.floor(Number(hostId));
  if (!Number.isInteger(id) || id <= 0) return [];
  const queue = taskQueues.get(id) || [];
  const takeLimit = Math.max(1, Math.min(8, Math.floor(limit) || 2));
  const tasks: PluginAgentTask[] = [];
  const remaining: PluginAgentTask[] = [];
  for (const task of queue) {
    if (tasks.length < takeLimit && canTake(task)) tasks.push(task);
    else remaining.push(task);
  }
  if (remaining.length > 0) taskQueues.set(id, remaining);
  else taskQueues.delete(id);
  const startedAt = nowIso();
  for (const task of tasks) {
    const group = taskGroups.get(task.groupId);
    const result = group?.results.find((item) => item.taskId === task.taskId && item.hostId === id);
    if (!group || !result || group.done || isTerminalTaskStatus(result.status)) continue;
    result.status = "running";
    result.startedAt = startedAt;
    result.output = "Agent 已拉取任务，正在执行插件操作...";
    group.updatedAt = startedAt;
    refreshGroup(group);
  }
  return tasks;
}

export function hasQueuedPluginAgentTasks(hostId: number) {
  expireOverdueGroups();
  const id = Math.floor(Number(hostId));
  return Number.isInteger(id) && id > 0 && (taskQueues.get(id)?.length || 0) > 0;
}

export function completePluginAgentTask(hostId: number, input: PluginAgentTaskResult) {
  expireOverdueGroups();
  const id = Math.floor(Number(hostId));
  const groupId = normalizeText(input.groupId, 64);
  const taskId = normalizeText(input.taskId, 64);
  const group = taskGroups.get(groupId);
  if (!group || !taskId || !Number.isInteger(id) || id <= 0) return false;
  if (group.pluginId !== normalizeText(input.pluginId, 128) || group.actionId !== normalizeText(input.actionId, 128)) return false;
  const result = group.results.find((item) => item.taskId === taskId && item.hostId === id);
  if (!result) return false;
  if (isTerminalTaskStatus(result.status)) return true;
  const finishedAt = normalizeText(input.finishedAt, 80) || nowIso();
  const timedOut = input.timedOut === true;
  const success = input.success === true && !timedOut;
  result.status = timedOut ? "timeout" : success ? "success" : "error";
  result.success = success;
  result.output = String(input.output || "").slice(0, 256 * 1024);
  result.stderr = String(input.stderr || "").slice(0, 256 * 1024);
  result.data = input.data;
  result.exitCode = input.exitCode === undefined || input.exitCode === null ? null : Number(input.exitCode);
  result.timedOut = timedOut;
  result.durationMs = Math.max(0, Math.floor(Number(input.durationMs) || 0));
  result.startedAt = normalizeText(input.startedAt, 80) || result.startedAt;
  result.finishedAt = finishedAt;
  result.error = normalizeText(input.error, 4_000) || undefined;
  if (!result.output && result.error) result.output = result.error;
  group.updatedAt = finishedAt;
  refreshGroup(group);
  return true;
}

export function getPluginAgentTaskGroup(groupId: string) {
  expireOverdueGroups();
  const group = taskGroups.get(normalizeText(groupId, 64));
  return group ? publicGroup(group) : null;
}

export function clearPluginAgentTasksForTest() {
  for (const group of taskGroups.values()) {
    if (group.timeoutTimer) clearTimeout(group.timeoutTimer);
  }
  taskQueues.clear();
  taskGroups.clear();
}
