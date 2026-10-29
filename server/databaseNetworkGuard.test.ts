import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import mysql from "mysql2/promise";
import mysqlCore from "mysql2";
import pg from "pg";
import { DatabaseLeaseClosedError, guardDatabasePool, withDatabaseMaintenanceBudget } from "./databaseNetworkGuard";
import { createRequestWorkPool } from "./requestWorkPool";
import { retryTransactionConflicts } from "./transactionRetry";
import { isDatabaseBusyError } from "./databaseHealthState";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const limits = () => ({ maxOpen: 1, queueLimit: 2, connectTimeoutMillis: 150 });
const never = () => new Promise(() => {});

function mockPool(driver: "mysql" | "postgresql", query: (...args: any[]) => Promise<any>, options = {}) {
  let discarded = 0;
  let released = 0;
  let checkedOut = 0;
  let calls = 0;
  const checkout = async () => {
    checkedOut++;
    let done = false;
    const finish = (bad: boolean) => {
      if (done) return;
      done = true;
      checkedOut--;
      if (bad) discarded++; else released++;
    };
    return {
      query: (...args: any[]) => { calls++; return query(...args); },
      execute: (...args: any[]) => { calls++; return query(...args); },
      beginTransaction: () => query("BEGIN"), commit: () => query("COMMIT"), rollback: () => query("ROLLBACK"),
      release: (bad?: boolean) => finish(!!bad), destroy: () => finish(true),
    };
  };
  const raw = { getConnection: checkout, connect: checkout, end: async () => {} };
  const pool = guardDatabasePool(raw, driver, limits, { queryTimeoutMs: 30, ...options }) as any;
  return { pool, stats: () => ({ discarded, released, checkedOut, calls }) };
}

