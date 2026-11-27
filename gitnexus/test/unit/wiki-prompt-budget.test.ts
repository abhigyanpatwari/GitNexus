import { describe, it, expect } from 'vitest';
import {
  TRUNCATION_NOTICE,
  capLines,
  clipToTokens,
  estimateTokensSafe,
  fitSectionsToBudget,
  minContextWindow,
  promptTokenBudget,
} from '../../src/core/wiki/prompt-budget.js';

describe('promptTokenBudget', () => {
  it('reserves the completion, system prompt and a safety margin', () => {
    const budget = promptTokenBudget(131_072, 16_384, 'x'.repeat(300));
    expect(budget).toBeLessThan(131_072 - 16_384);
    expect(budget).toBeGreaterThan(100_000);
  });

  it('throws instead of returning a budget that cannot fit the window', () => {
    expect(() => promptTokenBudget(8_000, 16_384)).toThrow(
      'Context window (8000 tokens) is too small',
    );
    expect(() => promptTokenBudget(8_000, 2_000, 'x'.repeat(3_000))).toThrow('too small');
  });

  it('accepts the smallest window minContextWindow allows', () => {
    expect(promptTokenBudget(minContextWindow(16_384), 16_384)).toBe(4_000);
  });
});

describe('clipToTokens', () => {
  it('leaves short text alone', () => {
    expect(clipToTokens('short', 100)).toBe('short');
  });

  it('cuts long text to the budget and marks the cut', () => {
    const clipped = clipToTokens('a'.repeat(10_000), 500);
    expect(estimateTokensSafe(clipped)).toBeLessThanOrEqual(500);
    expect(clipped.endsWith(TRUNCATION_NOTICE)).toBe(true);
  });

  it('stays within budgets too small for the notice', () => {
    expect(clipToTokens('a'.repeat(1_000), 0)).toBe('');
    const tiny = clipToTokens('a'.repeat(1_000), 5);
    expect(estimateTokensSafe(tiny)).toBeLessThanOrEqual(5);
  });
});

describe('fitSectionsToBudget', () => {
  it('returns sections unchanged when they already fit', () => {
    const sections = ['one', 'two'];
    expect(fitSectionsToBudget(sections, 1_000)).toEqual(sections);
  });

  it('keeps small sections intact and clips only the large ones', () => {
    const small = 'small section';
    const big = 'b'.repeat(30_000);
    const fitted = fitSectionsToBudget([small, big, big], 3_000);
    expect(fitted[0]).toBe(small);
    const total = fitted.reduce((sum, s) => sum + estimateTokensSafe(s), 0);
    expect(total).toBeLessThanOrEqual(3_000);
  });

  it('bounds the total for many sections', () => {
    const sections = Array.from({ length: 500 }, (_, i) => `#### m${i}\n${'x'.repeat(2_000)}`);
    const fitted = fitSectionsToBudget(sections, 20_000);
    expect(fitted).toHaveLength(500);
    expect(fitted.reduce((sum, s) => sum + estimateTokensSafe(s), 0)).toBeLessThanOrEqual(20_000);
  });

  it('bounds the total when each share is smaller than the truncation notice', () => {
    const sections = Array.from({ length: 500 }, () => 'y'.repeat(300));
    const fitted = fitSectionsToBudget(sections, 2_000);
    expect(fitted.reduce((sum, s) => sum + estimateTokensSafe(s), 0)).toBeLessThanOrEqual(2_000);
  });
});

describe('capLines', () => {
  it('keeps the first lines and reports how many were omitted', () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n');
    expect(capLines(text, 3)).toBe('l0\nl1\nl2\n... (7 more omitted)');
    expect(capLines('a\nb', 3)).toBe('a\nb');
  });
});
