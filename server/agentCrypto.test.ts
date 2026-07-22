import assert from "node:assert/strict";
import test from "node:test";
import {
  agentTokenFingerprint,
  encryptPayload,
  signAgentAuthProof,
  verifyAgentAuthProof,
} from "./agentCrypto";

test("Agent auth proof matches the Go fixed vector", () => {
  const token = "forwardx-test-token";
  const bodyText = `{"v":1,"iv":"00","ct":"11","mac":"22","ts":1784700000000}`;
  const ts = 1784700000123;
  const nonce = "00112233445566778899aabbccddeeff";
  assert.equal(agentTokenFingerprint(token), "691cd7140d18ac6942ce407dc8ac1466");
  assert.equal(
    signAgentAuthProof({ token, method: "POST", path: "/api/sync", bodyText, ts, nonce }),
    "ee96cf825e315eb1e39b82e3a24a7e259d8c2b96a9f20cdbdf82879f1f35c3c9",
  );
});

test("signed auth selects one token before decrypting a large envelope", () => {
  const tokens = Array.from({ length: 55 }, (_, index) => `token-${index}-${"x".repeat(32)}`);
  const token = tokens[54];
  const envelope = encryptPayload({ data: "x".repeat(200_000) }, token);
  const bodyText = JSON.stringify(envelope);
  const ts = Date.now();
  const nonce = "ffeeddccbbaa99887766554433221100";
  const signature = signAgentAuthProof({ token, method: "POST", path: "/api/sync", bodyText, ts, nonce });
  const raw = `v1.${agentTokenFingerprint(token)}.${ts}.${nonce}.${signature}`;

  assert.equal(verifyAgentAuthProof({ raw, candidateTokens: tokens, method: "POST", path: "/api/sync", bodyText }), token);
});
