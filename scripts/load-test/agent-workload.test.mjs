import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { agentScenarios, rulesForHost, runtimeStateForRules, serviceDefinitions, serviceResult, encryptedAgentRequest, decryptedAgentResponse } from "./agent-workload.mjs";

test("fixture rule IDs are disjoint and listener ports stay valid", () => {
  for (const fixture of Object.values(agentScenarios)) {
    const ids = new Set();
    for (let host = 1; host <= fixture.hosts; host++) {
      const rows = rulesForHost(host, fixture.rulesPerHost);
      assert.equal(new Set(rows.map(row => row.port)).size, fixture.rulesPerHost);
      for (const row of rows) { assert.ok(row.port > 0 && row.port <= 65535); ids.add(row.id); }
    }
    assert.equal(ids.size, fixture.hosts * fixture.rulesPerHost);
  }
});

test("fixture includes TCP, ICMP and correctly keyed URL service reports", () => {
  const definitions = serviceDefinitions();
  assert.deepEqual(new Set(definitions.map(row => row.method)), new Set(["tcping", "ping", "url"]));
  for (const definition of definitions) {
    const healthy = serviceResult(definition, 1, 0);
    assert.equal(healthy.probeSuccesses, 3);
    const failed = serviceResult(definition, 17 - definition.serviceId, 0, true);
    assert.equal(failed.isTimeout, true);
    assert.equal(failed.probeSuccesses, 0);
    if (definition.method === "url") assert.match(healthy.probeKey, /^service:\d+:url:[a-f0-9]{64}$/);
  }
});

test("runtime-state signature passes the real Agent hex contract", () => {
  const rules = rulesForHost(2, 30), state = runtimeStateForRules(rules);
  assert.match(state.signature, /^[a-f0-9]{64}$/);
  assert.equal(state.signature, runtimeStateForRules(rules).signature);
  assert.notEqual(state.signature, runtimeStateForRules(rules.slice(1)).signature);
  assert.ok(state.value.rules.every(rule => rule.ruleId === rule.id && rule.ready));
});

test("encrypted fixture uses independent nonce/IV and path-bound proof", () => {
  const token = "test-only-token", route = "/api/agent/traffic", payload = { stats: [{ ruleId: 1, bytesIn: 42 }] };
  const first = encryptedAgentRequest(token, route, payload), second = encryptedAgentRequest(token, route, payload);
  const envelope = JSON.parse(first.body);
  assert.notEqual(envelope.iv, JSON.parse(second.body).iv);
  assert.notEqual(first.authorization, second.authorization);
  assert.deepEqual(decryptedAgentResponse(token, envelope), payload);
  assert.throws(() => decryptedAgentResponse("different-token", envelope), /MAC/);
  assert.throws(() => decryptedAgentResponse(token, { ...envelope, ts: envelope.ts + 1 }), /MAC/);
  const [version, fingerprint, ts, nonce, signature] = first.authorization.slice(7).split(".");
  assert.equal(version, "v1"); assert.equal(fingerprint.length, 32);
  const key = crypto.createHash("sha256").update(`${token}|forwardx-agent-auth`).digest();
  const proof = target => crypto.createHmac("sha256", key).update(["v1", "POST", target, ts, nonce, crypto.createHash("sha256").update(first.body).digest("hex")].join("\n")).digest("hex");
  assert.equal(signature, proof(route));
  assert.notEqual(signature, proof("/api/agent/presence"));
});
