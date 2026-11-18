import assert from "node:assert/strict";
import test from "node:test";
import { agentActionEpochKey, reconcileAgentActionEpochs } from "./agentActionEpochs";

test("unchanged pending actions retain their epoch when other listeners finish or join", () => {
  const first = reconcileAgentActionEpochs(new Map(), new Map([["port:1001", "rev1:slow"], ["port:1002", "rev1:fast"]]), 100);
  const next = reconcileAgentActionEpochs(first, new Map([["port:1001", "rev1:slow"], ["runtime:nginx", "rev1:sync"]]), 200);
  assert.equal(next.get("port:1001")!.issuedAt, 100);
  assert.equal(next.has("port:1002"), false);
  assert.equal(next.get("runtime:nginx")!.issuedAt, 200);
  const repeated = reconcileAgentActionEpochs(next, new Map([["port:1001", "rev1:slow"]]), 300);
  assert.equal(repeated.get("port:1001")!.issuedAt, 100);
});

test("a real change or reappearance gets a new epoch, including the same millisecond", () => {
  const first = reconcileAgentActionEpochs(new Map(), new Map([["port:1001", "rev1:old"]]), 100);
  const changed = reconcileAgentActionEpochs(first, new Map([["port:1001", "rev2:new"]]), 100);
  assert.equal(changed.get("port:1001")!.issuedAt, 101);
  const empty = reconcileAgentActionEpochs(changed, new Map(), 200);
  const recovered = reconcileAgentActionEpochs(empty, new Map([["port:1001", "rev2:new"]]), 300);
  assert.equal(recovered.get("port:1001")!.issuedAt, 300);
});

test("old/new engines and overlapping protocols on a port share a handoff epoch", () => {
  const old = { sourcePort: 1001, statusType: "rule", ruleId: 1, op: "remove", forwardType: "gost", protocol: "tcp" };
  const next = { ...old, ruleId: 2, op: "apply", forwardType: "nginx", protocol: "both" };
  assert.equal(agentActionEpochKey(old), agentActionEpochKey(next));
  assert.notEqual(agentActionEpochKey(old), agentActionEpochKey({ ...next, sourcePort: 1002 }));
  assert.notEqual(agentActionEpochKey({ statusType: "runtime", forwardType: "nginx-runtime-sync" }), agentActionEpochKey({ statusType: "runtime", forwardType: "gost-runtime-sync" }));
  assert.notEqual(agentActionEpochKey({ statusType: "runtime", forwardType: "forwardx-wireguard", tunnelId: 1 }), agentActionEpochKey({ statusType: "runtime", forwardType: "forwardx-wireguard", tunnelId: 2 }));
});
