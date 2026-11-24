import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { AGENT_VERSION } from "../shared/versions";

const directory = mkdtempSync(join(tmpdir(), "forwardx-reverse-test-"));
process.env.DATABASE_TYPE = "sqlite";
process.env.SQLITE_PATH = join(directory, "panel.db");
process.env.DATABASE_CONFIG_PATH = join(directory, "database.json");
process.env.FORWARDX_LOG_DIR = join(directory, "logs");
process.env.JWT_SECRET = "isolated-reverse-tunnel-tests-secret-value";

let runtime: typeof import("./dbRuntime");
let db: typeof import("./db");
let tunnels: typeof import("./routers/tunnels").tunnelsRouter;
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let v2TunnelId: number;

const context = (id: number, role: string) => ({
  user: { id, role, accountEnabled: true },
  req: { headers: {}, socket: {} }, res: {}, authSession: null, authFailureReason: null,
}) as any;

before(async () => {
  runtime = await import("./dbRuntime");
  await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
  await (await import("./dbSchema")).ensureDatabaseSchema();
  db = await import("./db");
  tunnels = (await import("./routers/tunnels")).tunnelsRouter;
  for (const [id, role] of [[1, "admin"], [2, "user"]] as const) {
    await runtime.insertAndGetId("users", { id, username: `reverse-${id}`, password: "unused", role, accountEnabled: true });
  }
  for (const id of [11, 22]) {
    await runtime.insertAndGetId("hosts", {
      id, name: `host-${id}`, ip: `192.0.2.${id}`, userId: 1, isOnline: true,
      agentVersion: AGENT_VERSION, agentToken: `reverse-token-${id}`,
      portRangeStart: id === 11 ? 23000 : 24000, portRangeEnd: id === 11 ? 23002 : 24000,
    });
  }
  await runtime.insertAndGetId("forward_rules", {
    hostId: 11, userId: 1, name: "entry port occupied", sourcePort: 23000,
    targetIp: "127.0.0.1", targetPort: 80, protocol: "tcp", forwardType: "gost",
  });
  await runtime.insertAndGetId("forward_rules", {
    hostId: 22, userId: 1, name: "only public exit port occupied", sourcePort: 24000,
    targetIp: "127.0.0.1", targetPort: 80, protocol: "tcp", forwardType: "gost",
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).agentToken = String(req.headers.authorization || "").replace(/^Bearer /, "");
    next();
  });
  (await import("./agentHeartbeatRoute")).registerAgentHeartbeatRoute(app);
  (await import("./agentReportRoutes")).registerAgentReportRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((done) => server.once("listening", done));
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  await runtime?.closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

const reverseV2 = {
  name: "reverse v2", entryHostId: 11, exitHostId: 22,
  mode: "forwardx", forwardxVersion: "v2", connectionDirection: "reverse",
  reverseConnectHost: "entry.example.test",
} as const;

async function agentPost(hostId: number, path: string, payload: unknown) {
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer reverse-token-${hostId}` },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

const heartbeat = (id: number, services: any[] = []) => agentPost(id, "heartbeat", {
  agentVersion: AGENT_VERSION, forceReconcile: true, localState: { rules: [], tunnels: [], services },
});

test("reverse allocation uses the entry's policy and keeps exit listeners private", async () => {
  const admin = tunnels.createCaller(context(1, "admin"));
  const ordinary = tunnels.createCaller(context(2, "user"));
  await assert.rejects(() => ordinary.create(reverseV2), { code: "FORBIDDEN" });
  await assert.rejects(() => admin.create({ ...reverseV2, forwardxVersion: "v1" }), /仅支持 GOST TLS/);
  await assert.rejects(() => admin.create({ ...reverseV2, loadBalanceEnabled: true }), /单入口/);
  await assert.rejects(() => admin.create({ ...reverseV2, reverseListenPort: 23000 }), /已被占用/);
  await assert.rejects(() => admin.create({ ...reverseV2, reverseListenPort: 25000 }), /入口隧道端口/);
  const created = await admin.create(reverseV2);
  v2TunnelId = created.id;
  assert.ok([23001, 23002].includes(created.reverseListenPort));
  assert.ok(created.listenPort > 0 && created.listenPort !== 24000);
  assert.equal(created.mimicPort, 0);
  assert.equal(await db.isPortUsedOnHost(11, created.reverseListenPort), true);
  assert.equal(await db.isPortUsedOnHost(22, created.reverseListenPort), created.listenPort === created.reverseListenPort);
  const edited = await admin.update({ id: v2TunnelId, name: "reverse v2 edited" });
  assert.equal(edited.tunnel?.reverseListenPort, created.reverseListenPort);
  await runtime.executeRaw('UPDATE "tunnels" SET "userId" = ? WHERE "id" = ?', [2, v2TunnelId]);
  const userAccess = (await import("./routers/helpers")).requireTunnelUseOrTrafficBillingAccess;
  assert.equal(await ordinary.getById({ id: v2TunnelId }), null);
  assert.equal((await ordinary.options()).some((row: any) => row.id === v2TunnelId), false);
  await assert.rejects(() => userAccess(context(2, "user"), v2TunnelId), /仅管理员/);
  await runtime.executeRaw('UPDATE "tunnels" SET "userId" = ? WHERE "id" = ?', [1, v2TunnelId]);
});

test("reverse V2 heartbeat assigns the public endpoint and keepalive to the exit peer", async () => {
  const entry = await heartbeat(11);
  const exit = await heartbeat(22);
  const payload = (body: any) => [...(body.desiredState?.actions || []), ...(body.actions || [])]
    .find((action) => Number(action.wireGuard?.tunnelId) === v2TunnelId)?.wireGuard;
  const entryPlan = payload(entry);
  const exitPlan = payload(exit);
  assert.ok(entryPlan && exitPlan);
  assert.ok(entryPlan.listenPort > 0);
  assert.equal(entryPlan.peers[0].endpointHost, undefined);
  assert.equal(exitPlan.listenPort, 0);
  assert.equal(exitPlan.peers[0].endpointHost, reverseV2.reverseConnectHost);
  assert.equal(exitPlan.peers[0].endpointPort, entryPlan.listenPort);
  assert.equal(exitPlan.peers[0].persistentKeepalive, 25);
  const probe = entry.tunnelProbes.find((item: any) => item.tunnelId === v2TunnelId);
  assert.equal(probe.wireGuardPeerId, "22");
  assert.equal(exit.tunnelProbes.some((item: any) => item.tunnelId === v2TunnelId), false);

  const report = (hostId: number, input: any) => agentPost(hostId, "tcping", { tunnels: [{ ...probe, ...input }] });
  const state = (await import("./reverseTunnelStatus")).getReverseTunnelConnectionStatus;
  const tunnel = await db.getTunnelById(v2TunnelId);
  assert.equal(state(tunnel), "waiting");
  await report(22, { latencyMs: 10 });
  await report(11, { latencyMs: 10, topologyKey: "obsolete" });
  assert.equal(state(tunnel), "waiting");
  await report(11, { latencyMs: 10 });
  assert.equal(state(tunnel), "connected");
  await report(11, { latencyMs: null, isTimeout: true });
  assert.equal(state(tunnel), "reconnecting");
  await report(11, { latencyMs: 10 });
  assert.equal(state(tunnel), "connected");
});

test("GOST reverse delivers only the public certificate and makes no exit port allocation", async (t) => {
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("openssl", ["version"]).error) return t.skip("OpenSSL is required to issue the test certificate");
  const admin = tunnels.createCaller(context(1, "admin"));
  const created = await admin.create({ ...reverseV2, name: "reverse TLS", mode: "tls" });
  const gostTunnelId = created.id;
  assert.equal(created.listenPort, 0);
  const entry = await heartbeat(11);
  const exit = await heartbeat(22);
  const config = (body: any) => [...(body.desiredState?.actions || []), ...(body.actions || [])]
    .find((action) => action.forwardType === "gost-runtime-sync")?.managedConfigs || [];
  const plans = (body: any) => config(body).filter((item: any) => item.path.endsWith(".json"))
    .flatMap((item: any) => JSON.parse(Buffer.from(item.contentBase64, "base64").toString()).services);
  assert.ok(config(entry).some((item: any) => item.path.endsWith(`gost-reverse-${gostTunnelId}.key`) && item.mode === 0o600));
  assert.ok(config(exit).some((item: any) => item.path.endsWith(`gost-reverse-${gostTunnelId}.pem`)));
  assert.equal(config(exit).some((item: any) => item.path.endsWith(".key")), false);
  assert.ok(plans(entry).some((service: any) => service.name === `fwx-reverse-${gostTunnelId}` && service.listener.type === "tls"));
  assert.ok(plans(exit).some((service: any) => service.name === `fwx-reverse-exit-${gostTunnelId}-health` && service.listener.type === "rtcp"));
  assert.equal((await admin.getById({ id: gostTunnelId }) as any).reverseKeyPem, undefined);
  const probe = entry.tunnelProbes.find((item: any) => item.tunnelId === gostTunnelId);
  const state = (await import("./reverseTunnelStatus")).getReverseTunnelConnectionStatus;
  const tunnel = await db.getTunnelById(gostTunnelId);
  const report = (method: string) => agentPost(11, "tcping", { tunnels: [{
    tunnelId: gostTunnelId, method, targetPort: probe.targetPort, probeKey: probe.probeKey, topologyKey: probe.topologyKey, latencyMs: 5,
  }] });
  await report("tcp");
  assert.equal(state(tunnel), "waiting");
  await report("gost-reverse");
  assert.equal(state(tunnel), "connected");

  await runtime.executeRaw('UPDATE "hosts" SET "portRangeEnd" = 23010 WHERE "id" = 11');
  const rules = (await import("./routers/rules.crud")).crudRulesRouter.createCaller(context(1, "admin"));
  const rule = await rules.create({
    name: "reverse business", hostId: 11, tunnelId: gostTunnelId,
    forwardType: "gost", protocol: "both", sourcePort: 23005, targetIp: "192.0.2.90", targetPort: 1337,
  });
  assert.equal((await db.getForwardRuleById(rule.id))?.tunnelExitPort, null);
  const updatedExit = await heartbeat(22);
  const exitServices = plans(updatedExit);
  for (const [protocol, listener] of [["tcp", "rtcp"], ["udp", "rudp"]]) {
    const service = exitServices.find((item: any) => item.name === `fwx-reverse-exit-${gostTunnelId}-rule-${rule.id}-${protocol}`);
    assert.ok(service);
    assert.equal(service.listener.type, listener);
    assert.equal(service.forwarder.nodes[0].addr, "192.0.2.90:1337");
  }
  const updatedEntry = await heartbeat(11);
  const business = plans(updatedEntry).find((item: any) => item.name === `fwx-${rule.id}-tcp`);
  assert.ok(business);
  assert.equal(business.metadata.enableStats, true);
  assert.equal(business.addr, ":23005");

  await admin.update({ id: gostTunnelId, isEnabled: false });
  const disabledExit = await heartbeat(22, [{ name: "forwardx-runtime", active: true, hasWork: true }]);
  assert.ok(config(disabledExit).some((item: any) => item.serviceName === "forwardx-runtime"));
  assert.equal(plans(disabledExit).some((item: any) => item.name.startsWith(`fwx-reverse-exit-${gostTunnelId}-`)), false);
});
