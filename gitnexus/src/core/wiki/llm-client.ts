import { logger } from '../logger.js';
import { CircuitOpenError, ResilientFetchExhaustedError, resilientFetch } from 'gitnexus-shared';
/**
 * LLM Client for Wiki Generation
 *
 * OpenAI-compatible API client using native fetch.
 * Supports OpenAI, Azure, LiteLLM, Ollama, and any OpenAI-compatible endpoint.
 *
 * Config priority: CLI flags > env vars > defaults
 */

export type LLMProvider = 'openai' | 'openrouter' | 'azure' | 'custom' | 'cursor';

export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /** Provider type — controls auth header behaviour */
  provider?: 'openai' | 'openrouter' | 'azure' | 'custom' | 'cursor';
  /** Azure api-version query param (e.g. '2024-10-21'). Appended to URL when set. */
  apiVersion?: string;
  /** When true, strips sampling params and uses max_completion_tokens instead of max_tokens */
  isReasoningModel?: boolean;
  /** Per-attempt fetch timeout in ms. Omit to disable request timeouts. */
  requestTimeoutMs?: number;
  /** Max fetch attempts before giving up (default: 3). */
  maxAttempts?: number;
}

export interface LLMResponse {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Resolve LLM configuration from env vars, saved config, and optional overrides.
 * Priority: overrides (CLI flags) > env vars > ~/.gitnexus/config.json > error
 *
 * If no API key is found, returns config with empty apiKey (caller should handle).
 */
export async function resolveLLMConfig(overrides?: Partial<LLMConfig>): Promise<LLMConfig> {
  const { loadCLIConfig } = await import('../../storage/repo-manager.js');
  const savedConfig = await loadCLIConfig();

  const apiKey =
    overrides?.apiKey ||
    process.env.GITNEXUS_API_KEY ||
    process.env.OPENAI_API_KEY ||
    savedConfig.apiKey ||
    '';

  return {
    apiKey,
    baseUrl:
      overrides?.baseUrl ||
      process.env.GITNEXUS_LLM_BASE_URL ||
      savedConfig.baseUrl ||
      'https://openrouter.ai/api/v1',
    model:
      overrides?.model ||
      process.env.GITNEXUS_MODEL ||
      (savedConfig.provider === 'cursor' ? savedConfig.cursorModel : undefined) ||
      savedConfig.model ||
      'minimax/minimax-m2.5',
    maxTokens: overrides?.maxTokens ?? 16_384,
    temperature: overrides?.temperature ?? 0,
    provider: overrides?.provider ?? savedConfig.provider ?? 'openai',
    apiVersion:
      overrides?.apiVersion || process.env.GITNEXUS_AZURE_API_VERSION || savedConfig.apiVersion,
    isReasoningModel: overrides?.isReasoningModel ?? savedConfig.isReasoningModel,
  };
}

/**
 * Estimate token count from text (rough heuristic: ~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatTimeoutDuration(timeoutMs: number): string {
  if (timeoutMs >= 1000 && timeoutMs % 1000 === 0) {
    return `${timeoutMs / 1000}s`;
  }
  return `${timeoutMs}ms`;
}

function isTimeoutLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  return /time(d)?\s*out|timeout/i.test(err.message);
}

/**
 * Validate that a base URL supplied for LLM API calls is a safe HTTP/HTTPS
 * endpoint (CWE-918 / CodeQL js/http-to-file-access).
 *
 * Allowed:
 *  - https:// with any hostname (public LLM APIs, Azure, OpenRouter, …)
 *  - http:// restricted to localhost / 127.0.0.1 (local servers: Ollama, LiteLLM, …)
 *
 * Rejected:
 *  - file://, data:, javascript:, and any other non-HTTP scheme
 *  - http:// aimed at non-loopback hosts (avoids SSRF against internal networks)
 *
 * Throws with a descriptive message on validation failure so callers surface a
 * clear error rather than an opaque network error.
 */
export function validateLLMBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // Do not include the raw input in the message — it may contain credentials.
    throw new Error('Invalid LLM base URL: must be a well-formed http:// or https:// URL');
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    // Use parsed.protocol only (scheme), not the full URL, to avoid leaking credentials.
    throw new Error(`LLM base URL must use http:// or https:// (got ${parsed.protocol})`);
  }

  if (parsed.protocol === 'http:') {
    // Node's URL parser preserves IPv6 brackets in hostname (e.g. "[::1]"),
    // so strip them before comparing to bare address literals.
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      // Use parsed.origin (scheme+host+port, no credentials) instead of the full URL.
      throw new Error(
        `Insecure http:// LLM base URLs are only allowed for localhost/127.0.0.1. ` +
          `Use https:// for remote endpoints (got ${parsed.origin})`,
      );
    }
  }
}

