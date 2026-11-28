import { describe, expect, it } from 'vitest';
import {
  getModelPricing,
  estimateCostUsd,
  formatCostUsd,
  formatTokenCount,
} from '../../src/core/llm/pricing';

describe('pricing utilities', () => {
  it('resolves known cloud model pricing including versioned and prefixed IDs', () => {
    expect(getModelPricing('openai', 'gpt-4o')).toEqual({
      inputPerMillion: 2.5,
      outputPerMillion: 10.0,
    });
    expect(getModelPricing('openai', 'gpt-4o-mini-2024-07-18')).toEqual({
      inputPerMillion: 0.15,
      outputPerMillion: 0.6,
    });
    expect(getModelPricing('openrouter', 'anthropic/claude-3.5-sonnet')).toEqual({
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
    });
  });

  it('returns zero pricing for Ollama and null for unknown models or distinct variants', () => {
    expect(getModelPricing('ollama', 'qwen3-coder:30b')).toEqual({
      inputPerMillion: 0,
      outputPerMillion: 0,
    });
    expect(getModelPricing('gemini', 'gemini-2.0-flash-001')).toEqual({
      inputPerMillion: 0.1,
      outputPerMillion: 0.4,
    });
    expect(getModelPricing('gemini', 'gemini-2.0-flash-lite')).toBeNull();
    expect(getModelPricing('openrouter', 'custom-org/gpt-4o')).toBeNull();
    expect(getModelPricing('openrouter', 'anthropic/gpt-4o')).toBeNull();
    expect(getModelPricing('openai', 'my-custom-finetune')).toBeNull();
  });

  it('estimates USD cost accurately from input and output token counts', () => {
    const cost = estimateCostUsd('openai', 'gpt-4o', {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      totalTokens: 1_500_000,
    });
    expect(cost).toBeCloseTo(7.5, 6);

    expect(
      estimateCostUsd('ollama', 'llama3.2', {
        inputTokens: 5000,
        outputTokens: 2000,
        totalTokens: 7000,
      }),
    ).toBe(0);

    expect(
      estimateCostUsd('openrouter', 'unknown/model-x', {
        inputTokens: 5000,
        outputTokens: 2000,
        totalTokens: 7000,
      }),
    ).toBeNull();

    // Paid cloud model reporting only totalTokens without input/output breakdown cannot be priced as $0
    expect(
      estimateCostUsd('openai', 'gpt-4o', {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 500,
      }),
    ).toBeNull();
  });

  it('formats token counts and USD costs readably', () => {
    expect(formatTokenCount(420)).toBe('420');
    expect(formatTokenCount(1500)).toBe('1,500');
    expect(formatTokenCount(12_500)).toBe('12.5k');
    expect(formatTokenCount(1_250_000)).toBe('1.25M');

    expect(formatCostUsd(0)).toBe('$0.00');
    expect(formatCostUsd(0.00005)).toBe('<$0.0001');
    expect(formatCostUsd(0.0042)).toBe('$0.0042');
    expect(formatCostUsd(1.234)).toBe('$1.23');
  });
});
