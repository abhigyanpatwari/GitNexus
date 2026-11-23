import { logger } from '../logger.js';
import { CircuitOpenError, ResilientFetchExhaustedError, resilientFetch } from 'gitnexus-shared';
/**
 * LLM Client for Wiki Generation
 *
 * OpenAI-compatible API client using native fetch.
 * Supports MiniMax and other OpenAI-compatible endpoints, and the Anthropic
 * Messages API natively (provider 'anthropic').
 *
 * Config priority: CLI flags > env vars > defaults
 */

export type LLMProvider =
  | 'openai'
  | 'openrouter'
  | 'azure'
  | 'custom'
  | 'cursor'
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'grok'
  | 'minimax'
  | 'anthropic';

export const MINIMAX_OPENAI_BASE_URLS = {
  global_en: 'https://api.minimax.io/v1',
  cn_zh: 'https://api.minimaxi.com/v1',
} as const;

export const MINIMAX_MODEL_IDS = ['MiniMax-M3', 'MiniMax-M2.7'] as const;

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
/** `anthropic-version` header sent with every Messages API request. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

export type MiniMaxThinkingMode = 'adaptive' | 'disabled' | 'always_on';

export type LLMUserContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | {
          type: 'image_url';
          image_url: {
            url: string;
            detail?: 'low' | 'default' | 'high';
            max_long_side_pixel?: number;
          };
        }
      | {
          type: 'video_url';
          video_url: {
            url: string;
            detail?: 'low' | 'default' | 'high';
            fps?: number;
            max_long_side_pixel?: number;
          };
        }
    >;

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
  /** When true, strips sampling params and uses max_completion_tokens instead of max_tokens */
  isReasoningModel?: boolean;
  /** Per-attempt fetch timeout in ms. Omit to disable request timeouts. */
  requestTimeoutMs?: number;
  /** Max fetch attempts before giving up (default: 3). */
  maxAttempts?: number;
  /** Exact hostnames allowed for explicit http:// LLM endpoints. */
  allowedInsecureHttpHosts?: readonly string[];
}

export interface LLMResponse {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
}

