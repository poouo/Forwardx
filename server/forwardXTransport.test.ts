import assert from "node:assert/strict";
import test from "node:test";
import {
  applyForwardXTransport,
  expectedForwardXTransportVersion,
  forwardXV3SpecOptions,
  forwardXTransportVersionForTunnel,
  localForwardXTransportCompatible,
  normalizeForwardXV3Multiplex,
  normalizeForwardXV3Transport,
} from "./forwardXTransport";

const v3Tunnel = {
  id: 41,
  mode: "forwardx",
  forwardxVersion: "v3",
  v3Transport: "ws",
  v3Host: "outer.example",
  v3Path: "/stream",
  v3UserAgent: "Mozilla/5.0",
  v3ServerName: null,
  v3Multiplex: true,
};

test("V3 transport names are validated and unknown values are rejected", () => {
  for (const transport of ["http", "ws", "tls"] as const) {
    assert.equal(normalizeForwardXV3Transport(transport), transport);
  }
  assert.equal(normalizeForwardXV3Transport(" WS "), "ws");
  assert.equal(normalizeForwardXV3Transport("wss"), undefined);
  assert.equal(normalizeForwardXV3Transport(""), undefined);
  assert.equal(normalizeForwardXV3Transport(null), undefined);
});

test("V3 multiplex normalises every database boolean representation", () => {
  assert.equal(normalizeForwardXV3Multiplex(true), true);
  assert.equal(normalizeForwardXV3Multiplex(1), true);
  assert.equal(normalizeForwardXV3Multiplex("1"), true);
  assert.equal(normalizeForwardXV3Multiplex("true"), true);
  assert.equal(normalizeForwardXV3Multiplex(false), false);
  assert.equal(normalizeForwardXV3Multiplex(0), false);
  assert.equal(normalizeForwardXV3Multiplex("0"), false);
  assert.equal(normalizeForwardXV3Multiplex(null), undefined);
  assert.equal(normalizeForwardXV3Multiplex(undefined), undefined);
  assert.equal(normalizeForwardXV3Multiplex(""), undefined);
});

test("applyForwardXTransport emits V3 with every configured option", async () => {
  const spec = await applyForwardXTransport({ role: "entry", tunnelId: 41, ruleId: 7 }, v3Tunnel, async () => null);
  assert.deepEqual(spec, {
    role: "entry",
    tunnelId: 41,
    ruleId: 7,
    transportVersion: "v3",
    v3Transport: "ws",
    v3Host: "outer.example",
    v3Path: "/stream",
    v3UserAgent: "Mozilla/5.0",
    v3Multiplex: true,
  });
});

test("applyForwardXTransport omits empty V3 options and never invents a version", async () => {
  const spec = await applyForwardXTransport({ role: "exit" }, {
    mode: "forwardx",
    forwardxVersion: "v3",
    v3Transport: "tls",
    v3Host: "",
    v3Path: null,
    v3UserAgent: undefined,
    v3ServerName: "edge.example",
    v3Multiplex: null,
  }, async () => null);
  assert.deepEqual(spec, {
    role: "exit",
    transportVersion: "v3",
    v3Transport: "tls",
    v3ServerName: "edge.example",
  });
});

test("a V3 tunnel without a usable transport is skipped instead of downgraded to V1", async () => {
  for (const v3Transport of [undefined, null, "", "wss", "v4"]) {
    const spec = await applyForwardXTransport({ role: "entry" }, {
      mode: "forwardx",
      forwardxVersion: "v3",
      v3Transport,
      v3Host: "outer.example",
    }, async () => null);
    assert.equal(spec, null);
  }
});

test("V1 and V2 transport handling stays unchanged", async () => {
  const v1Spec = await applyForwardXTransport({ role: "entry" }, { mode: "forwardx", forwardxVersion: "v1" }, async () => {
    throw new Error("V1 must not resolve a WireGuard plan");
  });
  assert.deepEqual(v1Spec, { role: "entry", transportVersion: "v1" });

  const v2Spec = await applyForwardXTransport({ role: "entry" }, { mode: "forwardx", forwardxVersion: "v2" }, async () => ({ hostId: 1 }));
  assert.deepEqual(v2Spec, { role: "entry", transportVersion: "v2" });

  const missingPlan = await applyForwardXTransport({ role: "entry" }, { mode: "forwardx", forwardxVersion: "v2" }, async () => null);
  assert.equal(missingPlan, null);
});

