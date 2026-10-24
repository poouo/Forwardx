import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import express from "express";
import { connectDatabase, closeDatabase, executeRaw, queryRaw } from "./dbRuntime";
import { ensureDatabaseSchema } from "./dbSchema";
import { agentRouter } from "./agentRoutes";
import { decryptPayload, encryptPayload } from "./agentCrypto";
import { claimAgentInstallation } from "./agentInstallation";
import { getAgentAuthHostIdentity, invalidateAgentAuthTokenCandidates } from "./repositories/tokenRepository";

const token = "installation-route-test-token";
const first = "a".repeat(64), second = "b".repeat(64), third = "c".repeat(64);
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(agentRouter);
const server = http.createServer(app);
let base = "";

async function post(route: string, installationId: string, body: Record<string, unknown>) {
  const env = encryptPayload({ path: route, installationId, payload: body }, token);
  const response = await fetch(base + "/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
  const decoded = decryptPayload(await response.json(), token, { validateTimestamp: false });
  assert.equal(response.status, 200, JSON.stringify(decoded));
  return decoded as any;
}

async function register(id: string, ip = "203.0.113.10") {
  return post("/api/agent/register", id, { token, ip, ipv4: ip, agentVersion: "2.2.201" });
}

try {
  await connectDatabase({ type: "sqlite", sqlite: { path: process.env.FORWARDX_TEST_DB! } });
  await ensureDatabaseSchema();
  await executeRaw('INSERT INTO "users" ("id", "username", "password", "role") VALUES (?, ?, ?, ?)', [1, "owner", "test-hash", "admin"]);
  await executeRaw('INSERT INTO "agent_tokens" ("id", "token", "userId") VALUES (?, ?, ?)', [1, token, 1]);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = "http://127.0.0.1:" + (server.address() as any).port;
  assert.equal((await register(first)).hostId, 1);
  assert.equal((await getAgentAuthHostIdentity(token))?.agentInstallationId, first);
  await executeRaw('INSERT INTO "forward_rules" ("id", "hostId", "name", "forwardType", "protocol", "sourcePort", "targetIp", "targetPort", "userId", "isEnabled", "isRunning") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [1, 1, "realm-restored", "realm", "tcp", 21000, "198.51.100.30", 443, 1, 1, 1]);
  // Warm recovery cooldown and restore the stale DB flag. A replacement even
  // with the same IP, still-online host and custom ingress MUST reset it again.
  await register(first);
  await executeRaw('UPDATE "hosts" SET "entryIp" = ? WHERE "id" = ?', ["ingress.example.test", 1]);
  await executeRaw('UPDATE "forward_rules" SET "isRunning" = ? WHERE "id" = ?', [1, 1]);
  const streamEnv = encryptPayload({ agentVersion: "2.2.201", installationId: first }, token);
  const stream = await fetch(base + "/api/stream?e=" + encodeURIComponent(JSON.stringify(streamEnv)));
  const reader = stream.body!.getReader();
  const ready = await reader.read();
  assert.match(new TextDecoder().decode(ready.value), /event: message/);

  assert.equal((await register(second)).agentSuperseded, undefined);
  assert.equal(Number((await queryRaw('SELECT "isRunning" FROM "forward_rules" WHERE "id" = ?', [1]))[0].isRunning), 0);
  assert.equal((await getAgentAuthHostIdentity(token))?.agentInstallationId, second);
  let retiredEvent = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    retiredEvent += new TextDecoder().decode(next.value);
  }
  assert.ok(retiredEvent.includes("data: "), "old stream should receive takeover notice");
  const lastEnvelope = JSON.parse(retiredEvent.split("data: ").at(-1)!.trim());
  assert.equal((decryptPayload(lastEnvelope, token, { validateTimestamp: false }) as any).type, "agent-superseded");

  assert.equal((await register(first, "203.0.113.99")).agentSuperseded, true);
  assert.equal((await post("/api/agent/heartbeat", first, { ip: "203.0.113.99" })).agentSuperseded, true);
  assert.equal((await post("/api/agent/rule-status", first, { ruleId: 1, success: true, isRunning: true })).agentSuperseded, true);
  assert.equal((await post("/api/agent/traffic", first, { stats: [{ ruleId: 1, bytesIn: 999, bytesOut: 999 }] })).agentSuperseded, true);
  assert.equal((await post("/api/agent/presence", "", {})).agentSuperseded, true, "legacy requests cannot steal the active host");
  assert.equal((await queryRaw('SELECT "ip" FROM "hosts" WHERE "id" = ?', [1]))[0].ip, "203.0.113.10");
  assert.equal(Number((await queryRaw('SELECT "isRunning" FROM "forward_rules" WHERE "id" = ?', [1]))[0].isRunning), 0);
  const heartbeat = await post("/api/agent/heartbeat", second, {
    agentVersion: "2.2.201", ip: "203.0.113.10", ipv4: "203.0.113.10", defaultNetworkInterface: "ens3",
    localState: { rules: [], tunnels: [], services: [] },
  });
  const actions = heartbeat.desiredState?.actions || heartbeat.actions || [];
  const realm = actions.find((action: any) => action.ruleId === 1 && action.op === "apply");
  assert.ok(realm, "new machine must receive actual Realm config, not just restored UI state");
  assert.match(realm.unit, /\/usr\/local\/bin\/realm/);
  assert.match(realm.unit, /--interface ens3/);
  assert.ok(realm.preCommands.some((command: string) => command.includes("base64 -d")), "Realm TOML must be recreated");
  assert.equal(Number((await queryRaw('SELECT COUNT(*) AS total FROM "traffic_stats"'))[0].total), 0, "retired reports must not count usage");
  assert.equal((await post("/api/agent/traffic", second, { stats: [{ ruleId: 1, bytesIn: 10, bytesOut: 20 }], reportId: "new-agent-traffic", reportProducerId: "new-installation" })).agentSuperseded, undefined);
  assert.ok(Number((await queryRaw('SELECT COUNT(*) AS total FROM "traffic_stats"'))[0].total) > 0, "current Agent reporting must still work");

  // DB history, not an in-memory blacklist, prevents an old restart reclaiming.
  invalidateAgentAuthTokenCandidates();
  assert.equal((await claimAgentInstallation(1, first)).accepted, false);
  assert.equal((await claimAgentInstallation(1, third)).accepted, true);
  assert.equal((await claimAgentInstallation(1, second)).accepted, false);
  await executeRaw('UPDATE "hosts" SET "isOnline" = ?, "lastHeartbeat" = ? WHERE "id" = ?', [0, 0, 1]);
  assert.equal((await register("d".repeat(64))).agentSuperseded, undefined, "offline predecessor must not block replacement");
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDatabase();
}
