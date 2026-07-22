import assert from "node:assert/strict";
import test from "node:test";
import { buildCountingChainCmds, buildNftForwardCmds } from "./agentActionCommands";

test("nft rule comments keep nft string quotes after shell parsing", () => {
  const commands = buildNftForwardCmds({
    id: 42,
    sourcePort: 22222,
    targetIp: "203.0.113.10",
    targetPort: 443,
    protocol: "both",
  }).join("\n");

  assert.match(commands, /comment '\"fwx-rule-42-in\"'/);
  assert.match(commands, /comment '\"fwx-rule-42-out\"'/);
  assert.match(commands, /comment '\"fwx-rule-42\"'/);
  assert.doesNotMatch(commands, /comment \"fwx-rule-42-(?:in|out)\"/);
  assert.doesNotMatch(commands, /fwx-rule-42:(?:in|out)/);
});

test("all process forwarding modes use the shared bidirectional counters", () => {
  const commands = buildCountingChainCmds(22022, "target.example", 443, "both").join("\n");

  assert.match(commands, /fwx-stat-22022:in/);
  assert.match(commands, /fwx-stat-22022:out/);
  assert.match(commands, /PREROUTING -p tcp --dport 22022/);
  assert.match(commands, /INPUT -p tcp --dport 22022/);
  assert.match(commands, /OUTPUT -p tcp --sport 22022/);
  assert.match(commands, /POSTROUTING -p tcp --sport 22022/);
  assert.match(commands, /PREROUTING -p udp --dport 22022/);
  assert.match(commands, /OUTPUT -p udp --sport 22022/);
  assert.doesNotMatch(commands, /target\.example/);
});