export function resolveMiniMaxThinkingMode(
  model: string,
  reasoningOverride?: boolean,
): MiniMaxThinkingMode | undefined {
  if (model === MINIMAX_MODEL_IDS[1]) return 'always_on';
  if (model === MINIMAX_MODEL_IDS[0]) {
    return reasoningOverride === false ? 'disabled' : 'adaptive';
  }
  return undefined;
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
  const hasLegacyHttpConfig = !savedConfig.provider && !!(savedConfig.model || savedConfig.baseUrl);
  const savedProvider =
    overrides?.provider ?? savedConfig.provider ?? (hasLegacyHttpConfig ? 'openai' : 'minimax');
  const reuseSavedHttpConfig =
    savedConfig.provider === savedProvider || (hasLegacyHttpConfig && savedProvider === 'openai');
  const savedLocalModel =
    savedProvider === 'cursor'
      ? savedConfig.cursorModel
      : savedProvider === 'claude'
        ? savedConfig.claudeModel
        : savedProvider === 'codex'
          ? savedConfig.codexModel
          : savedProvider === 'opencode'
            ? savedConfig.opencodeModel
            : savedProvider === 'grok'
              ? savedConfig.grokModel
              : undefined;
  const localProvider =
    savedProvider === 'cursor' ||
    savedProvider === 'claude' ||
    savedProvider === 'codex' ||
    savedProvider === 'opencode' ||
    savedProvider === 'grok';

  const apiKey =
    overrides?.apiKey ||
    (savedProvider === 'minimax' ? process.env.MINIMAX_API_KEY : undefined) ||
    (savedProvider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : undefined) ||
    (savedProvider !== 'minimax' ? process.env.GITNEXUS_API_KEY : undefined) ||
    (savedProvider !== 'minimax' && savedProvider !== 'anthropic'
      ? process.env.OPENAI_API_KEY
      : undefined) ||
    (reuseSavedHttpConfig ? savedConfig.apiKey : undefined) ||
    '';

  return {
    apiKey,
    baseUrl:
      overrides?.baseUrl ||
      process.env.GITNEXUS_LLM_BASE_URL ||
      (reuseSavedHttpConfig ? savedConfig.baseUrl : undefined) ||
      (savedProvider === 'minimax'
        ? MINIMAX_OPENAI_BASE_URLS.global_en
        : savedProvider === 'anthropic'
          ? ANTHROPIC_BASE_URL
          : 'https://openrouter.ai/api/v1'),
    model:
      overrides?.model ||
      (localProvider ? undefined : process.env.GITNEXUS_MODEL) ||
      savedLocalModel ||
      (localProvider
        ? ''
        : (reuseSavedHttpConfig ? savedConfig.model : undefined) ||
          (savedProvider === 'minimax'
            ? MINIMAX_MODEL_IDS[0]
            : savedProvider === 'anthropic'
              ? ANTHROPIC_DEFAULT_MODEL
              : '')),
    maxTokens:
      readOverrideMaxCompletionTokens(overrides?.maxTokens) ??
      readEnvMaxCompletionTokens(process.env[LLM_MAX_COMPLETION_TOKENS_ENV]) ??
      readConfiguredMaxCompletionTokens(savedConfig.maxCompletionTokens) ??
      DEFAULT_MAX_COMPLETION_TOKENS,
    temperature: overrides?.temperature ?? 0,
    provider: savedProvider,
    apiVersion:
      overrides?.apiVersion ||
      (savedProvider === 'azure' ? process.env.GITNEXUS_AZURE_API_VERSION : undefined) ||
      (reuseSavedHttpConfig ? savedConfig.apiVersion : undefined),
    isReasoningModel:
      overrides?.isReasoningModel ??
      (reuseSavedHttpConfig ? savedConfig.isReasoningModel : undefined),
    allowedInsecureHttpHosts:
      overrides?.allowedInsecureHttpHosts ??
      parseLLMAllowedInsecureHttpHosts(process.env[LLM_ALLOW_INSECURE_CONNECTION_ENV]),
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

export const LLM_ALLOW_INSECURE_CONNECTION_ENV = 'GITNEXUS_ALLOW_INSECURE_CONNECTION';
export const LLM_MAX_COMPLETION_TOKENS_ENV = 'GITNEXUS_MAX_COMPLETION_TOKENS';
export const DEFAULT_MAX_COMPLETION_TOKENS = 16_384;

function readOverrideMaxCompletionTokens(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('--max-completion-tokens must be a positive integer');
  }
  return value;
}

function readEnvMaxCompletionTokens(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`${LLM_MAX_COMPLETION_TOKENS_ENV} must be a positive integer`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== trimmed) {
    throw new Error(`${LLM_MAX_COMPLETION_TOKENS_ENV} is too large`);
  }
  return parsed;
}

function readConfiguredMaxCompletionTokens(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('maxCompletionTokens in ~/.gitnexus/config.json must be a positive integer');
  }
  return value;
}

function normalizeAllowedInsecureHttpHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  const fail = () => {
    throw new Error(
      `--allow-insecure-connection / ${LLM_ALLOW_INSECURE_CONNECTION_ENV} entries must be exact hostnames or IP addresses`,
    );
  };
  if (!trimmed || /[/@?#]/.test(trimmed)) fail();

  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) fail();
    const normalized = trimmed.slice(1, -1);
    if (!normalized || /[\[\]]/.test(normalized)) fail();
    return normalized;
  }

  if (/[\[\]]/.test(trimmed)) fail();
  if ((trimmed.match(/:/g)?.length ?? 0) === 1) {
    // URL.hostname never includes the port, so accepting "host:port" would
    // create a confusing no-op allowlist entry.
    fail();
  }
  return trimmed;
}

export function parseLLMAllowedInsecureHttpHosts(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return [...new Set(value.split(',').map(normalizeAllowedInsecureHttpHost))];
}

/**
 * Validate that a base URL supplied for LLM API calls is a safe HTTP/HTTPS
 * endpoint (CWE-918 / CodeQL js/http-to-file-access).
 *
 * Allowed:
 *  - https:// with any hostname (public LLM APIs, Azure, OpenRouter, …)
 *  - http:// restricted to localhost / 127.0.0.1 (local servers: Ollama, LiteLLM, …)
 *  - http:// to exact hosts explicitly allowlisted for LAN/self-hosted LLMs
 *
 * Rejected:
 *  - file://, data:, javascript:, and any other non-HTTP scheme
 *  - http:// aimed at non-loopback hosts unless explicitly allowlisted
 *    (avoids SSRF against internal networks by default)
 *
 * Throws with a descriptive message on validation failure so callers surface a
 * clear error rather than an opaque network error.
 */
