import assert from "node:assert/strict";
import test from "node:test";
import {
  agentTokenFingerprint,
  decryptPayload,
  encryptPayload,
  getAgentCryptoCacheStats,
  rememberEncryptedEnvelope,
  resetAgentCryptoCaches,
  signAgentAuthProof,
  signAgentChallengeAuthProof,
  verifyAgentAuthProof,
  verifyAgentAuthProofDetails,
} from "./agentCrypto";
import {
  issueAgentAuthChallenge,
  resetAgentAuthChallengesForTests,
  validateAgentAuthChallenge,
} from "./agentAuthChallenge";
import {
  panelCryptoNowMs,
  refreshPanelClock,
  resetPanelClockForTests,
} from "./panelClock";

function v1Proof(input: {
  token: string;
  method: string;
  path: string;
  bodyText: string;
  ts: number;
  nonce: string;
}) {
  const signature = signAgentAuthProof(input);
  return `v1.${agentTokenFingerprint(input.token)}.${input.ts}.${input.nonce}.${signature}`;
}

function v2Proof(input: {
  token: string;
  method: string;
  path: string;
  bodyText: string;
  challenge: string;
  nonce: string;
}) {
  const signature = signAgentChallengeAuthProof(input);
  return `v2.${agentTokenFingerprint(input.token)}.${input.challenge}.${input.nonce}.${signature}`;
}

function changedHex(value: string) {
  const last = value.at(-1);
  return `${value.slice(0, -1)}${last === "0" ? "1" : "0"}`;
}

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

test("Agent challenge auth proof matches the Go fixed vector", () => {
  assert.equal(
    signAgentChallengeAuthProof({
      token: "forwardx-test-token",
      method: "post",
      path: "/api/sync",
      bodyText: `{"v":1}`,
      challenge: "A".repeat(86),
      nonce: "00112233445566778899aabbccddeeff",
    }),
    "ac04d4c29de90e800e81675a3f4933b210cbdf4ef9db13e2ff9fa8a329dcefe3",
  );
});

test("Agent challenges use panel monotonic lifetime and reject tampering", () => {
  const issuedAtMs = 20_000;
  const challenge = issueAgentAuthChallenge(issuedAtMs);
  assert.equal(validateAgentAuthChallenge(challenge, issuedAtMs), true);
  assert.equal(validateAgentAuthChallenge(challenge, issuedAtMs + 10 * 60 * 1000), true);
  assert.equal(validateAgentAuthChallenge(challenge, issuedAtMs + 10 * 60 * 1000 + 1), false);
  assert.equal(validateAgentAuthChallenge(changedHex(challenge), issuedAtMs), false);
});

test("challenge auth is body-bound, tamper-resistant, and single-use", () => {
  resetAgentCryptoCaches();
  resetAgentAuthChallengesForTests();
  const input = {
    token: "challenge-once-token",
    method: "POST",
    path: "/api/agent/heartbeat",
    bodyText: `{"hostId":7}`,
    challenge: issueAgentAuthChallenge(),
    nonce: "102132435465768798a9bacbdcedfe0f",
  };
  const raw = v2Proof(input);
  const signature = raw.slice(raw.lastIndexOf(".") + 1);

  try {
    assert.equal(verifyAgentAuthProofDetails({
      raw,
      candidateTokens: [input.token],
      method: input.method,
      path: input.path,
      bodyText: `{"hostId":8}`,
    }), null, "a changed encrypted body must not consume the challenge");
    assert.equal(verifyAgentAuthProofDetails({
      raw: `${raw.slice(0, raw.lastIndexOf(".") + 1)}${changedHex(signature)}`,
      candidateTokens: [input.token],
      method: input.method,
      path: input.path,
      bodyText: input.bodyText,
    }), null, "a changed signature must not consume the challenge");
    assert.deepEqual(verifyAgentAuthProofDetails({
      raw,
      candidateTokens: [input.token],
      method: input.method,
      path: input.path,
      bodyText: input.bodyText,
    }), { token: input.token, version: "v2" });
    assert.equal(verifyAgentAuthProofDetails({
      raw,
      candidateTokens: [input.token],
      method: input.method,
      path: input.path,
      bodyText: input.bodyText,
    }), null, "a consumed challenge must reject replay");
  } finally {
    resetAgentAuthChallengesForTests();
    resetAgentCryptoCaches();
  }
});

