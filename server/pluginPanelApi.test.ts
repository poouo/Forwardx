import assert from "node:assert/strict";
import test from "node:test";
import {
  executePluginPanelRequest,
  getPluginPanelOperationCapabilities,
  redactPluginPanelResult,
} from "./pluginPanelApi";

test("plugin panel API exposes a fixed permission-mapped operation registry", () => {
  const capabilities = getPluginPanelOperationCapabilities();
  const users = capabilities.find((item) => item.operation === "users.list");
  const rules = capabilities.find((item) => item.operation === "rules.update");
  const telegram = capabilities.find((item) => item.operation === "telegram.send");

  assert.deepEqual(users, { operation: "users.list", permission: "read:users", intent: "read" });
  assert.deepEqual(rules, { operation: "rules.update", permission: "write:rules", intent: "write" });
  assert.deepEqual(telegram, { operation: "telegram.send", permission: "telegram:send", intent: "execute" });
});

test("plugin panel API recursively removes panel secrets", () => {
  const createdAt = new Date("2026-07-12T00:00:00.000Z");
  const result = redactPluginPanelResult({
    id: 1,
    username: "demo",
    password: "hash",
    twoFactorSecret: "otp",
    nested: {
      agentToken: "agent-token",
      tunnelSecret: "tunnel-secret",
      certKeyPem: "private-key",
      browserSessionToken: "session",
      publicAddress: "example.com",
      createdAt,
    },
    rows: [{ token: "hidden", status: "online" }],
  }) as any;

  assert.equal(result.password, undefined);
  assert.equal(result.twoFactorSecret, undefined);
  assert.equal(result.nested.agentToken, undefined);
  assert.equal(result.nested.tunnelSecret, undefined);
  assert.equal(result.nested.certKeyPem, undefined);
  assert.equal(result.nested.browserSessionToken, undefined);
  assert.equal(result.nested.publicAddress, "example.com");
  assert.equal(result.nested.createdAt, createdAt);
  assert.deepEqual(result.rows, [{ status: "online" }]);
});

test("plugin panel API rejects untrusted and undeclared access before execution", async () => {
  await assert.rejects(
    executePluginPanelRequest({
      plugin: { pluginId: "demo", trusted: false, permissions: ["read:system"] },
      actionId: "summary",
      operation: "system.summary",
    }),
    /尚未设为信任/,
  );

  await assert.rejects(
    executePluginPanelRequest({
      plugin: { pluginId: "demo", trusted: true, permissions: [] },
      actionId: "summary",
      operation: "system.summary",
      context: { user: { id: 1, role: "admin" } } as any,
    }),
    /未声明所需权限 read:system/,
  );
});
