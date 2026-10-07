import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";
import { agentTokenFingerprint, decryptPayload, encryptPayload, signAgentChallengeAuthProof } from "./agentCrypto";
import { createMigrationCode, createMigrationRequest, approveMigrationRequest, consumeApprovedMigrationRequest } from "./migrationCodes";

test("migration approval binds seamless mode, not just the code and URL", () => {
  const code = createMigrationCode().code;
  const plain = createMigrationRequest(code, "https://new.example.com", { seamless: false })!;
  const seamless = createMigrationRequest(code, "https://new.example.com", { seamless: true })!;
  assert.notEqual(plain.id, seamless.id);
  approveMigrationRequest(seamless.id);
  assert.equal(consumeApprovedMigrationRequest(seamless.id, code, seamless.targetPanelUrl)?.seamless, true);
});

function isolated(script: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fwx-seamless-unit-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 25_000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", SQLITE_PATH: path.join(directory, "panel.db"), DATABASE_CONFIG_PATH: path.join(directory, "database.json"), FORWARDX_SEAMLESS_MIGRATION_STATE_PATH: path.join(directory, "migration.json"), JWT_SECRET: "seamless-test-secret-do-not-use-in-production" } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ""}`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("freeze drains admitted work, rejects later writes, and never expires committed ownership", () => isolated(String.raw`
  import assert from 'node:assert/strict';
  import * as s from './server/seamlessMigrationState.ts';
  const initial = {version:1,id:'fixture',role:'source',phase:'frozen',sourceUrl:'http://old.test',targetUrl:'http://new.test',tokenHash:'a'.repeat(64),startedAt:1,expiresAt:100};
  let release;
  const pending = s.seamlessActivity(async () => { await new Promise(r=>release=r); s.assertSeamlessDatabaseWrite('UPDATE users SET id=1'); });
  s.persistSeamlessMigrationState(initial);
  assert.throws(()=>s.assertSeamlessDatabaseWrite('UPDATE users SET id=2'), /保留数据/);
  assert.throws(()=>s.assertSeamlessDatabaseWrite('WITH x AS (SELECT 1) DELETE FROM users'), /保留数据/);
  let drained=false; const drain=s.drainSeamlessActivities().then(()=>drained=true);
  await new Promise(r=>setTimeout(r,25)); assert.equal(drained,false);
  release(); await pending; await drain; assert.equal(drained,true);
  s.persistSeamlessMigrationState({...initial,phase:'forwarding'});
  assert.equal(s.expireSeamlessFreeze(101),false);
  assert.throws(()=>s.assertSeamlessDatabaseWrite('BEGIN'), /保留数据/);
  s.persistSeamlessMigrationState({...initial,phase:'archived'});
  assert.equal(s.expireSeamlessFreeze(101),false);
  s.persistSeamlessMigrationState(initial);
  assert.equal(s.expireSeamlessFreeze(101),true);
  s.assertSeamlessDatabaseWrite('UPDATE users SET id=1');
  process.exit(0);
`));

test("exact-ID import rolls back entirely on an invalid row and preserves runtime fields", () => isolated(String.raw`
  import assert from 'node:assert/strict';
  import * as r from './server/dbRuntime.ts';
  import {ensureDatabaseSchema,MIGRATION_TABLES} from './server/dbSchema.ts';
  import {importSeamlessSnapshot} from './server/seamlessMigrationImport.ts';
  await r.connectDatabase({type:'sqlite',sqlite:{path:process.env.SQLITE_PATH}}); await ensureDatabaseSchema();
  const before=await r.queryRaw('SELECT * FROM system_settings');
  const base={version:1,exportedAt:Date.now(),tables:{users:[{id:3,username:'admin',role:'admin',password:'fixture'}],forward_rules:[{id:101,userId:3,hostId:7,name:'fixture',sourcePort:18001,targetIp:'127.0.0.1',targetPort:18002,forwardType:'realm',isRunning:1,isEnabled:1}]}};
  const bad=structuredClone(base); bad.tables.forward_rules.push({...bad.tables.forward_rules[0]});
  await assert.rejects(()=>importSeamlessSnapshot(bad,'http://new.test'), /整个事务已回滚/);
  assert.deepEqual(await r.queryRaw('SELECT * FROM users'),[]);
  assert.deepEqual(await r.queryRaw('SELECT * FROM system_settings'),before);
  await importSeamlessSnapshot(base,'http://new.test');
  const rules=await r.queryRaw('SELECT * FROM forward_rules');
  assert.equal(rules[0].id,101); assert.equal(rules[0].isRunning,1); assert.equal(rules[0].sourcePort,18001);
  await assert.rejects(()=>importSeamlessSnapshot(base,'http://new.test'), /空业务目标/);
  await r.closeDatabase(); process.exit(0);
`));

async function fixture(directory: string, host: string, port = 0) {
  let logs = "", counter = 0;
  const child = spawn(process.execPath, ["--import", "tsx", "server/seamlessMigration.fixture.ts"], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, SQLITE_PATH: path.join(directory, "panel.db"), DATABASE_TYPE: "sqlite",
      DATABASE_CONFIG_PATH: path.join(directory, "database.json"), FORWARDX_SEAMLESS_MIGRATION_STATE_PATH: path.join(directory, "migration.json"),
      FORWARDX_TEST_PORT: String(port), FORWARDX_TEST_HOST: host, FORWARDX_DEV_PANEL: "true", JWT_SECRET: "seamless-test-secret-do-not-use-in-production" },
  });
  child.stdout!.on("data", (data) => logs += data);
  child.stderr!.on("data", (data) => logs += data);
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${logs}`)), 20_000);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
    child.on("message", (message: any) => { if (message.ready) { clearTimeout(timer); resolve(message.ready); } });
  });
  const call = (op: string, values: object = {}) => new Promise<any>((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => { child.off("message", listener); reject(new Error(`Fixture ${op} timed out: ${logs}`)); }, 10_000);
    const listener = (message: any) => { if (message.id !== id) return; clearTimeout(timer); child.off("message", listener); message.error ? reject(new Error(message.error)) : resolve(message.result); };
    child.on("message", listener);
    child.send({ id, op, ...values });
  });
  return { child, url, call };
}

