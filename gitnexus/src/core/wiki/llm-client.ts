/**
 * LLM Client for Wiki Generation
 *
 * OpenAI-compatible API client using native fetch.
 * Supports OpenAI, Azure, LiteLLM, Ollama, and any OpenAI-compatible endpoint.
 * Falls back to locally installed CLI (claude/codex) when no API key is configured.
 *
 * Config priority: CLI flags > env vars > defaults
 */

import { spawn as nodeSpawn } from 'child_process';
import { isCLIAvailable } from '../../lib/cli.js';

export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
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

  const apiKey = overrides?.apiKey
    || process.env.GITNEXUS_API_KEY
    || process.env.OPENAI_API_KEY
    || savedConfig.apiKey
    || '';

  return {
    apiKey,
    baseUrl: overrides?.baseUrl
      || process.env.GITNEXUS_LLM_BASE_URL
      || savedConfig.baseUrl
      || 'https://openrouter.ai/api/v1',
    model: overrides?.model
      || process.env.GITNEXUS_MODEL
      || savedConfig.model
      || 'minimax/minimax-m2.5',
    maxTokens: overrides?.maxTokens ?? 16_384,
    temperature: overrides?.temperature ?? 0,
  };
}

/**
 * Estimate token count from text (rough heuristic: ~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Detect which CLI tool is available locally.
 */
function detectCLI(): 'claude' | 'codex' | null {
  for (const tool of ['claude', 'codex'] as const) {
    if (isCLIAvailable(tool)) return tool;
  }
  return null;
}

/**
 * Call LLM via locally installed CLI (claude or codex).
 * No API key required — CLI handles auth.
 */
async function callLLMViaCLI(
  prompt: string,
  systemPrompt?: string,
  cliTool?: 'claude' | 'codex',
): Promise<LLMResponse> {
  const tool = cliTool || detectCLI();
  if (!tool) {
    throw new Error('No CLI tool found. Install "claude" or "codex", or provide an API key.');
  }

  let args: string[];
  if (tool === 'claude') {
    args = ['-p', prompt, '--output-format', 'text', '--no-session-persistence'];
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }
  } else {
    args = ['--quiet', '--full-auto', '--', prompt];
  }

  // Strip all Claude Code env vars to avoid "nested session" detection
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE')) delete env[key];
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (fn: () => void) => { if (!finished) { finished = true; fn(); } };

    const child = nodeSpawn(tool, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });

    child.on('close', (code) => done(() => {
      if (code !== 0) {
        reject(new Error(`CLI "${tool}" exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      const content = stdout.trim();
      if (!content) {
        reject(new Error(`CLI "${tool}" returned empty output`));
        return;
      }
      resolve({ content });
    }));

    child.on('error', (err) => done(() => {
      reject(new Error(`Failed to spawn "${tool}": ${err.message}`));
    }));
  });
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
  // CLI fallback when no API key is configured
  if (!config.apiKey || config.apiKey.trim() === '') {
    return callLLMViaCLI(prompt, systemPrompt);
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const useStream = !!options?.onChunk;

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
  };
  if (useStream) body.stream = true;

  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error');

        // Rate limit — wait with exponential backoff and retry
        if (response.status === 429 && attempt < MAX_RETRIES - 1) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
          const delay = retryAfter > 0 ? retryAfter * 1000 : (2 ** attempt) * 3000;
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

      // Streaming path
      if (useStream && response.body) {
        return await readSSEStream(response.body, options!.onChunk!);
      }

      // Non-streaming path
      const json = await response.json() as any;
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
      if (attempt < MAX_RETRIES - 1 && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.message?.includes('fetch'))) {
        await sleep((attempt + 1) * 3000);
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error('LLM call failed after retries');
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
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          onChunk(content.length);
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  if (!content) {
    throw new Error('LLM returned empty streaming response');
  }

  return { content };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
