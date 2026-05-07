/**
 * LLM Client for Wiki Generation
 *
 * OpenAI-compatible API client using native fetch.
 * Supports OpenAI, Azure, LiteLLM, Ollama, and any OpenAI-compatible endpoint.
 *
 * Config priority: CLI flags > env vars > defaults
 */

export type LLMProvider = 'openai' | 'openrouter' | 'azure' | 'anthropic' | 'custom' | 'cursor';

/** Anthropic API version sent in the `anthropic-version` header. */
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /** Provider type — controls auth header behaviour */
  provider?: LLMProvider;
  /** Azure api-version query param (e.g. '2024-10-21'). Appended to URL when set. */
  apiVersion?: string;
  /** Anthropic API version (e.g. '2023-06-01'). Sent as `anthropic-version` header when provider is 'anthropic'. */
  anthropicVersion?: string;
  /** When true, strips sampling params and uses max_completion_tokens instead of max_tokens */
  isReasoningModel?: boolean;
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
    anthropicVersion:
      overrides?.anthropicVersion ||
      process.env.GITNEXUS_ANTHROPIC_VERSION ||
      savedConfig.anthropicVersion,
    isReasoningModel: overrides?.isReasoningModel ?? savedConfig.isReasoningModel,
  };
}

/**
 * Estimate token count from text (rough heuristic: ~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
    // If URL is malformed, fall back to substring check
    return baseUrl.includes('.openai.azure.com') || baseUrl.includes('.services.ai.azure.com');
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
 * Build the full request URL.
 *
 * - For Anthropic: `${baseUrl}/v1/messages`. The `/v1` segment is auto-prepended when
 *   the base URL lacks any `/vN` version segment, so a user can configure
 *   `https://api.anthropic.com` and still hit the correct endpoint.
 * - For OpenAI-compatible providers: `${baseUrl}/chat/completions`, with optional Azure
 *   `?api-version=` query param when provided.
 */