async function stop(child: ChildProcess) { const exited = once(child, "exit"); child.kill(); await exited; }

async function reportRuntime(sourceUrl: string) {
  const token = "migration-test-agent-token";
  const challenge = (await (await fetch(`${sourceUrl}/api/agent/auth-challenge?count=1`)).json()).challenges[0];
  const bodyText = JSON.stringify(encryptPayload({ localState: { rules: [{ ruleId: 101, port: 18001, forwardType: "realm", ready: true }], tunnels: [], services: [] } }, token));
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const signature = signAgentChallengeAuthProof({ token, method: "POST", path: "/api/agent/heartbeat", bodyText, challenge, nonce });
  const response = await fetch(`${sourceUrl}/api/agent/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer v2.${agentTokenFingerprint(token)}.${challenge}.${nonce}.${signature}` }, body: bodyText });
  assert.equal(response.status, 200);
  const payload = decryptPayload(await response.json(), token);
  assert.equal(payload.reconciliationCoalesced, true);
  assert.deepEqual(payload.actions, []);
}

test("complete online migration goes through real approval, export, import and runtime verification", { timeout: 40_000 }, async (t) => {
  const host = Object.values(os.networkInterfaces()).flat().find((nic) => nic && !nic.internal && nic.family === "IPv4")?.address;
  if (!host) { t.skip("No local non-loopback IPv4 interface"); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fwx-seamless-workflow-"));
  const children: ChildProcess[] = [];
  try {
    fs.mkdirSync(path.join(directory, "source")); fs.mkdirSync(path.join(directory, "target"));
    const source = await fixture(path.join(directory, "source"), host); children.push(source.child);
    const target = await fixture(path.join(directory, "target"), host); children.push(target.child);
    await source.call("seed");
    const code = await source.call("code");
    const job = await target.call("start", { sourceUrl: source.url, code: code.code });
    let pending: any;
    for (let count = 0; count < 60; count++) {
      pending = await source.call("pending");
      if (pending) break;
      const current = await target.call("job", { jobId: job.id });
      assert.notEqual(current.status, "failed", current.error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(pending?.seamless, true);
    await source.call("approve", { requestId: pending.id });
    let forwarded = false;
    for (let count = 0; count < 80; count++) {
      const current = await target.call("job", { jobId: job.id });
      assert.notEqual(current.status, "failed", current.error);
      if ((await source.call("status"))?.phase === "forwarding") { forwarded = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(forwarded, true);
    await reportRuntime(source.url);
    let completed: any;
    for (let count = 0; count < 60; count++) {
      completed = await target.call("job", { jobId: job.id });
      if (completed.status === "success" || completed.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(completed.status, "success", completed.error);
    assert.equal((await source.call("status")).phase, "archived");
    assert.equal((await target.call("query", { sql: "SELECT id,isRunning,sourcePort FROM forward_rules" }))[0].id, 101);
    assert.equal(await target.call("advertised"), source.url);
  } finally { await Promise.all(children.map(stop)); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("two panels preserve signed ingress, SSE and a live TCP connection; restart keeps source read-only", { timeout: 60_000 }, async (t) => {
  // Keep production SSRF protections intact: use an actual local NIC, not a
  // test-only bypass allowing outbound requests to localhost / metadata.
  const host = Object.values(os.networkInterfaces()).flat().find((nic) => nic && !nic.internal && nic.family === "IPv4")?.address;
  if (!host) { t.skip("No local non-loopback IPv4 interface"); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fwx-seamless-e2e-"));
  const children: ChildProcess[] = [];
  const echo = net.createServer((socket) => socket.pipe(socket));
  echo.listen(0, "127.0.0.1"); await once(echo, "listening");
  const connection = net.connect((echo.address() as net.AddressInfo).port, "127.0.0.1"); await once(connection, "connect");
  const exchange = async () => { const received = once(connection, "data"); connection.write("still-open"); assert.equal(String((await received)[0]), "still-open"); };
  const token = "migration-test-agent-token", takeoverToken = "fixture-private-takeover-token";
  try {
    const sourceDir = path.join(directory, "source"), targetDir = path.join(directory, "target");
    fs.mkdirSync(sourceDir); fs.mkdirSync(targetDir);
    let source = await fixture(sourceDir, host); children.push(source.child);
    let target = await fixture(targetDir, host); children.push(target.child);
    await source.call("seed");
    await exchange();
    const snapshot = await source.call("freeze", { token: takeoverToken, targetUrl: target.url });
    assert.equal(snapshot.tables.forward_rules[0].isRunning, 1);
    assert.equal((await fetch(`${source.url}/api/trpc/rules.create`, { method: "POST" })).status, 503);
    await target.call("import", { snapshot, sourceUrl: source.url });
    assert.equal((await fetch(`${target.url}/api/agent/auth-challenge`)).status, 503, "no direct target reporting before activation");
    const postControl = async (action: string) => fetch(`${source.url}/api/migration/seamless-${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: snapshot.seamless.id, takeoverToken, targetPanelUrl: target.url }) });
    const activation = await postControl("activate");
    assert.equal(activation.status, 200, await activation.text());
    assert.equal((await postControl("abort")).status, 409, "never reactivate an old accounting snapshot after activation");
    const raw = ' { "raw" : "byte-for-byte" }\n';
    const rawResponse = await fetch(`${source.url}/api/agent/raw-test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
    assert.equal(await rawResponse.text(), raw);
    const challengeResponse = await fetch(`${source.url}/api/agent/auth-challenge?count=1`);
    const challengeBody = await challengeResponse.json();
    const challenge = challengeBody.challenges[0];
    const bodyText = JSON.stringify(encryptPayload({ localState: { rules: [{ ruleId: 101, port: 18001, forwardType: "realm", ready: true }], tunnels: [], services: [] } }, token));
    const nonce = "00112233445566778899aabbccddeeff";
    const signature = signAgentChallengeAuthProof({ token, method: "POST", path: "/api/agent/heartbeat", bodyText, challenge, nonce });
    const heartbeat = await fetch(`${source.url}/api/agent/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer v2.${agentTokenFingerprint(token)}.${challenge}.${nonce}.${signature}` }, body: bodyText });
    assert.equal(heartbeat.status, 200, JSON.stringify(await heartbeat.clone().json()));
    const payload = decryptPayload(await heartbeat.json(), token);
    assert.equal(payload.reconciliationCoalesced, true); assert.deepEqual(payload.actions, []); assert.equal(payload.desiredState, undefined);
    assert.equal(await target.call("advertised"), source.url);
    const streamEnvelope = encryptPayload({ agentVersion: "2.2.194" }, token);
    const abortStream = new AbortController();
    const stream = await fetch(`${source.url}/api/stream?e=${encodeURIComponent(JSON.stringify(streamEnvelope))}`, { signal: abortStream.signal });
    assert.equal(stream.status, 200);
    const firstFrame = await stream.body!.getReader().read();
    const frame = Buffer.from(firstFrame.value!).toString();
    assert.match(frame, /event: message/);
    assert.equal(decryptPayload(JSON.parse(frame.split("data: ")[1].trim()), token).type, "ready");
    abortStream.abort();
    await exchange(); assert.equal(connection.destroyed, false);
    // Simulate a crash after DB commit but before the sidecar imported flag.
    await target.call("forget-imported");
    const recover = await (await fetch(`${target.url}/api/migration/seamless-status`)).json();
    assert.equal(recover.state.imported, true); assert.equal(JSON.stringify(recover).includes(takeoverToken), false);
    assert.equal((await fetch(`${source.url}/api/payment/webhook/test`, { method: "POST", body: "signed-payment-fixture" })).status, 200);
    assert.deepEqual(await source.call("query", { sql: "SELECT value FROM system_settings WHERE key='test-callback'" }), []);
    assert.equal((await target.call("query", { sql: "SELECT value FROM system_settings WHERE key='test-callback'" }))[0].value, "target-only");
    const sourceUrl = source.url;
    await stop(source.child); children.splice(children.indexOf(source.child), 1);
    source = await fixture(sourceDir, host, Number(new URL(sourceUrl).port)); children.push(source.child);
    assert.equal((await source.call("status")).phase, "forwarding");
    await assert.rejects(() => source.call("write", { sql: "UPDATE forward_rules SET isRunning=0" }), /保留数据/);
    assert.equal((await source.call("query", { sql: "SELECT id,isRunning FROM forward_rules" }))[0].isRunning, 1);
    assert.equal((await fetch(`${source.url}/api/agent/auth-challenge`)).status, 200);
    await exchange();
    const complete = await target.call("resume"); assert.equal(complete.status, "success");
    assert.equal((await source.call("status")).phase, "archived");
    assert.equal((await target.call("status")).phase, "active");
    assert.equal(await target.call("advertised"), sourceUrl);
    await exchange(); assert.equal(connection.destroyed, false);
  } finally {
    connection.destroy(); echo.close();
    await Promise.all(children.map(stop));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
