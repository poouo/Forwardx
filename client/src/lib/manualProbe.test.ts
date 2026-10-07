import assert from "node:assert/strict";
import test from "node:test";
import { fetchManualProbe, manualProbeDeadline, MANUAL_PROBE_UI_TIMEOUT_MS } from "./manualProbe";

test("probe UI deadlines are fixed and handle persisted and legacy pending messages", () => {
  assert.equal(manualProbeDeadline(null, 100), 100 + MANUAL_PROBE_UI_TIMEOUT_MS);
  assert.equal(manualProbeDeadline(JSON.stringify({ deadlineAt: 90_000 }), 0), 95_000);
  assert.equal(manualProbeDeadline(JSON.stringify({ generatedAt: "2026-10-07T00:00:00Z" }), 0),
    Date.parse("2026-10-07T00:00:00Z") + MANUAL_PROBE_UI_TIMEOUT_MS);
  assert.equal(manualProbeDeadline("invalid legacy message", 0), 0);
});

test("probe requests time out for stalled headers and bodies, then recover", async () => {
  const hang: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  await assert.rejects(fetchManualProbe(hang, "https://panel.test", undefined, 10), { name: "TimeoutError" });
  const bodyHang: typeof fetch = async (_input, init) => new Response(new ReadableStream({
    start(controller) { init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true }); },
  }));
  await assert.rejects(fetchManualProbe(bodyHang, "https://panel.test", undefined, 10), { name: "TimeoutError" });
  const response = await fetchManualProbe(async (_input, init) => {
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "include");
    return new Response("ok", { status: 503 });
  }, "https://panel.test", { credentials: "include" });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "ok");
});

test("caller cancellation propagates to the isolated probe request", async () => {
  const caller = new AbortController();
  await assert.rejects(fetchManualProbe(async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    caller.abort(new DOMException("cancelled", "AbortError"));
  }), "https://panel.test", { signal: caller.signal }), { name: "AbortError" });
});
