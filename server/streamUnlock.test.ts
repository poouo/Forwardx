import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { STREAM_UNLOCK_PROBE_VERSION, type StreamUnlockAgentResult } from "../shared/streamUnlock";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-stream-unlock-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = path.join(directory, "test.db");
process.env.DATABASE_CONFIG_PATH = path.join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = path.join(directory, "logs");
let runtime: typeof import("./dbRuntime");
let tasks: typeof import("./streamUnlockAgentTasks");
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let base: string;
let token: string;
let hostId: number;
const installationId = "a".repeat(64);

async function sync(agentPath: string, payload: unknown) {
  const { encryptPayload, decryptPayload } = await import("./agentCrypto");
  const response = await fetch(base + "/api/sync", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(encryptPayload({ path: agentPath, installationId, payload }, token)),
  });
  const envelope = await response.json();
  return { status: response.status, body: decryptPayload(envelope, token, { validateTimestamp: false }) as any };
}

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  await runtime.insertAndGetId("users", { id: 1, username: "admin", password: "unused", role: "admin", accountEnabled: true });
  const discovery = await import("./agentDiscovery");
  const config = await discovery.configureAgentDiscovery(1);
  token = (await discovery.enrollDiscoveredAgent(config.key, "1".repeat(64), "stream-test")).token;
  tasks = await import("./streamUnlockAgentTasks");
  const app = express();
  app.use(express.json());
  app.use((await import("./agentRoutes")).agentRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  const registered = await sync("/api/agent/register", { token, ip: "192.0.2.15", ipv4: "192.0.2.15", agentVersion: "2.2.214" });
  assert.equal(registered.status, 200);
  hostId = registered.body.hostId;
  assert.ok(hostId > 0);
});

after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime?.closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("real encrypted sync accepts incremental stream results and final completion", async () => {
  const queued = tasks.enqueueStreamUnlockAgentTask(hostId, { family: "both" });
  assert.equal(tasks.takeStreamUnlockAgentTasks(hostId)[0].taskId, queued.taskId);
  const result: StreamUnlockAgentResult = {
    taskId: queued.taskId, probeVersion: STREAM_UNLOCK_PROBE_VERSION, family: "both", providers: [], dns: [],
    startedAt: new Date().toISOString(), finishedAt: "",
  };
  const send = async (route: string, value: StreamUnlockAgentResult) => {
    const response = await sync(route, { result: value });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.success, true);
  };
  result.providers.push({ providerId: "youtube", providerName: "YouTube", family: "ipv4", status: "available", region: "US", evidence: "ipv4:HTTP status" });
  await send("/api/agent/stream-unlock-progress", result);
  assert.equal(tasks.latestStreamUnlockAgentTask(hostId)?.status, "running");
  assert.equal(tasks.latestStreamUnlockAgentTask(hostId)?.providers.length, 1);
  result.providers.push({ providerId: "youtube", providerName: "YouTube", family: "ipv6", status: "error", evidence: "ipv6:" });
  result.dns.push(
    { domain: "youtube.com", family: "ipv4", mode: "dns_unlocked", systemAddresses: ["192.0.2.1"], publicAddresses: ["198.51.100.1"] },
    { domain: "youtube.com", family: "ipv6", mode: "unknown", systemAddresses: [], publicAddresses: ["2001:db8::1"] },
  );
  await send("/api/agent/stream-unlock-progress", result);
  assert.deepEqual(tasks.latestStreamUnlockAgentTask(hostId)?.providers.map((row) => row.family).sort(), ["ipv4", "ipv6"]);
  assert.deepEqual(tasks.latestStreamUnlockAgentTask(hostId)?.dns, result.dns);
  result.finishedAt = new Date().toISOString();
  await send("/api/agent/stream-unlock-result", result);
  const completed = tasks.latestStreamUnlockAgentTask(hostId)!;
  assert.equal(completed.status, "success");
  assert.equal(completed.running, false);
  assert.equal(completed.providers.length, 2);
  assert.equal(completed.finishedAt, result.finishedAt);
  assert.equal(tasks.hasActiveStreamUnlockAgentTask(hostId), false);
  const late = await sync("/api/agent/stream-unlock-progress", { result });
  assert.equal(late.body.success, false, "late progress cannot restart a completed task");
});

test("stream result routing still rejects paths outside the Agent tunnel allowlist", async () => {
  const { encryptPayload } = await import("./agentCrypto");
  const response = await fetch(base + "/api/sync", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(encryptPayload({ path: "/api/trpc/hosts.streamUnlock.start", installationId, payload: {} }, token)),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Invalid encrypted request");
});
