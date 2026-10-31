import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent } from "undici";

// Docker commonly has working IPv4 but no IPv6 route. Do not abandon a
// healthy, higher-latency IPv4 connection after Node's default 250ms race.
export const TELEGRAM_IPV4_FALLBACK_DELAY_MS = 5_000;
export const TELEGRAM_CONNECT_TIMEOUT_MS = 12_000;

export function createTelegramLookup(resolve: LookupFunction = lookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, order: "ipv4first", verbatim: false }, (error, address, family) => {
      callback(error, Array.isArray(address)
        ? [...address].sort((a, b) => a.family - b.family)
        : address, family);
    });
  };
}

export function createTelegramApiDispatcher(resolve: LookupFunction = lookup) {
  return new Agent({
    connections: 8,
    pipelining: 1,
    connect: {
      lookup: createTelegramLookup(resolve),
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: TELEGRAM_IPV4_FALLBACK_DELAY_MS,
      timeout: TELEGRAM_CONNECT_TIMEOUT_MS,
    },
  });
}

let dispatcher: Agent | undefined;

export function telegramApiFetch(url: string, options: RequestInit) {
  // Reuse one bounded pool, scoped to Telegram rather than changing global
  // DNS/socket settings. Address fallback happens before any HTTP body is
  // sent: never replay sendMessage after an ambiguous HTTP failure.
  const init: RequestInit & { dispatcher: Agent } = {
    ...options,
    dispatcher: dispatcher ??= createTelegramApiDispatcher(),
  };
  return fetch(url, init);
}
