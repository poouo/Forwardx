import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { advanceChinaHealth, hostChinaHealthSchema, ipSwitchHookSchema, readJsonPath } from "../shared/hostChinaHealth";
import { recordIpSwitchAgentCapability, ipSwitchAgentReady, enqueueIpSwitchAgentTask, takeIpSwitchAgentTasks, claimIpSwitchAgentTask, completeIpSwitchAgentTask } from "./agentIpSwitchTasks";
import { requestIpSwitch, verifyIpSwitchResponse } from "./hostIpSwitchProvider";
import { AGENT_TUNNEL_PATHS } from "./agentEncryptionMiddleware";

test("health detection requires sustained failures, deduplicates samples and requires recovery successes", () => {
  const config = hostChinaHealthSchema.parse({ failureThreshold: 2, failureSeconds: 30 });
  let result = advanceChinaHealth(null, false, 1000, 15, config);
  assert.equal(result.state.phase, "suspect");
  assert.equal(advanceChinaHealth(result.state, false, 1001, 15, config).state.failures, 1);
  result = advanceChinaHealth(result.state, false, 1015, 15, config);
  assert.equal(result.event, undefined);
  result = advanceChinaHealth(result.state, false, 1030, 15, config);
  assert.equal(result.event, "unhealthy");
  result.state.incidentId = "incident"; result.state.actionAttempted = true;
  result = advanceChinaHealth(result.state, false, 1045, 15, config);
  assert.equal(result.event, undefined); assert.equal(result.state.actionAttempted, true);
  result = advanceChinaHealth(result.state, true, 1060, 15, config);
  assert.equal(result.state.phase, "recovering");
  result = advanceChinaHealth(result.state, false, 1075, 15, config);
  assert.equal(result.state.phase, "unhealthy"); assert.equal(result.state.incidentId, "incident");
  for (const at of [1090, 1105]) result = advanceChinaHealth(result.state, true, at, 15, config);
  assert.equal(result.event, "recovered"); assert.equal(result.state.actionAttempted, false);
  const gap = advanceChinaHealth(advanceChinaHealth(null, false, 1000, 15, config).state, false, 1500, 15, config);
  assert.equal(gap.state.failures, 1); assert.equal(gap.event, undefined);
});

test("provider schema supports private HTTP GET without allowing shell scripts or unsafe headers", () => {
  assert.ok(AGENT_TUNNEL_PATHS.has("/api/agent/ip-switch-claim"));
  assert.ok(AGENT_TUNNEL_PATHS.has("/api/agent/ip-switch-result"));
  const hook = ipSwitchHookSchema.parse({ url: "http://10.0.0.1/api/changeip?token=secret", successMode: "http" });
  assert.equal(hook.method, "GET");
  for (const change of [{ url: "file:///etc/passwd" }, { headers: { Host: "localhost" } }, { headers: { "X-Key": "x\r\ny" } }, { body: "unexpected" }, { successMode: "json" }, { updateAddress: "entry" }]) {
    assert.equal(ipSwitchHookSchema.safeParse({ ...hook, ...change }).success, false);
  }
  assert.equal(readJsonPath({}, "__proto__.toString"), undefined);
  assert.equal(hostChinaHealthSchema.parse({}).autoSwitch, false);
  assert.equal(hostChinaHealthSchema.parse({}).cooldownSeconds, 60 * 60);
});

test("queued timeouts distinguish undelivered tasks from ambiguous delivered calls", async () => {
  const request = ipSwitchHookSchema.parse({ url: "http://10.0.0.1/changeip", successMode: "http" });
  for (const delivered of [false, true]) {
    const hostId = delivered ? 77703 : 77702;
    recordIpSwitchAgentCapability(hostId, true);
    const result = enqueueIpSwitchAgentTask(hostId, { taskId: randomUUID(), serviceId: 1, expectedIp: "1.1.1.1", request }, 50);
    if (delivered) assert.equal(takeIpSwitchAgentTasks(hostId).length, 1);
    const [response] = await Promise.all([result, new Promise(resolve => setTimeout(resolve, 70))]);
    assert.equal(response.outcome, delivered ? "uncertain" : "not_executed");
    assert.deepEqual(takeIpSwitchAgentTasks(hostId), []);
  }
});

