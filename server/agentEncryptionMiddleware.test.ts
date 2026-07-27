import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import {
  AGENT_AUTH_RESULT_ACCEPTED,
  AGENT_AUTH_RESULT_HEADER,
  AGENT_AUTH_RESULT_REJECTED,
} from "./agentAuth";
import { decryptPayload, encryptPayload, resetAgentCryptoCaches } from "./agentCrypto";
import { agentEncryptionMiddleware } from "./agentEncryptionMiddleware";

async function withAgentMiddlewareServer(
  run: (baseUrl: string) => Promise<void>,
  options: { verifiedProof?: boolean } = {},
) {
  const app = express();
  app.use(express.json());
  if (options.verifiedProof) {
    app.use((req, _res, next) => {
      (req as any).agentAuthVersion = "v2";
      next();
    });
  }
  app.post("/api/sync", agentEncryptionMiddleware, (_req, res) => {
    res.status(403).json({ error: "forbidden" });
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
}

test("Agent middleware marks pre-auth failures as rejected", async () => {
  await withAgentMiddlewareServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invalid: true }),
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get(AGENT_AUTH_RESULT_HEADER), AGENT_AUTH_RESULT_REJECTED);
  });
});

test("authenticated business 403 stays accepted and encrypted", async () => {
  resetAgentCryptoCaches();
  const token = "agent-middleware-business-token";
  try {
    await withAgentMiddlewareServer(async (baseUrl) => {
      const requestEnvelope = encryptPayload({
        path: "/api/agent/protocol-block",
        payload: { ruleId: 7 },
      }, token);
      const response = await fetch(`${baseUrl}/api/sync`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestEnvelope),
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get(AGENT_AUTH_RESULT_HEADER), AGENT_AUTH_RESULT_ACCEPTED);
      const responseEnvelope = await response.json();
      assert.deepEqual(
        decryptPayload(responseEnvelope, token, { rememberReplay: false }),
        { error: "forbidden" },
      );
    });
  } finally {
    resetAgentCryptoCaches();
  }
});

test("envelope replay after a verified challenge proof stays accepted", async () => {
  resetAgentCryptoCaches();
  const token = "agent-middleware-replay-token";
  const requestEnvelope = encryptPayload({
    path: "/api/agent/protocol-block",
    payload: { ruleId: 8 },
  }, token);
  try {
    await withAgentMiddlewareServer(async (baseUrl) => {
      const send = () => fetch(`${baseUrl}/api/sync`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestEnvelope),
      });

      const first = await send();
      assert.equal(first.status, 403);
      assert.equal(first.headers.get(AGENT_AUTH_RESULT_HEADER), AGENT_AUTH_RESULT_ACCEPTED);

      const replay = await send();
      assert.equal(replay.status, 401);
      assert.equal(replay.headers.get(AGENT_AUTH_RESULT_HEADER), AGENT_AUTH_RESULT_ACCEPTED);
      assert.match(JSON.stringify(await replay.json()), /replay detected/i);
    }, { verifiedProof: true });
  } finally {
    resetAgentCryptoCaches();
  }
});
