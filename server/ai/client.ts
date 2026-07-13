import type { ZodType } from "zod";
import type { ForwardxAiSettings } from "./settings";

type FetchLike = typeof fetch;

export type AiClientMetrics = {
  requests: number;
  successes: number;
  failures: number;
  timeouts: number;
  retries: number;
  compatibilityFallbacks: number;
  circuitRejected: number;
  totalDurationMs: number;
};

export class AiClientError extends Error {
  constructor(
    message: string,
    public readonly code: "disabled" | "timeout" | "http" | "invalid_response" | "circuit_open" | "network",
    public readonly options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "AiClientError";
  }
}

export type StructuredAiRequest<T> = {
  operation: string;
  settings: ForwardxAiSettings;
  systemPrompt: string;
  userText: string;
  schema: ZodType<T>;
  maxTokens?: number;
};

type AiClientOptions = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  transientRetries?: number;
  circuitFailureThreshold?: number;
  circuitFailureWindowMs?: number;
  circuitOpenMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type CircuitState = {
  failures: number;
  windowStartedAt: number;
  openUntil: number;
};

const TRANSIENT_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RESPONSE_FORMAT_UNSUPPORTED_STATUS = new Set([400, 404, 415, 422]);

function emptyMetrics(): AiClientMetrics {
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    retries: 0,
    compatibilityFallbacks: 0,
    circuitRejected: 0,
    totalDurationMs: 0,
  };
}

function extractJsonObject(content: string) {
  const trimmed = String(content || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) {
      try {
        return JSON.parse(fenced);
      } catch {
        // Continue with the object fallback below.
      }
    }
    const object = trimmed.match(/\{[\s\S]*\}/)?.[0];
    if (!object) return null;
    try {
      return JSON.parse(object);
    } catch {
      return null;
    }
  }
}

export class ForwardxAiClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly transientRetries: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitFailureWindowMs: number;
  private readonly circuitOpenMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly circuits = new Map<string, CircuitState>();
  private metrics = emptyMetrics();

  constructor(options: AiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = Math.max(10, Math.floor(options.timeoutMs || 12_000));
    this.transientRetries = Math.max(0, Math.min(2, Math.floor(options.transientRetries ?? 1)));
    this.circuitFailureThreshold = Math.max(1, Math.floor(options.circuitFailureThreshold || 3));
    this.circuitFailureWindowMs = Math.max(1_000, Math.floor(options.circuitFailureWindowMs || 60_000));
    this.circuitOpenMs = Math.max(1_000, Math.floor(options.circuitOpenMs || 30_000));
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  getMetrics() {
    return { ...this.metrics };
  }

  resetForTest() {
    this.circuits.clear();
    this.metrics = emptyMetrics();
  }

  private circuitKey(settings: ForwardxAiSettings) {
    return `${settings.provider}:${settings.chatCompletionsUrl}:${settings.model}`;
  }

  private ensureCircuitClosed(key: string) {
    const state = this.circuits.get(key);
    if (!state) return;
    const now = this.now();
    if (state.openUntil > now) {
      this.metrics.circuitRejected += 1;
      throw new AiClientError("AI 服务暂时不可用，请稍后重试", "circuit_open", { retryable: true });
    }
    if (state.openUntil > 0 || now - state.windowStartedAt > this.circuitFailureWindowMs) {
      this.circuits.delete(key);
    }
  }

  private recordFailure(key: string) {
    const now = this.now();
    const previous = this.circuits.get(key);
    const state = !previous || now - previous.windowStartedAt > this.circuitFailureWindowMs
      ? { failures: 0, windowStartedAt: now, openUntil: 0 }
      : previous;
    state.failures += 1;
    if (state.failures >= this.circuitFailureThreshold) state.openUntil = now + this.circuitOpenMs;
    this.circuits.set(key, state);
  }

  private recordSuccess(key: string) {
    this.circuits.delete(key);
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AiClientError("AI 请求超时", "timeout", { retryable: true });
      }
      throw new AiClientError(error instanceof Error ? error.message : "AI 网络请求失败", "network", { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  async requestStructuredJson<T>(request: StructuredAiRequest<T>): Promise<T> {
    const { settings } = request;
    if (!settings.enabled || !settings.apiKey) {
      throw new AiClientError("AI 助手未启用或未配置 API Key", "disabled");
    }

    const key = this.circuitKey(settings);
    this.ensureCircuitClosed(key);
    const startedAt = this.now();
    const deadline = startedAt + this.timeoutMs;
    this.metrics.requests += 1;
    let includeResponseFormat = true;
    let transientAttempt = 0;

    try {
      while (true) {
        const remainingMs = deadline - this.now();
        if (remainingMs <= 0) throw new AiClientError("AI 请求超时", "timeout", { retryable: true });
        const body: Record<string, unknown> = {
          model: settings.model,
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.userText.slice(0, 500) },
          ],
          temperature: 0,
          max_tokens: Math.min(512, Math.max(128, Math.floor(request.maxTokens || settings.maxTokens || 1024))),
        };
        if (includeResponseFormat) body.response_format = { type: "json_object" };

        const response = await this.fetchWithTimeout(settings.chatCompletionsUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify(body),
        }, remainingMs);

        if (!response.ok) {
          const responseText = await response.text().catch(() => "");
          if (includeResponseFormat && RESPONSE_FORMAT_UNSUPPORTED_STATUS.has(response.status)) {
            includeResponseFormat = false;
            this.metrics.compatibilityFallbacks += 1;
            continue;
          }
          if (TRANSIENT_HTTP_STATUS.has(response.status) && transientAttempt < this.transientRetries && deadline - this.now() > 500) {
            transientAttempt += 1;
            this.metrics.retries += 1;
            await this.sleep(Math.min(250 * transientAttempt, Math.max(0, deadline - this.now() - 100)));
            continue;
          }
          throw new AiClientError(
            `AI HTTP ${response.status}${responseText ? `: ${responseText.slice(0, 160)}` : ""}`,
            "http",
            { status: response.status, retryable: TRANSIENT_HTTP_STATUS.has(response.status) },
          );
        }

        const payload = await response.json().catch(() => null) as any;
        const content = String(payload?.choices?.[0]?.message?.content || "");
        const parsedJson = extractJsonObject(content);
        const validated = request.schema.safeParse(parsedJson);
        if (!validated.success) {
          throw new AiClientError("AI 返回的结构不符合 ForwardX Skill 定义", "invalid_response");
        }
        this.recordSuccess(key);
        this.metrics.successes += 1;
        return validated.data;
      }
    } catch (error) {
      const clientError = error instanceof AiClientError
        ? error
        : new AiClientError(error instanceof Error ? error.message : "AI 请求失败", "network", { retryable: true });
      if (clientError.code === "timeout") this.metrics.timeouts += 1;
      this.metrics.failures += 1;
      this.recordFailure(key);
      throw clientError;
    } finally {
      this.metrics.totalDurationMs += Math.max(0, this.now() - startedAt);
    }
  }
}

export const forwardxAiClient = new ForwardxAiClient();
