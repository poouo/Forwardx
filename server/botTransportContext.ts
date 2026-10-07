import { AsyncLocalStorage } from "node:async_hooks";

type BotTransport = { provider: "discord"; api: (method: string, body?: Record<string, unknown>) => Promise<any> };
export const botTransportContext = new AsyncLocalStorage<BotTransport>();
export function isDiscordBotContext() { return botTransportContext.getStore()?.provider === "discord"; }
