/**
 * Provider & Model Pricing Estimation
 *
 * Approximate per-1M-token USD pricing for supported cloud models.
 * Returns null for unrecognized custom/OpenRouter models so the UI never
 * fabricates misleading dollar amounts.
 */

import type { LLMProvider, TokenUsage } from './types';

export interface ModelPricing {
  /** USD cost per 1,000,000 input tokens */
  inputPerMillion: number;
  /** USD cost per 1,000,000 output tokens */
  outputPerMillion: number;
}

const ZERO_PRICING: ModelPricing = { inputPerMillion: 0, outputPerMillion: 0 };

/**
 * Longest-prefix-first lookup table of approximate published USD rates per 1M tokens.
 */
const MODEL_PRICING_PREFIXES: ReadonlyArray<readonly [string, ModelPricing]> = [
  // OpenAI
  ['gpt-4o-mini', { inputPerMillion: 0.15, outputPerMillion: 0.6 }],
  ['gpt-4o', { inputPerMillion: 2.5, outputPerMillion: 10.0 }],
  ['gpt-4.5-preview', { inputPerMillion: 75.0, outputPerMillion: 150.0 }],
  ['gpt-4-turbo', { inputPerMillion: 10.0, outputPerMillion: 30.0 }],
  ['gpt-4', { inputPerMillion: 30.0, outputPerMillion: 60.0 }],
  ['gpt-3.5-turbo', { inputPerMillion: 0.5, outputPerMillion: 1.5 }],
  ['gpt-35-turbo', { inputPerMillion: 0.5, outputPerMillion: 1.5 }],
  ['o3-mini', { inputPerMillion: 1.1, outputPerMillion: 4.4 }],
  ['o1-mini', { inputPerMillion: 1.1, outputPerMillion: 4.4 }],
  ['o1', { inputPerMillion: 15.0, outputPerMillion: 60.0 }],

  // Google Gemini
  ['gemini-2.0-flash', { inputPerMillion: 0.1, outputPerMillion: 0.4 }],
  ['gemini-1.5-flash', { inputPerMillion: 0.075, outputPerMillion: 0.3 }],
  ['gemini-1.5-pro', { inputPerMillion: 1.25, outputPerMillion: 5.0 }],
  ['gemini-1.0-pro', { inputPerMillion: 0.5, outputPerMillion: 1.5 }],

  // Anthropic Claude
  ['claude-sonnet-4', { inputPerMillion: 3.0, outputPerMillion: 15.0 }],
  ['claude-3-5-sonnet', { inputPerMillion: 3.0, outputPerMillion: 15.0 }],
  ['claude-3.5-sonnet', { inputPerMillion: 3.0, outputPerMillion: 15.0 }],
  ['claude-3-5-haiku', { inputPerMillion: 0.8, outputPerMillion: 4.0 }],
  ['claude-3.5-haiku', { inputPerMillion: 0.8, outputPerMillion: 4.0 }],
  ['claude-3-opus', { inputPerMillion: 15.0, outputPerMillion: 75.0 }],

  // DeepSeek
  ['deepseek-reasoner', { inputPerMillion: 0.55, outputPerMillion: 2.19 }],
  ['deepseek-chat', { inputPerMillion: 0.27, outputPerMillion: 1.1 }],
  ['deepseek-v4-pro', { inputPerMillion: 0.55, outputPerMillion: 2.19 }],
  ['deepseek-v4-flash', { inputPerMillion: 0.14, outputPerMillion: 0.28 }],

  // MiniMax
  ['minimax-m3', { inputPerMillion: 0.3, outputPerMillion: 1.2 }],
  ['minimax-m2.7', { inputPerMillion: 0.2, outputPerMillion: 0.8 }],

  // GLM (Z.AI)
  ['glm-5-turbo', { inputPerMillion: 0.25, outputPerMillion: 1.0 }],
  ['glm-5', { inputPerMillion: 0.5, outputPerMillion: 2.0 }],
  ['glm-4.7', { inputPerMillion: 0.3, outputPerMillion: 1.2 }],
  ['glm-4.5', { inputPerMillion: 0.2, outputPerMillion: 0.8 }],
];

const VERSION_SUFFIX_RE = /^(?:\d+(?:-\d+)*|latest)$/;

const isMatchingModelPrefix = (normalized: string, prefix: string): boolean => {
  if (normalized === prefix) return true;
  if (normalized.startsWith(`${prefix}-`) || normalized.startsWith(`${prefix}:`)) {
    const suffix = normalized.slice(prefix.length + 1);
    return VERSION_SUFFIX_RE.test(suffix);
  }
  return false;
};

const normalizeModelName = (model: string): string => {
  const trimmed = model.trim().toLowerCase();
  const slashIdx = trimmed.lastIndexOf('/');
  return slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
};

/**
 * Resolve approximate USD pricing for a provider/model pair.
 * Local Ollama runs return zero cost; unknown models or distinct uncatalogued
 * variants return null.
 */
export const getModelPricing = (provider: LLMProvider, model: string): ModelPricing | null => {
  if (provider === 'ollama') {
    return ZERO_PRICING;
  }

  const normalized = normalizeModelName(model);
  if (!normalized) return null;

  for (const [prefix, pricing] of MODEL_PRICING_PREFIXES) {
    if (isMatchingModelPrefix(normalized, prefix)) {
      return pricing;
    }
  }

  return null;
};

/**
 * Calculate estimated USD cost for the given token usage.
 * Returns null if pricing is unavailable for the provider/model.
 */
export const estimateCostUsd = (
  provider: LLMProvider,
  model: string,
  usage: TokenUsage,
): number | null => {
  const pricing = getModelPricing(provider, model);
  if (!pricing) return null;

  const inputCost = (Math.max(0, usage.inputTokens) / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (Math.max(0, usage.outputTokens) / 1_000_000) * pricing.outputPerMillion;
  return inputCost + outputCost;
};

export const formatCostUsd = (costUsd: number): string => {
  if (costUsd === 0) return '$0.00';
  if (costUsd < 0.0001) return '<$0.0001';
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
};

export const formatTokenCount = (tokens: number): string => {
  const safe = Math.max(0, Math.round(tokens));
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(2)}M`;
  if (safe >= 10_000) return `${(safe / 1_000).toFixed(1)}k`;
  return safe.toLocaleString('en-US');
};
