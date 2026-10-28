import assert from "node:assert/strict";
import express from "express";
import mysql from "mysql2/promise";
import pg from "pg";
import * as runtime from "./dbRuntime";
// Deliberately import before connecting, as the production router does.
import { createMcpToken, listMcpTokens, resolveMcpToken, revokeMcpToken, hashMcpToken } from "./mcpTokens";
import { mcpHttpRouter } from "./mcpRoutes";

const dialect = process.argv[2];
let restore = () => {};
let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
try {
  if (dialect !== "sqlite") {
    // Exercise actual repository SQL construction without an external database.
    // In MySQL's default SQL mode double-quoted SELECT fields are string literals.
    let selected = "";
    const query = async (input: string | { text: string }) => {
      const sql = typeof input === "string" ? input : input.text;
      selected = sql;
      const rows = sql.includes("VERSION()") ? [{ version: "8.0.36" }] : [];
      return dialect === "mysql" ? [rows, []] : { rows };
    };
    if (dialect === "mysql") {
      const original = mysql.createPool;
      mysql.createPool = (() => ({ getConnection: async () => ({ query, release() {}, destroy() {} }), end: async () => {} })) as unknown as typeof mysql.createPool;
      restore = () => { mysql.createPool = original; };
      await runtime.connectDatabase({ type: "mysql", mysql: { host: "test-no-network", port: 3306, user: "test", password: "", database: "test" } });
    } else {
      const original = pg.Pool.prototype.connect;
      pg.Pool.prototype.connect = (async () => ({ query, release() {} })) as unknown as typeof original;
      restore = () => { pg.Pool.prototype.connect = original; };
      await runtime.connectDatabase({ type: "postgresql", postgresql: { host: "test-no-network", port: 5432, user: "test", password: "", database: "test" } });
    }
    await listMcpTokens(1);
    const quote = dialect === "mysql" ? "`" : '"';
    assert.ok(selected.startsWith(`SELECT ${["id", "name", "prefix", "expiresAt", "createdAt", "lastUsedAt"].map(field => quote + field + quote).join(",")}`), selected);
    assert.doesNotMatch(selected, /tokenHash/);
  } else {
    await runtime.connectDatabase({ type: "sqlite", sqlite: { path: process.env.SQLITE_PATH! } });
    await (await import("./dbSchema")).ensureDatabaseSchema();
    for (const [id, role] of [[1, "admin"], [2, "user"], [3, "admin"]] as const) {
      await runtime.insertAndGetId("users", { id, username: `mcp-user-${id}`, password: "x", role });
    }
    const created = await createMcpToken(1, "My MCP client", 30);
    assert.match(created.token, /^fxm_[a-f0-9]{64}$/);
    const [row] = await listMcpTokens(1);
    assert.equal(Number(row.id), created.id);
    assert.equal(row.name, "My MCP client");
    assert.equal(row.prefix, created.token.slice(0, 12));
    assert.equal(Number(row.expiresAt), created.expiresAt);
    assert.ok(Number.isFinite(new Date(Number(row.expiresAt) * 1000).getTime()));
    assert.doesNotMatch(JSON.stringify(row), new RegExp(created.token));
    assert.equal(row.tokenHash, undefined);
    assert.deepEqual(await listMcpTokens(2), []);
    const [stored] = await runtime.queryRaw<any>("SELECT tokenHash FROM external_mcp_tokens WHERE id = ?", [created.id]);
    assert.equal(stored.tokenHash, hashMcpToken(created.token));
    assert.ok(await resolveMcpToken(created.token));
    assert.equal(await resolveMcpToken(row.prefix), null);

    const app = express(); app.use(mcpHttpRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    const call = (token: string, method: string, params?: object) => fetch(url, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const initialized = await call(created.token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(initialized.status, 200);
    assert.equal((await initialized.json()).result.serverInfo.name, "ForwardX");
    const tools = await call(created.token, "tools/list");
    assert.equal(tools.status, 200);
    assert.ok((await tools.json()).result.tools.some((tool: any) => tool.name === "traffic.rank"));
    assert.equal((await call(row.prefix, "ping")).status, 401);
    await runtime.executeRaw("UPDATE users SET role = 'user' WHERE id = 1");
    assert.equal((await call(created.token, "ping")).status, 403);
    await runtime.executeRaw("UPDATE users SET role = 'admin', accountEnabled = 0 WHERE id = 1");
    assert.equal((await call(created.token, "ping")).status, 401);
    await runtime.executeRaw("UPDATE users SET accountEnabled = 1 WHERE id = 1");
    await revokeMcpToken(3, created.id);
    assert.equal((await call(created.token, "ping")).status, 200, "another account cannot revoke this token");
    await revokeMcpToken(1, created.id);
    assert.equal((await call(created.token, "ping")).status, 401);
    const expired = await createMcpToken(1, "Expired", 7);
    await runtime.executeRaw("UPDATE external_mcp_tokens SET expiresAt = ? WHERE id = ?", [Math.floor(Date.now() / 1000) - 1, expired.id]);
    assert.equal((await call(expired.token, "ping")).status, 401);
  }
} finally {
  if (server) { server.closeIdleConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  await runtime.closeDatabase(); restore();
}