export function buildRequestUrl(
  baseUrl: string,
  apiVersion: string | undefined,
  provider?: LLMProvider,
): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (provider === 'anthropic') {
    const versioned = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
    return `${versioned}/messages`;
  }
  const base = `${trimmed}/chat/completions`;
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
  const anthropic = config.provider === 'anthropic';
  // Detect Azure endpoint (by provider field or URL pattern). Anthropic short-circuits Azure.
  const azure = !anthropic && (config.provider === 'azure' || isAzureProvider(config.baseUrl));

  // Warn when using Azure legacy deployment URL without api-version
  if (azure && !config.apiVersion && config.baseUrl.includes('/deployments/')) {
    console.warn(
      '[gitnexus] Warning: Azure legacy deployment URL detected but no api-version set. Add --api-version 2024-10-21 or use the v1 API format.',
    );
  }

  // Detect reasoning model (o1, o3, o4-mini etc.) or explicit override
  const reasoning = isReasoningModel(config.model, config.isReasoningModel);

  const url = buildRequestUrl(
    config.baseUrl,
    azure ? config.apiVersion : undefined,
    config.provider,
  );
  const useStream = !!options?.onChunk;

  // Build request body — Anthropic uses a different shape than OpenAI-compatible APIs.
  let body: Record<string, unknown>;
  if (anthropic) {
    body = {
      model: config.model,
      max_tokens: config.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    };
    if (systemPrompt) body.system = systemPrompt;
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (useStream) body.stream = true;
  } else {
    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    body = {
      model: config.model,
      messages,
    };

    // max_tokens is deprecated; use max_completion_tokens for all OpenAI-compatible models
    body.max_completion_tokens = config.maxTokens;

    // Only send temperature for non-Azure providers — some Azure models reject non-default values
    if (!reasoning && !azure && config.temperature !== undefined) {
      body.temperature = config.temperature;
    }

    if (useStream) body.stream = true;
  }

  // Build auth headers — provider determines header style.
  const authHeaders: Record<string, string> = anthropic
    ? {
        'x-api-key': config.apiKey,
        'anthropic-version': config.anthropicVersion || DEFAULT_ANTHROPIC_VERSION,
      }
    : azure
      ? { 'api-key': config.apiKey }
      : { Authorization: `Bearer ${config.apiKey}` };

  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error');

        // Azure content filter — surface a clear message instead of a generic API error
        if (
          azure &&
          response.status === 400 &&
          (errorText.includes('content_filter') ||
            errorText.includes('ResponsibleAIPolicyViolation'))
        ) {
          throw new Error(
            `Azure content filter blocked this request. The prompt triggered content policy. Details: ${errorText.slice(0, 300)}`,
          );
        }

        // Rate limit — wait with exponential backoff and retry
        if (response.status === 429 && attempt < MAX_RETRIES - 1) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
          const delay = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 3000;
          await sleep(delay);
          continue;
        }

        // Server error — retry with backoff
        if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
          await sleep((attempt + 1) * 2000);
          continue;
        }

        throw new Error(`LLM API error (${response.status}): ${errorText.slice(0, 500)}`);
      }

      // Streaming path — same reader, provider-specific event parser
      if (useStream && response.body) {
        const parse = anthropic ? parseAnthropicSSEEvent : parseOpenAISSEEvent;
        return await readSSEStream(response.body, options!.onChunk!, parse);
      }

      // Non-streaming path
      const json = (await response.json()) as any;

      if (anthropic) {
        const text = Array.isArray(json.content)
          ? json.content
              .filter((b: { type: string; text?: string }) => b.type === 'text' && b.text)
              .map((b: { text: string }) => b.text)
              .join('')
          : '';
        if (!text) {
          throw new Error('LLM returned empty response');
        }
        return {
          content: text,
          promptTokens: json.usage?.input_tokens,
          completionTokens: json.usage?.output_tokens,
        };
      }

      const choice = json.choices?.[0];
      if (!choice?.message?.content) {
        throw new Error('LLM returned empty response');
      }

      return {
        content: choice.message.content,
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
      };
    } catch (err: any) {
      lastError = err;

      // Network error — retry with backoff
      if (
        attempt < MAX_RETRIES - 1 &&
        (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.message?.includes('fetch'))
      ) {
        await sleep((attempt + 1) * 3000);
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error('LLM call failed after retries');
}

/**
 * Outcome a provider-specific parser may report for one SSE event.
 *
 * The shared {@link readSSEStream} loop accumulates `delta` text, tracks token
 * counts, throws immediately on `error`, and throws after stream end if a
 * `refusalReason` was set — independent of the wire format.
 */
interface SSEEventResult {
  /** Text fragment to append to the accumulated content. */
  delta?: string;
  /** Prompt/input token count, when reported in this event. */
  inputTokens?: number;
  /** Completion/output token count, when reported in this event. */
  outputTokens?: number;
  /**
   * If set, the stream is treated as refused/blocked: any `delta` on this event
   * is dropped and the reader throws this message after the stream finishes.
   */
  refusalReason?: string;
  /** If set, the reader throws this message immediately. */
  error?: string;
}

type SSEEventParser = (event: any) => SSEEventResult;

/** Parse one OpenAI-compatible streaming event (`choices[].delta.content`). */
function parseOpenAISSEEvent(event: any): SSEEventResult {
  const choice = event?.choices?.[0];
  if (choice?.finish_reason === 'content_filter') {
    return {
      refusalReason:
        'content filter triggered mid-stream. The generated content was blocked by content policy. Adjust your prompt and retry.',
    };
  }
  const delta = choice?.delta?.content;
  return delta ? { delta } : {};
}

/** Parse one Anthropic Messages streaming event (`message_start`/`content_block_delta`/`message_delta`/`error`). */
function parseAnthropicSSEEvent(event: any): SSEEventResult {
  switch (event?.type) {
    case 'message_start':
      return { inputTokens: event.message?.usage?.input_tokens };
    case 'content_block_delta':
      if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        return { delta: event.delta.text };
      }
      return {};
    case 'message_delta': {
      const result: SSEEventResult = {};
      if (event.usage?.output_tokens !== undefined) {
        result.outputTokens = event.usage.output_tokens;
      }
      if (event.delta?.stop_reason === 'refusal') {
        result.refusalReason =
          'Anthropic refused to generate content for this prompt. Adjust your prompt and retry.';
      }
      return result;
    }
    case 'error':
      return {
        error: `Anthropic streaming error: ${event.error?.message || JSON.stringify(event.error)}`,
      };
    default:
      return {};
  }
}

/**
 * Read an SSE stream and accumulate `delta` text returned by the provider-specific
 * `parse` function. Provider differences live entirely in `parse`; the loop, buffer
 * handling, refusal/error semantics, and final response shape are shared.
 */
async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (charsReceived: number) => void,
  parse: SSEEventParser,
): Promise<LLMResponse> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let content = '';
  let buffer = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let refusalReason: string | undefined;

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

      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        // Skip malformed SSE chunks
        continue;
      }

      const result = parse(event);

      if (result.error) throw new Error(result.error);

      if (result.refusalReason) {
        // Latch the first refusal; drop any delta on this event
        refusalReason = refusalReason || result.refusalReason;
        continue;
      }

      if (result.inputTokens !== undefined) inputTokens = result.inputTokens;
      if (result.outputTokens !== undefined) outputTokens = result.outputTokens;

      if (result.delta) {
        content += result.delta;
        onChunk(content.length);
      }
    }
  }

  if (refusalReason) throw new Error(refusalReason);

  if (!content) {
    throw new Error('LLM returned empty streaming response');
  }

  return { content, promptTokens: inputTokens, completionTokens: outputTokens };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