test("IP tasks are bound to one capable host, delivered and claimed at most once, with no credential echo", async () => {
  const hostId = 77701;
  const hook = ipSwitchHookSchema.parse({ url: "http://10.0.0.1/changeip?token=secret&ip={{ip}}", successMode: "http" });
  const context = { hostId, serviceId: 1, ip: "2001:4860:4860::8888", incidentId: randomUUID() };
  assert.equal(ipSwitchAgentReady(hostId), false);
  assert.throws(() => requestIpSwitch(hook, context), /agent_unavailable/);
  recordIpSwitchAgentCapability(hostId, true);
  const response = requestIpSwitch(hook, context);
  assert.deepEqual(takeIpSwitchAgentTasks(hostId + 1), []);
  const [task] = takeIpSwitchAgentTasks(hostId);
  assert.ok(task.request.url.includes("ip=2001%3A4860%3A4860%3A%3A8888"));
  assert.deepEqual(takeIpSwitchAgentTasks(hostId), []);
  assert.equal(await claimIpSwitchAgentTask(hostId + 1, task.taskId, async () => true), false);
  assert.equal(completeIpSwitchAgentTask(hostId, { taskId: task.taskId, outcome: "accepted", reason: "ok" }), false);
  assert.equal(await claimIpSwitchAgentTask(hostId, task.taskId, async (id, uuid, expectedIp) => id === 1 && uuid === task.taskId && expectedIp === context.ip), true);
  assert.equal(await claimIpSwitchAgentTask(hostId, task.taskId, async () => true), false);
  assert.equal(completeIpSwitchAgentTask(hostId + 1, { taskId: task.taskId, outcome: "accepted", reason: "ok" }), false);
  assert.equal(completeIpSwitchAgentTask(hostId, { taskId: task.taskId, outcome: "accepted", reason: "ok", body: "secret" }), false);
  assert.equal(completeIpSwitchAgentTask(hostId, { taskId: task.taskId, outcome: "accepted", reason: "ok" }), true);
  assert.equal((await response).outcome, "accepted");
  assert.equal(completeIpSwitchAgentTask(hostId, { taskId: task.taskId, outcome: "accepted", reason: "ok" }), false);
  const deniedId = randomUUID();
  const denied = enqueueIpSwitchAgentTask(hostId, { taskId: deniedId, serviceId: 1, expectedIp: "1.1.1.1", request: hook });
  takeIpSwitchAgentTasks(hostId);
  assert.equal(await claimIpSwitchAgentTask(hostId, deniedId, async () => false), false);
  assert.equal(completeIpSwitchAgentTask(hostId, { taskId: deniedId, outcome: "accepted", reason: "ok" }), false);
  assert.equal(completeIpSwitchAgentTask(hostId, { taskId: deniedId, outcome: "not_executed", reason: "claim_denied" }), true);
  await denied;
  recordIpSwitchAgentCapability(hostId, false);
  assert.equal(ipSwitchAgentReady(hostId), false);
});

test("only explicit provider success and a different public address permit panel sync", async () => {
  const hook = ipSwitchHookSchema.parse({ url: "http://10.0.0.1/changeip", successMode: "json", successPath: "success", successValue: true, ipPath: "ip" });
  const result = { taskId: randomUUID(), outcome: "verified" as const, reason: "ok" as const, newIp: "8.8.4.4" };
  assert.equal(await verifyIpSwitchResponse(hook, result, "1.1.1.1"), "8.8.4.4");
  await assert.rejects(verifyIpSwitchResponse(hook, { ...result, outcome: "accepted" }, "1.1.1.1"));
  for (const newIp of ["1.1.1.1", "10.0.0.2", "127.0.0.1", "not-an-ip"]) await assert.rejects(verifyIpSwitchResponse(hook, { ...result, newIp }, "1.1.1.1"));
});

test("SQLite permissions, encrypted configuration, automatic actions, safeguards and cleanup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-china-health-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/hostProbeHealth.fixture.ts"], { cwd: process.cwd(), encoding: "utf8", timeout: 90000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"), FORWARDX_LOG_DIR: path.join(directory, "logs"), JWT_SECRET: "china-health-test-secret-only-32-characters", TELEGRAM_BOT_TOKEN: "", DISCORD_BOT_TOKEN: "" } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