test("challenge-v2 accepts a 302-second-old envelope without skipping MAC verification", () => {
  resetAgentCryptoCaches();
  resetAgentAuthChallengesForTests();
  const token = "clockless-envelope-token";
  const nowMs = 1_784_000_000_000;
  const envelope = encryptPayload({ sequence: 9 }, token, { timestampMs: nowMs - 302_000 });
  const bodyText = JSON.stringify(envelope);
  const proofInput = {
    token,
    method: "POST",
    path: "/api/agent/traffic",
    bodyText,
    challenge: issueAgentAuthChallenge(),
    nonce: "11223344556677889900aabbccddeeff",
  };

  try {
    const auth = verifyAgentAuthProofDetails({
      raw: v2Proof(proofInput),
      candidateTokens: [token],
      method: proofInput.method,
      path: proofInput.path,
      bodyText,
      nowMs,
    });
    assert.deepEqual(auth, { token, version: "v2" });
    assert.throws(
      () => decryptPayload(envelope, token, { nowMs, rememberReplay: false }),
      /timestamp out of window/i,
    );
    assert.deepEqual(
      decryptPayload(envelope, token, {
        nowMs,
        validateTimestamp: auth?.version !== "v2",
        rememberReplay: false,
      }),
      { sequence: 9 },
    );
    assert.throws(
      () => decryptPayload({ ...envelope, mac: changedHex(envelope.mac) }, token, {
        nowMs,
        validateTimestamp: false,
        rememberReplay: false,
      }),
      /MAC verification failed/i,
    );
  } finally {
    resetAgentAuthChallengesForTests();
    resetAgentCryptoCaches();
  }
});

test("legacy v1 auth uses the calibrated protocol clock and still rejects truly expired proofs", async () => {
  resetAgentCryptoCaches();
  resetPanelClockForTests();
  const dateHeaderMs = Date.UTC(2026, 6, 27, 13, 14, 20);
  const trustedNowMs = dateHeaderMs + 500;
  const slowSystemNowMs = trustedNowMs - 302_000;
  const response = {
    url: "https://clock.example/result",
    headers: new Headers({ date: new Date(dateHeaderMs).toUTCString() }),
    body: null,
  } as Response;
  const token = "legacy-calibrated-token";
  const proofInput = {
    token,
    method: "POST",
    path: "/api/agent/register",
    bodyText: `{"hostname":"test"}`,
    ts: trustedNowMs,
    nonce: "223344556677889900aabbccddeeff00",
  };
  const silentLogger = { info() {}, warn() {} };

  try {
    const raw = v1Proof(proofInput);
    assert.equal(verifyAgentAuthProofDetails({
      raw,
      candidateTokens: [token],
      method: proofInput.method,
      path: proofInput.path,
      bodyText: proofInput.bodyText,
      nowMs: slowSystemNowMs,
    }), null, "an uncalibrated clock outside the five-minute window rejects v1");

    await refreshPanelClock({
      sources: ["https://clock-a.example/", "https://clock-b.example/"],
      fetchImpl: (async () => response) as typeof fetch,
      wallNow: () => slowSystemNowMs,
      monotonicNow: () => 1_000,
      logger: silentLogger,
    });
    assert.equal(panelCryptoNowMs(), trustedNowMs);
    assert.deepEqual(verifyAgentAuthProofDetails({
      raw,
      candidateTokens: [token],
      method: proofInput.method,
      path: proofInput.path,
      bodyText: proofInput.bodyText,
    }), { token, version: "v1" });

    const expiredInput = {
      ...proofInput,
      ts: trustedNowMs - 300_001,
      nonce: "3344556677889900aabbccddeeff0011",
    };
    assert.equal(verifyAgentAuthProofDetails({
      raw: v1Proof(expiredInput),
      candidateTokens: [token],
      method: expiredInput.method,
      path: expiredInput.path,
      bodyText: expiredInput.bodyText,
    }), null);
  } finally {
    resetPanelClockForTests();
    resetAgentCryptoCaches();
  }
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

test("replay protection cleanup is amortized under sustained Agent reports", () => {
  resetAgentCryptoCaches();
  const now = Date.now();
  for (let index = 0; index < 10_000; index += 1) {
    rememberEncryptedEnvelope({
      v: 1,
      iv: "00".repeat(16),
      ct: "",
      mac: index.toString(16).padStart(64, "0"),
      ts: now,
    });
  }
  const stats = getAgentCryptoCacheStats();
  assert.equal(stats.envelopeReplayEntries, 10_000);
  assert.ok(stats.replayCleanupSweeps <= 2, `expected amortized cleanup, got ${stats.replayCleanupSweeps} full sweeps`);
  resetAgentCryptoCaches();
});

test("replay entries cover the complete symmetric timestamp window", () => {
  resetAgentCryptoCaches();
  const envelope = {
    v: 1,
    iv: "00".repeat(16),
    ct: "",
    mac: "ab".repeat(32),
    ts: 0,
  };
  const firstSeenAt = 10_000;
  rememberEncryptedEnvelope(envelope, firstSeenAt);
  assert.throws(
    () => rememberEncryptedEnvelope(envelope, firstSeenAt + 10 * 60 * 1000),
    /replay detected/i,
  );
  resetAgentCryptoCaches();
});