/**
 * Returns true if the given base URL is an Azure OpenAI endpoint.
 * Uses proper hostname matching to avoid spoofed URLs like
 * "https://myresource.openai.azure.com.evil.com/v1".
 */
export function isAzureProvider(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname.endsWith('.openai.azure.com') || hostname.endsWith('.services.ai.azure.com');
  } catch {
    // Malformed URL — refuse to call this Azure rather than fall back to a
    // substring check, which is bypassable by `https://evil.com/?u=.openai.azure.com`
    // (CodeQL js/incomplete-url-substring-sanitization).
    return false;
  }
}

/**
 * Returns true if the model name matches a known reasoning model pattern,
 * or if the explicit override is true.
 * Pass override=false to force non-reasoning even for o-series names.
 */
export function isReasoningModel(model: string, override?: boolean): boolean {
  if (override !== undefined) return override;
  // Match known bare reasoning models (o1, o3) and any o-series with -mini/-preview suffix
  return /^o[1-9]\d*(-mini|-preview)$|^o1$|^o3$/i.test(model);
}

/**
 * Build the full chat completions URL, appending ?api-version when provided.
 */
export function buildRequestUrl(baseUrl: string, apiVersion: string | undefined): string {
  const base = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return apiVersion ? `${base}?api-version=${encodeURIComponent(apiVersion)}` : base;
}

export interface CallLLMOptions {
  onChunk?: (charsReceived: number) => void;
}

/**
 * Call an OpenAI-compatible LLM API.
 * Uses streaming when onChunk callback is provided for real-time progress.
 * Retries up to 3 times on transient failures (429, 5xx, network errors).
 */
