import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getDefaultResultOrder } from "node:dns";
import { createServer } from "node:http";
import { getDefaultAutoSelectFamilyAttemptTimeout, type AddressInfo, type LookupFunction } from "node:net";
import tls from "node:tls";

import {
  TELEGRAM_API_LONG_POLL_TIMEOUT_MS,
  TELEGRAM_API_REQUEST_TIMEOUT_MS,
  TelegramApiTimeoutError,
  telegramApiTimeoutMs,
  withTelegramApiTimeout,
} from "./telegramApiTimeout";
import {
  createTelegramApiDispatcher,
  createTelegramLookup,
  TELEGRAM_CONNECT_TIMEOUT_MS,
  TELEGRAM_IPV4_FALLBACK_DELAY_MS,
  telegramApiFetch,
} from "./telegramApiTransport";

test("Telegram long polling keeps a longer client deadline than regular API calls", () => {
  assert.equal(telegramApiTimeoutMs("sendMessage"), TELEGRAM_API_REQUEST_TIMEOUT_MS);
  assert.equal(telegramApiTimeoutMs("getUpdates"), TELEGRAM_API_LONG_POLL_TIMEOUT_MS);
  assert.ok(TELEGRAM_API_LONG_POLL_TIMEOUT_MS > 25_000);
  assert.ok(TELEGRAM_API_LONG_POLL_TIMEOUT_MS > TELEGRAM_API_REQUEST_TIMEOUT_MS);
});

test("Telegram API timeout aborts the request and reports a distinct error", async () => {
  let aborted = false;
  await assert.rejects(
    withTelegramApiTimeout("sendMessage", (signal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    }), 10),
    (error: unknown) => error instanceof TelegramApiTimeoutError
      && /sendMessage/.test(error.message),
  );
  assert.equal(aborted, true);
});

test("Telegram API timeout preserves errors raised before the deadline", async () => {
  const expected = new Error("network unavailable");
  await assert.rejects(
    withTelegramApiTimeout("sendMessage", async () => {
      throw expected;
    }, 100),
    (error: unknown) => error === expected,
  );
});

test("Telegram DNS puts IPv4 first while retaining all IPv6 fallback addresses", () => {
  const answers = [
    { address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 },
    { address: "::2", family: 6 }, { address: "127.0.0.2", family: 4 },
  ];
  const lookup = createTelegramLookup((hostname, options, callback) => {
    assert.equal(hostname, "telegram.test");
    assert.equal(options.order, "ipv4first");
    assert.equal(options.all, true);
    callback(null, answers);
  });
  lookup("telegram.test", { all: true }, (error, actual) => {
    assert.equal(error, null);
    assert.deepEqual(actual, [answers[1], answers[3], answers[0], answers[2]]);
  });
  assert.equal(answers[0].family, 6, "do not mutate the resolver's result");
});

test("Telegram DNS preserves single-family lookups and original DNS errors", () => {
  const expected = Object.assign(new Error("DNS unavailable"), { code: "EAI_AGAIN" });
  const failing = createTelegramLookup((_hostname, _options, callback) => callback(expected, []));
  failing("telegram.test", { all: true }, error => assert.equal(error, expected));
  const single = createTelegramLookup((_hostname, options, callback) => {
    assert.equal(options.family, 4);
    callback(null, "127.0.0.1", 4);
  });
  single("telegram.test", { family: 4 }, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "127.0.0.1");
    assert.equal(family, 4);
  });
});

test("Telegram connections allow five seconds for IPv4 without changing global networking or disabling TLS", async (t) => {
  const originalOrder = getDefaultResultOrder();
  const originalDelay = getDefaultAutoSelectFamilyAttemptTimeout();
  const expected = new Error("test connector: no external connection");
  let connectionOptions: any;
  t.mock.method(tls, "connect", (options: any) => {
    connectionOptions = options;
    throw expected;
  });
  const dispatcher = createTelegramApiDispatcher();
  t.after(() => dispatcher.destroy());
  const options: RequestInit & { dispatcher: typeof dispatcher } = { dispatcher };
  await assert.rejects(fetch("https://api.telegram.org", options), (error: any) => error.cause === expected);
  assert.equal(connectionOptions.autoSelectFamily, true);
  assert.equal(connectionOptions.autoSelectFamilyAttemptTimeout, 5_000);
  assert.equal(connectionOptions.autoSelectFamilyAttemptTimeout, TELEGRAM_IPV4_FALLBACK_DELAY_MS);
  assert.equal(typeof connectionOptions.lookup, "function");
  assert.notEqual(connectionOptions.rejectUnauthorized, false);
  assert.equal(connectionOptions.servername, "api.telegram.org");
  assert.ok(TELEGRAM_CONNECT_TIMEOUT_MS > TELEGRAM_IPV4_FALLBACK_DELAY_MS);
  assert.ok(TELEGRAM_CONNECT_TIMEOUT_MS < TELEGRAM_API_REQUEST_TIMEOUT_MS);
  assert.equal(getDefaultResultOrder(), originalOrder);
  assert.equal(getDefaultAutoSelectFamilyAttemptTimeout(), originalDelay);
});

async function testLoopback(t: TestContext, mode: "ipv4" | "fallback" | "ipv6-only") {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount++;
    response.end(request.socket.remoteFamily);
  });
  const ipv6 = mode !== "ipv4";
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: ipv6 ? "::1" : "127.0.0.1", port: 0, ipv6Only: ipv6 }, resolve);
    });
  } catch (error: any) {
    if (ipv6 && ["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"].includes(error.code)) {
      t.skip("IPv6 loopback is not available on this host");
      return;
    }
    throw error;
  }
  const resolver: LookupFunction = (_hostname, _options, callback) => callback(null,
    mode === "ipv4" ? [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }]
      : mode === "fallback" ? [{ address: "127.0.0.2", family: 4 }, { address: "::1", family: 6 }]
        : [{ address: "::1", family: 6 }]);
  const dispatcher = createTelegramApiDispatcher(resolver);
  t.after(async () => {
    await dispatcher.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const options: RequestInit & { dispatcher: typeof dispatcher } = {
    dispatcher, method: "POST", body: "one message", signal: AbortSignal.timeout(3_000),
  };
  const response = await fetch(`http://telegram.test:${(server.address() as AddressInfo).port}/`, options);
  assert.equal(await response.text(), ipv6 ? "IPv6" : "IPv4");
  assert.equal(requestCount, 1, "address fallback must never replay the HTTP request");
}

test("Telegram connects over IPv4 even when DNS originally lists IPv6 first", t => testLoopback(t, "ipv4"));
test("Telegram falls back to IPv6 immediately when IPv4 is explicitly refused", t => testLoopback(t, "fallback"));
test("Telegram can still connect on IPv6-only networks", t => testLoopback(t, "ipv6-only"));

test("Telegram fetch reuses its scoped pool, preserves cancellation and never retries a sent message", async (t) => {
  const calls: Array<{ url: string; options: any }> = [];
  const expected = new Error("ambiguous HTTP failure");
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls.push({ url, options });
    if (calls.length === 2) throw expected;
    return Response.json({ ok: true });
  });
  const signal = new AbortController().signal;
  const options = { method: "POST", body: JSON.stringify({ text: "message" }), signal };
  const url = "https://api.telegram.org/bottest/sendMessage";
  await telegramApiFetch(url, options);
  await assert.rejects(telegramApiFetch(url, options), error => error === expected);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.dispatcher, calls[1].options.dispatcher);
  for (const call of calls) {
    assert.equal(call.url, url);
    assert.equal(call.options.signal, signal);
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.body, options.body);
  }
});
