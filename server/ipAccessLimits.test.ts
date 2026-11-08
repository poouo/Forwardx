import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ipAccessLimitAction, ipAccessLimitSpecs } from "./ipAccessLimits";

test("distinct-IP quota covers ordinary and tunnel entry ports across TCP and UDP", () => {
  const rules = [
    { userId: 7, sourcePort: 10000, protocol: "both", forwardType: "realm" },
    { userId: 7, sourcePort: 10001, protocol: "tcp", forwardType: "gost", tunnelId: 1 },
    { userId: 7, sourcePort: 10002, protocol: "udp", forwardType: "iptables" },
    { userId: 7, sourcePort: 10000, protocol: "both" },
    { userId: 8, sourcePort: 20000, protocol: "udp" },
    { userId: 9, sourcePort: 30000, protocol: "both" },
    { userId: 7, sourcePort: 65536, protocol: "tcp" },
  ];
  const limits = (id: number) => ({ maxIPs: id === 9 ? 0 : id === 7 ? 2 : 1 });
  const expected = [
    { userId: 7, maxIPs: 2, tcpPorts: [10000, 10001], udpPorts: [10000, 10002] },
    { userId: 8, maxIPs: 1, tcpPorts: [], udpPorts: [20000] },
  ];
  assert.deepEqual(ipAccessLimitSpecs(rules, limits), expected);
  assert.deepEqual(ipAccessLimitSpecs([...rules].reverse(), limits), expected);
});

test("a separate capability prevents older Agents enforcing the wrong per-IP connection quota", () => {
  const specs = [{ userId: 1, maxIPs: 1, tcpPorts: [10000], udpPorts: [10000] }];
  assert.equal(ipAccessLimitAction([], false), null);
  assert.deepEqual(ipAccessLimitAction([], true)?.ipAccessLimits, []);
  const supported = ipAccessLimitAction(specs, true)!;
  assert.equal(supported.forwardType, "ip-access-limit-sync");
  assert.deepEqual(supported.commands, []);
  assert.equal(supported.knownRunning, true);
  const unsupported = ipAccessLimitAction(specs, false)!;
  assert.equal(unsupported.knownRunning, false);
  assert.match(unsupported.commands.join("\n"), /请升级.*exit 1/);
  assert.doesNotMatch(unsupported.commands.join("\n"), /connlimit|iptables/);
  const heartbeat = readFileSync(new URL("./agentHeartbeatRoute.ts", import.meta.url), "utf8");
  assert.match(heartbeat, /ipAccessLimitsSupported === true/);
  assert.match(heartbeat, /\.\.\.accessLimits,\s*maxIPs: 0/);
  assert.doesNotMatch(heartbeat, /connlimit-above \$\{maxIPs\}/);
});

test("plan/user/store labels and documentation describe IP count, not connections per IP", () => {
  for (const name of ["Plans", "Users"]) {
    const source = readFileSync(new URL(`../client/src/pages/${name}.tsx`, import.meta.url), "utf8");
    assert.match(source, /translateText\("IP 限制"\)/);
    assert.match(source, /同时在线来源 IP 数/);
    assert.doesNotMatch(source, /translateText\("单 IP 接入限制"\)/);
  }
  const docs = readFileSync(new URL("../docs/guide/users-billing.md", import.meta.url), "utf8");
  for (const text of ["5 秒", "512 字节", "不是跨机器", "CAP_NET_ADMIN", "2.2.210", "不能替代身份验证"]) assert.ok(docs.includes(text));
});

test("missing tools and port failures are visible rather than silently disabling save", () => {
  const groups = readFileSync(new URL("../client/src/pages/ForwardGroups.tsx", import.meta.url), "utf8");
  assert.match(groups, /isPortMode && \([\s\S]*?data-testid="port-forward-tool-preflight"/);
  assert.match(groups, /请先在入口主机安装所选工具/);
  assert.doesNotMatch(groups, /disabled=\{[^\n]*toolPreflight/);
  const rules = readFileSync(new URL("../client/src/pages/Rules.tsx", import.meta.url), "utf8");
  assert.match(rules, /data-testid="rule-port-diagnostic"/);
  assert.match(rules, /setPortConfigurationError\(result\.configurationError/);
  assert.match(rules, /latestRandomPortRef\.current !== requestId/);
  assert.match(rules, /setForm\(prev => \(\{ \.\.\.prev, sourcePort: result\.port \}\)\)/);
  assert.match(rules, /rules\.randomPort\.fetch\([^\n]*staleTime: 0/);
});
