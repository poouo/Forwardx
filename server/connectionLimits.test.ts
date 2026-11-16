import assert from "node:assert/strict";
import test from "node:test";
import { connectionLimitAction, connectionLimitSpecs } from "./connectionLimits";

test("connection quota covers tunnel, chain and ordinary entry ports across protocols", () => {
  const rules = [
    { userId: 1, sourcePort: 20000, forwardType: "iptables", protocol: "both" },
    { userId: 1, sourcePort: 20001, forwardType: "gost", tunnelId: 2, protocol: "tcp" },
    { userId: 1, sourcePort: 20002, forwardType: "nginx", forwardGroupId: 3, protocol: "udp" },
    { userId: 1, sourcePort: 20000, protocol: "both" },
    { userId: 2, sourcePort: 20003, protocol: "both" },
    { userId: 1, sourcePort: 65536, protocol: "tcp" },
  ];
  const limits = (id: number) => ({ maxConnections: id === 1 ? 16 : 0 });
  const expected = [{ userId: 1, maxConnections: 16, tcpPorts: [20000, 20001], udpPorts: [20000, 20002] }];
  assert.deepEqual(connectionLimitSpecs(rules, limits), expected);
  assert.deepEqual(connectionLimitSpecs([...rules].reverse(), limits), expected);
});

test("quota removal is explicit and unsupported Agents report failure", () => {
  assert.equal(connectionLimitAction([], false), null);
  assert.deepEqual(connectionLimitAction([], true)?.connectionLimits, []);
  const specs = [{ userId: 1, maxConnections: 16, tcpPorts: [20000], udpPorts: [] }];
  assert.deepEqual(connectionLimitAction(specs, true)?.commands, []);
  assert.match(connectionLimitAction(specs, false)!.commands.join("\n"), /连接数限制未生效.*exit 1/);
});
