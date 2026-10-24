import type { AiProvider } from "./settings";

export function buildAiModelsEndpoint(provider: AiProvider, baseUrl: string, chatOnly: boolean) {
  const url = new URL(baseUrl.trim());
  // Accept the same chat-completions URL supported by the AI client.
  const path = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
  url.pathname = /\/models$/i.test(path) ? path : `${path}/models`;
  if (provider === "siliconflow" && chatOnly) url.searchParams.set("sub_type", "chat");
  // DeepSeek and generic OpenAI-compatible endpoints do not specify type=chat.
  return url.toString();
}
