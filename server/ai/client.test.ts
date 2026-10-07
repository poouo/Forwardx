import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { AiClientError, ForwardxAiClient } from "./client";
import type { ForwardxAiSettings } from "./settings";

function settings(overrides: Partial<ForwardxAiSettings> = {}): ForwardxAiSettings {
  return {
    provider: "custom",
    configured: true,
    enabled: true,
    apiKey: "test-key",
    baseUrl: "https://ai.example/v1",
    chatCompletionsUrl: "https://ai.example/v1/chat/completions",
    model: "test-model",
    maxTokens: 512,
    temperature: 0,
    telegramUserManageEnabled: true,
    telegramAutoRecallEnabled: false,
    telegramAutoRecallSeconds: 60,
    redemptionEnabled: true,
    discountEnabled: true,
    ...overrides,
  };
}

function completion(content: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("validates structured responses against the ForwardX skill schema", async () => {
  const bodies: any[] = [];
  const client = new ForwardxAiClient({
    fetchImpl: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body || "{}")));
      return completion({ intent: "hosts", keyword: "东京" });
    }) as typeof fetch,
  });
  const result = await client.requestStructuredJson({
    operation: "test.query",
    settings: settings(),
    systemPrompt: "system",
    userText: "查询东京主机",
    schema: z.object({ intent: z.literal("hosts"), keyword: z.string() }),
  });
  assert.deepEqual(result, { intent: "hosts", keyword: "东京" });
  assert.deepEqual(bodies[0]?.response_format, { type: "json_object" });
  assert.equal(client.getMetrics().successes, 1);
});

test("falls back when an OpenAI-compatible endpoint rejects response_format", async () => {
  const bodies: any[] = [];
  const client = new ForwardxAiClient({
    fetchImpl: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body || "{}")));
      if (bodies.length === 1) return new Response("unsupported response_format", { status: 400 });
      return completion({ action: "none" });
    }) as typeof fetch,
  });
  const result = await client.requestStructuredJson({
    operation: "test.compatibility",
    settings: settings(),
    systemPrompt: "system",
    userText: "查询",
    schema: z.object({ action: z.literal("none") }),
  });
  assert.equal(result.action, "none");
  assert.ok(bodies[0]?.response_format);
  assert.equal(bodies[1]?.response_format, undefined);
  assert.equal(client.getMetrics().compatibilityFallbacks, 1);
});

test("times out a stalled model request", async () => {
  const client = new ForwardxAiClient({
    timeoutMs: 20,
    transientRetries: 0,
    fetchImpl: ((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch,
  });
  await assert.rejects(
    client.requestStructuredJson({
      operation: "test.timeout",
      settings: settings(),
      systemPrompt: "system",
      userText: "query",
      schema: z.object({ ok: z.boolean() }),
    }),
    (error) => error instanceof AiClientError && error.code === "timeout",
  );
  assert.equal(client.getMetrics().timeouts, 1);
});

test("opens the circuit after repeated provider failures", async () => {
  let calls = 0;
  const client = new ForwardxAiClient({
    transientRetries: 0,
    circuitFailureThreshold: 2,
    fetchImpl: (async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch,
  });
  const request = () => client.requestStructuredJson({
    operation: "test.circuit",
    settings: settings(),
    systemPrompt: "system",
    userText: "query",
    schema: z.object({ ok: z.boolean() }),
  });
  await assert.rejects(request(), AiClientError);
  await assert.rejects(request(), AiClientError);
  await assert.rejects(request(), (error) => error instanceof AiClientError && error.code === "circuit_open");
  assert.equal(calls, 2);
});

test("keeps the deadline while a response body stalls after headers", async () => {
  const client = new ForwardxAiClient({ timeoutMs: 20, transientRetries: 0,
    fetchImpl: (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }))) as typeof fetch });
  await assert.rejects(client.requestStructuredJson({ operation: "stalled-body", settings: settings(), systemPrompt: "s", userText: "u", schema: z.object({ ok: z.boolean() }) }),
    (error) => error instanceof AiClientError && error.code === "timeout");
});

test("retains structured server context and rejects oversized provider responses", async () => {
  let body: any;
  const client = new ForwardxAiClient({ fetchImpl: (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return completion({ ok: true });
  }) as typeof fetch });
  await client.requestStructuredJson({ operation: "context", settings: settings(), systemPrompt: "s", userText: "u".repeat(800), context: { intent: { target: "2", amountYuan: 50 } }, maxTokens: 2048, schema: z.object({ ok: z.boolean() }) });
  assert.equal(body.messages[1].content.length, 800);
  assert.match(body.messages[2].content, /amountYuan/);
  assert.equal(body.max_tokens, 2048);
  const oversized = new ForwardxAiClient({ fetchImpl: (async () => new Response("x".repeat(300_000))) as typeof fetch });
  await assert.rejects(oversized.requestStructuredJson({ operation: "oversized", settings: settings(), systemPrompt: "s", userText: "u", schema: z.object({ ok: z.boolean() }) }),
    (error) => error instanceof AiClientError && error.code === "invalid_response");
});