test("V3 options are only read from the tunnel row and stay consistent per tunnel", () => {
  const first = forwardXV3SpecOptions(v3Tunnel);
  const second = forwardXV3SpecOptions({ ...v3Tunnel, id: 42 });
  assert.deepEqual(first, second);
  assert.equal(forwardXV3SpecOptions({ mode: "forwardx", forwardxVersion: "v3" }), null);
  assert.equal(forwardXV3SpecOptions({ mode: "forwardx", forwardxVersion: "v1", v3Transport: "ws" }), null);
  assert.equal(forwardXV3SpecOptions({ mode: "forwardx", forwardxVersion: "v2", v3Transport: "ws" }), null);
  assert.equal(forwardXV3SpecOptions({ mode: "tls", forwardxVersion: "v3", v3Transport: "ws" }), null);
});

test("tunnel transport version picks V3, V2 and V1 in that order", () => {
  assert.equal(forwardXTransportVersionForTunnel({ mode: "forwardx", forwardxVersion: "v3" }), "v3");
  assert.equal(forwardXTransportVersionForTunnel({ mode: "forwardx", forwardxVersion: "v2" }), "v2");
  assert.equal(forwardXTransportVersionForTunnel({ mode: "forwardx", forwardxVersion: "v1" }), "v1");
  assert.equal(forwardXTransportVersionForTunnel({ mode: "forwardx" }), "v1");
  assert.equal(forwardXTransportVersionForTunnel({ mode: "tls", forwardxVersion: "v3" }), "v1");
});

test("a running V3 runtime is not considered drifted", () => {
  const expected = expectedForwardXTransportVersion({
    tunnelId: 41,
    expectedForwardType: "forwardx",
    tunnel: v3Tunnel,
  });
  assert.equal(expected, "v3");
  assert.equal(localForwardXTransportCompatible({ transportVersion: "v3" }, expected), true);
  assert.equal(localForwardXTransportCompatible({ transportVersion: "v2" }, expected), false);
  assert.equal(localForwardXTransportCompatible({ transportVersion: "v1" }, expected), false);
  assert.equal(localForwardXTransportCompatible({}, expected), false);

  const tunnelExpected = expectedForwardXTransportVersion({
    tunnelId: 41,
    expectedForwardType: "forwardx-tunnel",
    tunnel: v3Tunnel,
  });
  assert.equal(tunnelExpected, "v3");
  assert.equal(localForwardXTransportCompatible({ transportVersion: "v3" }, tunnelExpected), true);
});

test("V2 and V1 expectations still reject a V3 runtime", () => {
  const v2Expected = expectedForwardXTransportVersion({
    tunnelId: 42,
    expectedForwardType: "forwardx",
    tunnel: { mode: "forwardx", forwardxVersion: "v2" },
  });
  assert.equal(v2Expected, "v2");
  assert.equal(localForwardXTransportCompatible({ transportVersion: "v2" }, v2Expected), true);
  assert.equal(localForwardXTransportCompatible({ transportVersion: "v3" }, v2Expected), false);
  assert.equal(localForwardXTransportCompatible({ transportVersion: "v1" }, v2Expected), false);

  const v1Expected = expectedForwardXTransportVersion({
    tunnelId: 43,
    expectedForwardType: "forwardx",
    tunnel: { mode: "forwardx", forwardxVersion: "v1" },
  });
  assert.equal(v1Expected, "v1");
  assert.equal(localForwardXTransportCompatible({ transportVersion: "v1" }, v1Expected), true);
  // Older Agents may omit the field entirely; a clearly newer runtime may not.
  assert.equal(localForwardXTransportCompatible({}, v1Expected), true);
  assert.equal(localForwardXTransportCompatible({ transportVersion: "v2" }, v1Expected), false);
  assert.equal(localForwardXTransportCompatible({ transportVersion: "v3" }, v1Expected), false);
});

test("non-ForwardX expectations stay undefined", () => {
  assert.equal(expectedForwardXTransportVersion({
    tunnelId: 44,
    expectedForwardType: "gost",
    tunnel: v3Tunnel,
  }), undefined);
  assert.equal(expectedForwardXTransportVersion({
    tunnelId: 45,
    expectedForwardType: "forwardx",
    tunnel: { mode: "tls", forwardxVersion: "v3" },
  }), undefined);
  assert.equal(localForwardXTransportCompatible({ transportVersion: "v1" }, undefined), true);
});
