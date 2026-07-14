import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { buildForwardXWireGuardPlans, deriveForwardXWireGuardKeyPair } from "./forwardXWireGuard";

test("derives stable, valid X25519 WireGuard keys", () => {
  const left = deriveForwardXWireGuardKeyPair("seed", 12, 41);
  const same = deriveForwardXWireGuardKeyPair("seed", 12, 41);
  const right = deriveForwardXWireGuardKeyPair("seed", 12, 42);
  assert.deepEqual(left, same);
  assert.notEqual(left.privateKey, right.privateKey);
  assert.match(left.privateKey, /^[a-f0-9]{64}$/);
  assert.match(left.publicKey, /^[a-f0-9]{64}$/);

  const privatePrefix = Buffer.from("302e020100300506032b656e04220420", "hex");
  const publicPrefix = Buffer.from("302a300506032b656e032100", "hex");
  const leftPrivate = crypto.createPrivateKey({ key: Buffer.concat([privatePrefix, Buffer.from(left.privateKey, "hex")]), format: "der", type: "pkcs8" });
  const rightPrivate = crypto.createPrivateKey({ key: Buffer.concat([privatePrefix, Buffer.from(right.privateKey, "hex")]), format: "der", type: "pkcs8" });
  const leftPublic = crypto.createPublicKey({ key: Buffer.concat([publicPrefix, Buffer.from(left.publicKey, "hex")]), format: "der", type: "spki" });
  const rightPublic = crypto.createPublicKey({ key: Buffer.concat([publicPrefix, Buffer.from(right.publicKey, "hex")]), format: "der", type: "spki" });
  assert.deepEqual(crypto.diffieHellman({ privateKey: leftPrivate, publicKey: rightPublic }), crypto.diffieHellman({ privateKey: rightPrivate, publicKey: leftPublic }));
});

test("builds bidirectional peers while only the dialing side carries an endpoint", () => {
  const plans = buildForwardXWireGuardPlans({
    tunnelId: 7,
    seed: "tunnel-secret",
    nodes: [
      { hostId: 10 },
      { hostId: 20, listenPort: 31000 },
      { hostId: 30, listenPort: 32000 },
    ],
    links: [
      { fromHostId: 10, toHostId: 20, endpointHost: "198.51.100.20", endpointPort: 31000 },
      { fromHostId: 20, toHostId: 30, endpointHost: "2001:db8::30", endpointPort: 32000 },
    ],
  });
  assert.equal(plans.size, 3);
  assert.equal(plans.get(10)?.peers[0]?.endpointHost, "198.51.100.20");
  assert.equal(plans.get(10)?.peers[0]?.persistentKeepalive, 25);
  assert.equal(plans.get(20)?.peers.find((peer) => peer.hostId === 10)?.endpointHost, undefined);
  assert.equal(plans.get(20)?.peers.find((peer) => peer.hostId === 30)?.endpointHost, "2001:db8::30");
  assert.equal(plans.get(30)?.listenPort, 32000);
  assert.equal(new Set(Array.from(plans.values()).map((plan) => plan.address)).size, 3);
});
