/**
 * Cross-Lingual Query Translation
 *
 * Detects non-English queries and translates them to English code keywords
 * using an LLM (OpenAI-compatible API: OpenRouter, Ollama, etc.)
 *
 * Opt-in via `smart: true` parameter on the query tool.
 * Reuses the existing LLM client from wiki generation.
 *
 * Addresses: https://github.com/abhigyanpatwari/GitNexus/issues/160
 */

import { resolveLLMConfig, callLLM, type LLMConfig } from '../wiki/llm-client.js';

/** Simple cache to avoid repeated LLM calls for the same query */
const translationCache = new Map<string, string>();
const CACHE_MAX_SIZE = 200;

/**
 * Detect if a query is primarily non-ASCII (likely non-English).
 * Returns true if >30% of non-whitespace characters are non-ASCII.
 */
export function isNonEnglishQuery(query: string): boolean {
  const chars = query.replace(/\s/g, '');
  if (chars.length === 0) return false;
  const nonAscii = chars.replace(/[\x00-\x7F]/g, '').length;
  return nonAscii / chars.length > 0.3;
}

/**
 * Translate a non-English query to English code keywords.
 * Uses the same LLM config as wiki generation (env vars, ~/.gitnexus/config.json).
 *
 * @param query - The original non-English query
 * @param configOverrides - Optional LLM config overrides
 * @returns English keyword translation, or original query if translation fails
 */
export async function translateQuery(
  query: string,
  configOverrides?: Partial<LLMConfig>,
): Promise<{ translated: string; original: string; wasTranslated: boolean }> {
  // Check cache first
  const cached = translationCache.get(query);
  if (cached) {
    return { translated: cached, original: query, wasTranslated: true };
  }

  try {
    const config = await resolveLLMConfig({
      maxTokens: 200,
      temperature: 0,
      ...configOverrides,
    });

    if (!config.apiKey) {
      // No LLM configured — return original query
      return { translated: query, original: query, wasTranslated: false };
    }

    const result = await callLLM(
      query,
      config,
      `You are a code search query translator. The user gives you a query in any language about code/software concepts. Translate it into English code keywords that would match function names, class names, variable names, and file names in a codebase.

Rules:
- Output ONLY the English keywords, space-separated
- Use common programming naming conventions (snake_case, camelCase fragments)
- Include both full words and common abbreviations
- Do NOT explain, do NOT add quotes or punctuation
- Keep it concise: 3-8 keywords maximum

Examples:
- "收盘评分链可靠性改进" → "closing score pipeline reliability signal scorer"
- "ユーザー認証フロー" → "user authentication auth flow login validate"
- "데이터베이스 연결 풀링" → "database connection pool db connect"`,
    );

    const translated = result.content.trim();

    // Cache the result
    if (translationCache.size >= CACHE_MAX_SIZE) {
      // Evict oldest entry
      const firstKey = translationCache.keys().next().value;
      if (firstKey) translationCache.delete(firstKey);
    }
    translationCache.set(query, translated);

    return { translated, original: query, wasTranslated: true };
  } catch {
    // Translation failed — fall back to original query silently
    return { translated: query, original: query, wasTranslated: false };
  }
}

/**
 * Process a query with optional cross-lingual translation.
 * If smart=true and the query is non-English, translates first.
 * Returns both the search query to use and metadata about translation.
 */
export async function processSmartQuery(
  query: string,
  smart: boolean,
  configOverrides?: Partial<LLMConfig>,
): Promise<{ searchQuery: string; original: string; wasTranslated: boolean }> {
  if (!smart || !isNonEnglishQuery(query)) {
    return { searchQuery: query, original: query, wasTranslated: false };
  }
  const result = await translateQuery(query, configOverrides);
  return { searchQuery: result.translated, original: result.original, wasTranslated: result.wasTranslated };
}