for (const driver of ["mysql", "postgresql"] as const) {
  test(`${driver}: released leases reject locally without executing SQL or borrowing a replacement`, async () => {
    const { pool, stats } = mockPool(driver, async () => "ok");
    try {
      const client = await (driver === "mysql" ? pool.getConnection() : pool.connect());
      client.release();
      for (const method of ["query", "execute", "commit", "rollback"]) {
        await assert.rejects(client[method]("must not execute"), error => {
          assert.ok(error instanceof DatabaseLeaseClosedError);
          assert.equal(error.code, "DATABASE_LEASE_CLOSED");
          return true;
        });
      }
      assert.equal(stats().calls, 0);
      assert.equal(await pool.query("fresh request"), "ok");
      assert.deepEqual(stats(), { discarded: 0, released: 2, checkedOut: 0, calls: 1 });
    } finally { await pool.end(); }
  });

  test(`${driver}: releasing a lease before driver dispatch cancels SQL with a local lifecycle error`, async () => {
    const { pool, stats } = mockPool(driver, async () => "ok");
    try {
      const client = await (driver === "mysql" ? pool.getConnection() : pool.connect());
      const pending = assert.rejects(client.query("uncertain write"), DatabaseLeaseClosedError);
      client.release();
      await pending;
      assert.equal(stats().calls, 0);
      assert.equal(stats().discarded, 1);
      assert.equal(await pool.query("replacement"), "ok");
    } finally { await pool.end(); }
  });

  test(`${driver}: a stalled query destroys its own client before freeing request slots; subsequent reads recover`, async () => {
    let stalled = true;
    const { pool, stats } = mockPool(driver, async () => stalled ? never() : "ok");
    const requests = createRequestWorkPool({ concurrency: 1, maxQueued: 2, queueTimeoutMs: 200 });
    try {
      const result = assert.rejects(requests.run(() => pool.query("SELECT slow")), { code: "ETIMEDOUT" });
      await delay(5);
      assert.equal(requests.stats().active, 1);
      assert.equal(stats().checkedOut, 1);
      await result;
      assert.deepEqual(requests.stats(), { active: 0, queued: 0 });
      assert.deepEqual(stats(), { discarded: 1, released: 0, checkedOut: 0, calls: 1 });
      stalled = false;
      assert.equal(await requests.run(() => pool.query("SELECT fast")), "ok");
      assert.equal(stats().released, 1);
    } finally { await pool.end(); }
  });

  test(`${driver}: queue bounds and acquire expiry remove waiters without executing their SQL`, async () => {
    const { pool, stats } = mockPool(driver, async () => "ok", { idleLeaseTimeoutMs: 1000 });
    const client = await (driver === "mysql" ? pool.getConnection() : pool.connect());
    const first = assert.rejects(pool.query("must not execute 1"), isDatabaseBusyError);
    const second = assert.rejects(pool.query("must not execute 2"), isDatabaseBusyError);
    await assert.rejects(pool.query("queue full"), isDatabaseBusyError);
    await Promise.all([first, second]);
    client.release();
    assert.equal(stats().calls, 0);
    assert.equal(await pool.query("next"), "ok");
    assert.equal(stats().calls, 1);
    await pool.end();
  });

  test(`${driver}: an uncertain COMMIT is discarded, not rolled back successfully or retried`, async () => {
    let commits = 0;
    const { pool, stats } = mockPool(driver, async sql => {
      if (sql === "COMMIT") { commits++; return never(); }
      return "ok";
    });
    let attempts = 0;
    try {
      await assert.rejects(retryTransactionConflicts(async state => {
        attempts++;
        const client = await (driver === "mysql" ? pool.getConnection() : pool.connect());
        try {
          if (driver === "mysql") { await client.beginTransaction(); await client.commit(); }
          else { await client.query("BEGIN"); await client.query("COMMIT"); }
        } catch (error) {
          const rollback = driver === "mysql" ? client.rollback() : client.query("ROLLBACK");
          await rollback.then(() => { state.rolledBack = true; }).catch(() => {});
          throw error;
        } finally { client.release(); }
      }, true), { code: "ETIMEDOUT" });
      assert.equal(attempts, 1);
      assert.equal(commits, 1);
      assert.equal(stats().discarded, 1);
    } finally { await pool.end(); }
  });

  test(`${driver}: a business SQL error keeps the transaction usable for rollback`, async () => {
    const duplicate = Object.assign(new Error("duplicate"), { code: driver === "mysql" ? "ER_DUP_ENTRY" : "23505" });
    const { pool, stats } = mockPool(driver, async sql => { if (sql === "INSERT") throw duplicate; return "ok"; });
    const client = await (driver === "mysql" ? pool.getConnection() : pool.connect());
    try {
      await assert.rejects(client.query("INSERT"), error => error === duplicate);
      assert.equal(await client.query("ROLLBACK"), "ok");
      assert.equal(stats().discarded, 0);
    } finally { client.release(); await pool.end(); }
  });

  test(`${driver}: late connect results are discarded and shutdown settles outstanding acquisitions`, async () => {
    let resolve: (client: object) => void = () => {};
    let discarded = 0;
    const raw = {
      getConnection: () => new Promise<object>(r => { resolve = r; }),
      connect: () => new Promise<object>(r => { resolve = r; }), end: async () => {},
    };
    const pool = guardDatabasePool(raw, driver, () => ({ maxOpen: 1, queueLimit: 2, connectTimeoutMillis: 20 })) as any;
    await assert.rejects(pool.query("never starts"), { code: "ETIMEDOUT" });
    resolve({ destroy() { discarded++; }, release() { discarded++; } });
    await delay(5);
    assert.equal(discarded, 1);
    const pending = assert.rejects(pool.query("shutdown"), /closed/);
    await delay(1);
    await pool.end();
    await pending;
    resolve({ destroy() { discarded++; }, release() { discarded++; } });
    await delay(5);
    assert.equal(discarded, 2);
  });

  test(`${driver}: idle transaction leases and active queries cannot block pool shutdown`, async () => {
    const { pool, stats } = mockPool(driver, never, { idleLeaseTimeoutMs: 15 });
    const client = await (driver === "mysql" ? pool.getConnection() : pool.connect());
    await delay(35);
    assert.equal(stats().discarded, 1);
    await assert.rejects(client.query("after expiry"), DatabaseLeaseClosedError);
    const query = assert.rejects(pool.query("never responds"), /closed/);
    await delay(1);
    await pool.end();
    await query;
    assert.equal(stats().checkedOut, 0);
    assert.equal(stats().discarded, 2);
  });
}

test("shutdown has a physical socket fallback when the driver's graceful end never completes", async () => {
  for (const driver of ["mysql", "postgresql"] as const) {
    let destroyed = 0;
    const physical = { stream: { destroy() { destroyed++; } }, destroy() {} };
    const raw = { end: never, pool: { _allConnections: { toArray: () => [physical] } }, _clients: [{ connection: physical }] };
    const pool = guardDatabasePool(raw, driver, limits, { closeTimeoutMs: 10 });
    await pool.end();
    assert.equal(destroyed, 1);
    await pool.end();
    assert.equal(destroyed, 1, "shutdown is idempotent");
  }
});

test("maintenance budget is scoped to its async workflow, not concurrent user reads", async t => {
  // Inspect installed deadlines without waiting five minutes.
  const deadlines: number[] = [];
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", ((callback: any, timeout: number, ...args: any[]) => {
    deadlines.push(timeout);
    return original(callback, timeout, ...args);
  }) as typeof setTimeout);
  const { pool } = mockPool("mysql", async () => "ok", { queryTimeoutMs: undefined });
  try {
    await Promise.all([withDatabaseMaintenanceBudget(() => pool.query("UPDATE backfill")), pool.query("SELECT user")]);
    assert.ok(deadlines.includes(300_000));
    assert.ok(deadlines.includes(30_000));
  } finally { await pool.end(); }
});

async function waitFor(predicate: () => boolean) {
  for (let n = 0; n < 100 && !predicate(); n++) await delay(10);
  assert.ok(predicate(), "physical socket did not close");
}