export async function callLLM(
  prompt: string,
  config: LLMConfig,
  systemPrompt?: string,
  options?: CallLLMOptions,
): Promise<LLMResponse> {
  // Validate base URL before any fetch (CodeQL js/http-to-file-access)
  validateLLMBaseUrl(config.baseUrl);

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  // Detect Azure endpoint (by provider field or URL pattern)
  const azure = config.provider === 'azure' || isAzureProvider(config.baseUrl);

  // Warn when using Azure legacy deployment URL without api-version
  if (azure && !config.apiVersion && config.baseUrl.includes('/deployments/')) {
    logger.warn(
      '[gitnexus] Warning: Azure legacy deployment URL detected but no api-version set. Add --api-version 2024-10-21 or use the v1 API format.',
    );
  }

  // Detect reasoning model (o1, o3, o4-mini etc.) or explicit override
  const reasoning = isReasoningModel(config.model, config.isReasoningModel);

  const url = buildRequestUrl(config.baseUrl, azure ? config.apiVersion : undefined);
  const useStream = !!options?.onChunk;

  // Build request body — reasoning models reject temperature and use max_completion_tokens
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
  };

  // max_tokens is deprecated; use max_completion_tokens for all models
  body.max_completion_tokens = config.maxTokens;

  // Only send temperature for non-Azure providers — some Azure models reject non-default values
  if (!reasoning && !azure && config.temperature !== undefined) {
    body.temperature = config.temperature;
  }

  if (useStream) body.stream = true;

  // Build auth headers — Azure uses api-key header, everyone else uses Authorization: Bearer
  const authHeaders: Record<string, string> = azure
    ? { 'api-key': config.apiKey }
    : { Authorization: `Bearer ${config.apiKey}` };

  // Network resilience (bounded retries with exponential-backoff jitter,
  // 5xx + 429 + Retry-After handling, in-process circuit breaker on the
  // LLM endpoint) is delegated to resilientFetch. Provider-specific
  // error parsing (Azure content filter, empty-content checks) stays
  // here since it requires response-body inspection.
  let response: Response;
  try {
    response = await resilientFetch(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(body),
        // Request timeout is opt-in for wiki generation. Large local
        // model runs can legitimately take well over a minute, so the
        // default runtime path must not impose a hidden 60s ceiling.
        signal:
          config.requestTimeoutMs !== undefined
            ? AbortSignal.timeout(config.requestTimeoutMs)
            : undefined,
      },
      {
        breakerKey: `wiki-llm-${new URL(url).host}`,
        retry: { maxAttempts: config.maxAttempts ?? 3, baseDelayMs: 2_000, capDelayMs: 30_000 },
      },
    );
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      throw new Error(
        `LLM endpoint circuit open: retry in ${Math.ceil(err.retryAfterMs / 1000)}s. ${err.message}`,
      );
    }
    if (err instanceof ResilientFetchExhaustedError) {
      const errorText = await err.response.text().catch(() => 'unknown error');
      throw new Error(
        `LLM API error (${err.response.status} after retries): ${errorText.slice(0, 500)}`,
      );
    }
    if (config.requestTimeoutMs !== undefined && isTimeoutLikeError(err)) {
      throw new Error(
        `LLM request timed out after ${formatTimeoutDuration(config.requestTimeoutMs)}. ` +
          'Increase --timeout or omit it to disable the request timeout.',
      );
    }
    throw err;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error');

    // Azure content filter — surface a clear message instead of a generic API error.
    if (
      azure &&
      response.status === 400 &&
      (errorText.includes('content_filter') || errorText.includes('ResponsibleAIPolicyViolation'))
    ) {
      throw new Error(
        `Azure content filter blocked this request. The prompt triggered content policy. Details: ${errorText.slice(0, 300)}`,
      );
    }

    // Any other non-OK response here is a terminal 4xx — resilientFetch
    // already retried 5xx/429 to exhaustion and would have thrown above.
    throw new Error(`LLM API error (${response.status}): ${errorText.slice(0, 500)}`);
  }

  // Streaming path
  if (useStream && response.body) {
    return await readSSEStream(response.body, options!.onChunk!);
  }

  // Non-streaming path
  const json = (await response.json()) as any;
  const choice = json.choices?.[0];
  if (!choice?.message?.content) {
    throw new Error('LLM returned empty response');
  }

  return {
    content: choice.message.content,
    promptTokens: json.usage?.prompt_tokens,
    completionTokens: json.usage?.completion_tokens,
  };
}

/**
 * Read an SSE stream from an OpenAI-compatible streaming response.
 */
async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (charsReceived: number) => void,
): Promise<LLMResponse> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let content = '';
  let buffer = '';
  let contentFilterTriggered = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const choice = parsed.choices?.[0];

        // Detect content filter finish reason — skip delta from this chunk
        if (choice?.finish_reason === 'content_filter') {
          contentFilterTriggered = true;
          continue;
        }

        const delta = choice?.delta?.content;
        if (delta) {
          content += delta;
          onChunk(content.length);
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  if (contentFilterTriggered) {
    throw new Error(
      'content filter triggered mid-stream. The generated content was blocked by content policy. Adjust your prompt and retry.',
    );
  }

  if (!content) {
    throw new Error('LLM returned empty streaming response');
  }

  return { content };
}