export function validateLLMBaseUrl(
  baseUrl: string,
  allowedInsecureHttpHosts: readonly string[] = parseLLMAllowedInsecureHttpHosts(
    process.env[LLM_ALLOW_INSECURE_CONNECTION_ENV],
  ),
): void {
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
    const allowedHosts = new Set(allowedInsecureHttpHosts.map(normalizeAllowedInsecureHttpHost));
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && !allowedHosts.has(host)) {
      // Use parsed.origin (scheme+host+port, no credentials) instead of the full URL.
      throw new Error(
        `Insecure http:// LLM base URLs are only allowed for localhost/127.0.0.1 ` +
          `or hosts listed by --allow-insecure-connection / ${LLM_ALLOW_INSECURE_CONNECTION_ENV}. ` +
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
 * Build the Anthropic Messages API URL.
 */
export function buildAnthropicMessagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/messages`;
}

/**
 * Call the configured LLM: an OpenAI-compatible chat completions API, or the
 * Anthropic Messages API when provider is 'anthropic'.
 * Uses streaming when onChunk callback is provided for real-time progress.
 * Retries up to 3 times on transient failures (429, 5xx, network errors).
 */
export async function callLLM(
  prompt: LLMUserContent,
  config: LLMConfig,
  systemPrompt?: string,
  options?: CallLLMOptions,
): Promise<LLMResponse> {
  // Validate base URL before any fetch (CodeQL js/http-to-file-access)
  validateLLMBaseUrl(config.baseUrl, config.allowedInsecureHttpHosts);

  const anthropic = config.provider === 'anthropic';
  // Detect Azure endpoint (by provider field or URL pattern)
  const azure = !anthropic && (config.provider === 'azure' || isAzureProvider(config.baseUrl));
  const useStream = !!options?.onChunk;

  const { url, headers, body } = anthropic
    ? buildAnthropicRequest(prompt, config, systemPrompt, useStream)
    : buildChatCompletionsRequest(prompt, config, systemPrompt, useStream, azure);

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
          ...headers,
        },
        body: JSON.stringify(body),
        // Fetch preserves x-api-key across origins. Only send credentials and
        // source code to the configured endpoint, never a redirect destination.
        ...(anthropic ? { redirect: 'manual' as const } : {}),
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
    return await readSSEStream(
      response.body,
      options!.onChunk!,
      config.maxTokens,
      anthropic ? anthropicStream : chatCompletionsStream,
    );
  }

  // Non-streaming path
  const json = (await response.json()) as any;
  if (anthropic) {
    return readAnthropicMessage(json as AnthropicMessage | null, config.maxTokens);
  }
  const choice = json.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw truncatedResponseError(config.maxTokens, chatCompletionsStream.truncationReason);
  }
  if (!choice?.message?.content) {
    throw new Error('LLM returned empty response');
  }

  return {
    content: choice.message.content,
    promptTokens: json.usage?.prompt_tokens,
    completionTokens: json.usage?.completion_tokens,
  };
}

interface LLMRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function buildChatCompletionsRequest(
  prompt: LLMUserContent,
  config: LLMConfig,
  systemPrompt: string | undefined,
  useStream: boolean,
  azure: boolean,
): LLMRequest {
  const messages: Array<{ role: string; content: LLMUserContent }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  // Warn when using Azure legacy deployment URL without api-version
  if (azure && !config.apiVersion && config.baseUrl.includes('/deployments/')) {
    logger.warn(
      '[gitnexus] Warning: Azure legacy deployment URL detected but no api-version set. Add --api-version 2024-10-21 or use the v1 API format.',
    );
  }

  const miniMaxThinkingMode =
    config.provider === 'minimax'
      ? resolveMiniMaxThinkingMode(config.model, config.isReasoningModel)
      : undefined;

  // Detect reasoning models or explicit provider-specific thinking configuration.
  const reasoning = miniMaxThinkingMode
    ? miniMaxThinkingMode !== 'disabled'
    : isReasoningModel(config.model, config.isReasoningModel);

  const url = buildRequestUrl(config.baseUrl, azure ? config.apiVersion : undefined);

  // Build request body — reasoning models reject temperature and use max_completion_tokens
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
  };

  if (miniMaxThinkingMode === 'adaptive' || miniMaxThinkingMode === 'disabled') {
    body.thinking = { type: miniMaxThinkingMode };
  }
  if (config.provider === 'minimax') {
    body.reasoning_split = true;
  }

  // max_tokens is deprecated; use max_completion_tokens for all models
  body.max_completion_tokens = config.maxTokens;

  // Only send temperature for non-Azure providers — some Azure models reject non-default values
  if (!reasoning && !azure && config.temperature !== undefined) {
    body.temperature = config.temperature;
  }

  if (useStream) body.stream = true;

  // Build auth headers — Azure uses api-key header, everyone else uses Authorization: Bearer
  const headers: Record<string, string> = azure
    ? { 'api-key': config.apiKey }
    : { Authorization: `Bearer ${config.apiKey}` };

  return { url, headers, body };
}

/**
 * Messages API request. The system prompt is a top-level field, and no sampling
 * parameter is sent: current Claude models reject temperature, and the wiki's
 * temperature 0 is an OpenAI-path default, not a user setting.
 */
function buildAnthropicRequest(
  prompt: LLMUserContent,
  config: LLMConfig,
  systemPrompt: string | undefined,
  useStream: boolean,
): LLMRequest {
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens,
    messages: [{ role: 'user', content: toAnthropicContent(prompt) }],
  };
  if (systemPrompt) body.system = systemPrompt;
  if (useStream) body.stream = true;

  return {
    url: buildAnthropicMessagesUrl(config.baseUrl),
    headers: { 'x-api-key': config.apiKey, 'anthropic-version': ANTHROPIC_API_VERSION },
    body,
  };
}

const ANTHROPIC_IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/;

function toAnthropicContent(prompt: LLMUserContent): string | Array<Record<string, unknown>> {
  if (typeof prompt === 'string') return prompt;
  return prompt.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') {
      const dataUrl = ANTHROPIC_IMAGE_DATA_URL.exec(part.image_url.url);
      if (dataUrl) {
        return {
          type: 'image',
          source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] },
        };
      }
      if (/^https:\/\//i.test(part.image_url.url)) {
        return { type: 'image', source: { type: 'url', url: part.image_url.url } };
      }
      throw new Error(
        'The anthropic provider accepts images as https:// URLs or base64 PNG, JPEG, GIF or WebP data URLs',
      );
    }
    throw new Error('The anthropic provider does not accept video input');
  });
}

/** The fields of a Messages API response the wiki reads. */
interface AnthropicMessage {
  content?: Array<{ type?: string; text?: unknown }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function readAnthropicMessage(json: AnthropicMessage | null, maxTokens: number): LLMResponse {
  if (json?.stop_reason === 'max_tokens') {
    throw truncatedResponseError(maxTokens, anthropicStream.truncationReason);
  }
  if (json?.stop_reason === 'refusal') {
    throw anthropicRefusalError();
  }
  if (json?.stop_reason === 'model_context_window_exceeded') {
    throw anthropicContextWindowError();
  }
  // Thinking blocks come back alongside the answer; only text blocks are the page.
  const content = Array.isArray(json?.content)
    ? json.content
        .map((block) =>
          block?.type === 'text' && typeof block.text === 'string' ? block.text : '',
        )
        .join('')
    : '';
  if (!content) {
    throw new Error('LLM returned empty response');
  }
  return {
    content,
    promptTokens: json?.usage?.input_tokens,
    completionTokens: json?.usage?.output_tokens,
  };
}

function anthropicRefusalError(): Error {
  return new Error(
    'The model declined this request (stop_reason "refusal"). Adjust the prompt or use another model.',
  );
}

function anthropicContextWindowError(): Error {
  return new Error(
    'LLM response reached the context window limit (stop_reason "model_context_window_exceeded") and is incomplete. Reduce the input size or use a model with a larger context window.',
  );
}

// A response cut off by the completion limit reads like a finished one, and a
// reasoning model can spend the whole limit before the answer starts.
function truncatedResponseError(maxTokens: number, stopReason: string): Error {
  return new Error(
    `LLM response stopped at the completion token limit (${maxTokens}, ${stopReason}) and is incomplete.`,
  );
}

/** What one SSE `data:` payload adds to the response being streamed. */
interface StreamEvent {
  text?: string;
  /** Set when the provider stopped for a reason that makes the answer unusable. */
  stop?: 'length' | 'content_filter' | 'refusal' | 'context_window';
  complete?: boolean;
}

/** How one provider's stream is read. */
interface StreamProtocol {
  /**
   * Reads one parsed `data:` payload. Returns undefined for payloads that carry
   * neither text nor a stop reason; throws on a stream error.
   */
  readEvent: (data: unknown) => StreamEvent | undefined;
  /** The provider's own name for a stop at the token limit, quoted in the error. */
  truncationReason: string;
  /** When set, EOF before this terminal event means the response is incomplete. */
  completionEvent?: string;
}

/** OpenAI-compatible chat completions chunks. */
/** The fields of a chat completions stream chunk the wiki reads. */
interface ChatCompletionsChunk {
  choices?: Array<{ finish_reason?: string | null; delta?: { content?: string | null } }>;
}

/** The fields of an Anthropic stream event the wiki reads. */
interface AnthropicStreamPayload {
  type?: string;
  delta?: { type?: string; text?: unknown; stop_reason?: string | null };
  error?: { type?: string; message?: string };
}

const chatCompletionsStream: StreamProtocol = {
  readEvent: (payload) => {
    const choice = (payload as ChatCompletionsChunk | null)?.choices?.[0];
    // A content-filtered chunk's delta is dropped.
    if (choice?.finish_reason === 'content_filter') return { stop: 'content_filter' };
    const text = choice?.delta?.content;
    return {
      text: text || undefined,
      stop: choice?.finish_reason === 'length' ? 'length' : undefined,
    };
  },
  truncationReason: 'finish_reason "length"',
};

/** Anthropic Messages API events. Thinking deltas are not part of the answer. */
const anthropicStream: StreamProtocol = {
  readEvent: (payload) => {
    const data = payload as AnthropicStreamPayload | null;
    switch (data?.type) {
      case 'content_block_delta':
        return data.delta?.type === 'text_delta' && typeof data.delta.text === 'string'
          ? { text: data.delta.text }
          : undefined;
      case 'message_delta':
        if (data.delta?.stop_reason === 'max_tokens') return { stop: 'length' };
        if (data.delta?.stop_reason === 'refusal') return { stop: 'refusal' };
        if (data.delta?.stop_reason === 'model_context_window_exceeded') {
          return { stop: 'context_window' };
        }
        return undefined;
      case 'message_stop':
        return { complete: true };
      case 'error':
        throw new Error(
          `LLM API error mid-stream: ${data.error?.type ?? 'error'}: ${data.error?.message ?? 'no message'}`,
        );
      default:
        return undefined;
    }
  },
  truncationReason: 'stop_reason "max_tokens"',
  completionEvent: 'message_stop',
};

/**
 * Read an SSE stream, letting the provider's protocol say what each `data:`
 * payload contributes.
 */
async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (charsReceived: number) => void,
  maxTokens: number,
  protocol: StreamProtocol,
): Promise<LLMResponse> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let content = '';
  let buffer = '';
  let contentFilterTriggered = false;
  let lengthLimitReached = false;
  let refused = false;
  let contextWindowExceeded = false;
  let complete = false;

  try {
    stream: while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trimStart();
        if (data === '[DONE]') continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Skip malformed SSE chunks
          continue;
        }

        const event = protocol.readEvent(parsed);
        if (event?.stop === 'content_filter') contentFilterTriggered = true;
        if (event?.stop === 'length') lengthLimitReached = true;
        if (event?.stop === 'refusal') refused = true;
        if (event?.stop === 'context_window') contextWindowExceeded = true;
        if (event?.text) {
          content += event.text;
          onChunk(content.length);
        }
        if (event?.complete) {
          complete = true;
          break stream;
        }
      }
    }
  } finally {
    // Release the HTTP response on protocol errors and terminal events, too.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  if (contentFilterTriggered) {
    throw new Error(
      'content filter triggered mid-stream. The generated content was blocked by content policy. Adjust your prompt and retry.',
    );
  }

  if (refused) {
    throw anthropicRefusalError();
  }

  if (lengthLimitReached) {
    throw truncatedResponseError(maxTokens, protocol.truncationReason);
  }

  if (contextWindowExceeded) {
    throw anthropicContextWindowError();
  }

  if (protocol.completionEvent && !complete) {
    throw new Error(`LLM stream ended before ${protocol.completionEvent} and is incomplete.`);
  }

  if (!content) {
    throw new Error('LLM returned empty streaming response');
  }

  return { content };
}
