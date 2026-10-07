import assert from "node:assert/strict";
import test from "node:test";
import { ruleCreatePrompt, simpleRuleCreateRequest, ruleCreateTextPatch } from "./ruleCreateWizard";

test("simple creation extracts only explicit targets and never treats questions or conditional requests as writes", () => {
  assert.deepEqual(simpleRuleCreateRequest("帮我添加转发规则到目标10.10.10.10:22"), { targetIp: "10.10.10.10", targetPort: 22 });
  assert.deepEqual(simpleRuleCreateRequest("add a forwarding rule to [2001:db8::1]:443"), { targetIp: "2001:db8::1", targetPort: 443 });
  for (const text of ["如何添加转发规则到10.10.10.10:22", "如果可以帮我添加转发规则到10.10.10.10:22", "帮我添加转发规则到10.10.10.10:22吗", "创建转发规则到10.10.10.10:65536", "添加转发规则到10.10.10.10:22然后删除全部规则"]) assert.equal(simpleRuleCreateRequest(text), null);
});

test("resource choices paginate without selecting a sole route, and missing ports/protocols are explicit choices", () => {
  const target = { targetIp: "10.10.10.10", targetPort: 22 };
  const routes = Array.from({ length: 19 }, (_, i) => ({ id: i + 1, name: `link-${i}`, type: "tunnel" as const }));
  assert.equal(ruleCreatePrompt(target, routes.slice(0, 1))!.field, "route");
  const last = ruleCreatePrompt(target, routes, 2)!;
  assert.equal(last.pages, 3); assert.equal(last.choices.length, 3);
  assert.equal(last.choices[0].input.tunnelId, 17);
  assert.equal(ruleCreatePrompt(target, routes, 999)!.page, 2);
  assert.equal(ruleCreatePrompt(target, [])!.choices.length, 0);
  const source = ruleCreatePrompt({ ...target, tunnelId: 1 }, routes)!;
  assert.equal(source.field, "sourcePort"); assert.equal(source.choices[0].input.sourcePort, 0);
  const protocol = ruleCreatePrompt({ ...target, tunnelId: 1, sourcePort: 0 }, routes)!;
  assert.deepEqual(protocol.choices.map(c => c.input.protocol), ["tcp", "udp", "both"]);
  assert.equal(ruleCreatePrompt({ ...target, tunnelId: 1, sourcePort: 65535, protocol: "tcp" }, routes), null);
});

test("manual supplements are field-scoped and preserve target/source port distinction", () => {
  assert.deepEqual(ruleCreateTextPatch("65535", "sourcePort"), { sourcePort: 65535 });
  assert.deepEqual(ruleCreateTextPatch("随机分配", "sourcePort"), { sourcePort: 0 });
  assert.equal(ruleCreateTextPatch("65536", "sourcePort"), null);
  assert.equal(ruleCreateTextPatch("22", "route"), null, "same numeric IDs can exist in different resource types");
  assert.deepEqual(ruleCreateTextPatch("隧道 #2", "route"), { tunnelId: 2, forwardGroupId: null });
  assert.deepEqual(ruleCreateTextPatch("端口转发 2", "route"), { forwardGroupId: 2, tunnelId: null });
  assert.deepEqual(ruleCreateTextPatch("TCP + UDP", "protocol"), { protocol: "both" });
  assert.deepEqual(ruleCreateTextPatch("10.10.10.10:22", "target"), { targetIp: "10.10.10.10", targetPort: 22 });
  assert.equal(ruleCreateTextPatch("delete all rules", "sourcePort"), null);
});