test("real MySQL driver: a partial authentication handshake cannot retain a connecting pool slot", async () => {
  const server: any = mysqlCore.createServer(() => {});
  const sockets = new Set<net.Socket>();
  server.on("connection", (connection: any) => {
    sockets.add(connection.stream);
    connection.stream.on("close", () => sockets.delete(connection.stream));
    connection.on("error", () => {});
    connection.serverHandshake({ protocolVersion: 10, serverVersion: "8.0.36", connectionId: 1, statusFlags: 2, characterSet: 45, capabilityFlags: 0x00088209, authCallback() {} });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server._server.once("listening", resolve));
  const raw = mysql.createPool({ host: "127.0.0.1", port: server._server.address().port, user: "test", password: "test-only", connectTimeout: 30, connectionLimit: 1 });
  const pool = guardDatabasePool(raw, "mysql", () => ({ ...limits(), connectTimeoutMillis: 80 }));
  try {
    for (let i = 0; i < 3; i++) {
      await assert.rejects(pool.query("never reaches SQL"), { code: "ETIMEDOUT" });
      await waitFor(() => sockets.size === 0);
      assert.equal((raw as any).pool._allConnections.length, 0);
    }
  } finally {
    await pool.end();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(resolve));
  }
});

test("real MySQL driver: a TCP peer which completes login but never answers SQL loses its socket and pool slot", async () => {
  const server: any = mysqlCore.createServer(() => {});
  const sockets = new Set<net.Socket>();
  let shouldAnswer = false;
  server.on("connection", (connection: any) => {
    sockets.add(connection.stream);
    connection.stream.on("close", () => sockets.delete(connection.stream));
    connection.on("error", () => {});
    // mysql2's minimal test server does not reset command packet sequence IDs.
    const handlePacket = connection.handlePacket;
    connection.handlePacket = function (packet: any) {
      if (packet?.sequenceId === 0) this.sequenceId = 0;
      return handlePacket.call(this, packet);
    };
    connection.serverHandshake({ protocolVersion: 10, serverVersion: "8.0.36", connectionId: 1, statusFlags: 2, characterSet: 45, capabilityFlags: 0x00088209 });
    connection.on("query", () => { if (shouldAnswer) connection.writeOk(); });
    connection.on("stmt_prepare", () => {}); // Simulate a stalled prepared statement too.
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server._server.once("listening", resolve));
  const raw = mysql.createPool({ host: "127.0.0.1", port: server._server.address().port, user: "test", password: "test-only", connectTimeout: 500, connectionLimit: 1 });
  const pool = guardDatabasePool(raw, "mysql", () => ({ ...limits(), connectTimeoutMillis: 500 }), { queryTimeoutMs: 80 });
  try {
    await assert.rejects(pool.query("SELECT stalled"), { code: "ETIMEDOUT" });
    await waitFor(() => sockets.size === 0);
    assert.equal((raw as any).pool._allConnections.length, 0);
    await assert.rejects(pool.execute("SELECT stalled_prepare"), { code: "ETIMEDOUT" });
    await waitFor(() => sockets.size === 0);
    assert.equal((raw as any).pool._allConnections.length, 0);
    shouldAnswer = true;
    await pool.query("SELECT recovered");
    assert.equal((raw as any).pool._allConnections.length, 1);
  } finally {
    await pool.end();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(resolve));
  }
});

test("real PostgreSQL driver: a logged-in blackhole is terminated and a replacement client can query", async () => {
  const sockets = new Set<net.Socket>();
  let shouldAnswer = false;
  const packet = (type: string, data: Buffer) => {
    const size = Buffer.alloc(4); size.writeInt32BE(data.length + 4);
    return Buffer.concat([Buffer.from(type), size, data]);
  };
  const ready = packet("Z", Buffer.from("I"));
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let loggedIn = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= (loggedIn ? 5 : 4)) {
        const length = buffer.readInt32BE(loggedIn ? 1 : 0) + (loggedIn ? 1 : 0);
        if (buffer.length < length) return;
        buffer = buffer.subarray(length);
        if (!loggedIn) {
          loggedIn = true;
          socket.write(Buffer.concat([packet("R", Buffer.alloc(4)), ready]));
        } else if (shouldAnswer) socket.write(Buffer.concat([packet("C", Buffer.from("SELECT 1\0")), ready]));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const raw = new pg.Pool({ host: "127.0.0.1", port: (server.address() as net.AddressInfo).port, user: "test", database: "test", password: "test-only", connectionTimeoutMillis: 500, max: 1 });
  raw.on("error", () => {});
  const pool = guardDatabasePool(raw, "postgresql", () => ({ ...limits(), connectTimeoutMillis: 500 }), { queryTimeoutMs: 80 });
  try {
    await assert.rejects(pool.query("SELECT stalled"), { code: "ETIMEDOUT" });
    await waitFor(() => sockets.size === 0);
    assert.equal(raw.totalCount, 0);
    shouldAnswer = true;
    const result = await pool.query("SELECT recovered");
    assert.equal(result.command, "SELECT");
  } finally {
    await pool.end();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
