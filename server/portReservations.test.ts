import assert from "node:assert/strict";
import test from "node:test";
import {
  clearHostPortReservationsForTest,
  reserveAvailableHostPort,
  reserveSpecificHostPort,
  reservedHostPorts,
  tryReserveHostPort,
} from "./portReservations";

test.beforeEach(() => clearHostPortReservationsForTest());

test("reserves a listen port as one Agent runtime identity", () => {
  const tcp = tryReserveHostPort(1, 12000, "tcp");
  const udp = tryReserveHostPort(1, 12000, "udp");
  assert.ok(tcp);
  assert.equal(udp, null);
  assert.equal(tryReserveHostPort(1, 12000, "both"), null);
  assert.deepEqual(reservedHostPorts(1, "tcp"), [12000]);
  tcp.release();
  assert.deepEqual(reservedHostPorts(1, "tcp"), []);
});

test("concurrent allocators retry collisions without serializing database work", async () => {
  const startPort = 20000;
  const count = 96;
  const reservations = await Promise.all(Array.from({ length: count }, async (_, index) => {
    return reserveAvailableHostPort({
      hostId: 9,
      protocol: "both",
      maxAttempts: 256,
      findPort: async (reservedPorts) => {
        await new Promise((resolve) => setTimeout(resolve, index % 4));
        const reserved = new Set(reservedPorts);
        for (let port = startPort; port < startPort + count + 16; port += 1) {
          if (!reserved.has(port)) return port;
        }
        return null;
      },
      isUsed: async () => false,
    });
  }));

  assert.equal(reservations.filter(Boolean).length, count);
  assert.equal(new Set(reservations.map((reservation) => reservation?.port)).size, count);
  for (const reservation of reservations) reservation?.release();
  assert.deepEqual(reservedHostPorts(9, "both"), []);
});

test("checked reservations are released after conflicts and lookup failures", async () => {
  const used = await reserveSpecificHostPort({
    hostId: 3,
    port: 23000,
    protocol: "both",
    isUsed: async () => true,
  });
  assert.equal(used, null);
  assert.deepEqual(reservedHostPorts(3, "both"), []);

  await assert.rejects(() => reserveSpecificHostPort({
    hostId: 3,
    port: 23001,
    protocol: "both",
    isUsed: async () => { throw new Error("lookup failed"); },
  }), /lookup failed/);
  assert.deepEqual(reservedHostPorts(3, "both"), []);
});
