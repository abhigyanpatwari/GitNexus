import { describe, it, expect } from 'vitest';
import {
  TRUNCATION_NOTICE,
  capLines,
  clipToTokens,
  estimateTokensSafe,
  fitSectionsToBudget,
  promptTokenBudget,
} from '../../src/core/wiki/prompt-budget.js';

describe('promptTokenBudget', () => {
  it('reserves the completion, system prompt and a safety margin', () => {
    const budget = promptTokenBudget(131_072, 16_384, 'x'.repeat(300));
    expect(budget).toBeLessThan(131_072 - 16_384);
    expect(budget).toBeGreaterThan(100_000);
  });

  it('never drops below a floor, even when the completion exceeds the window', () => {
    expect(promptTokenBudget(8_000, 16_384)).toBeGreaterThan(0);
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
});

describe('capLines', () => {
  it('keeps the first lines and reports how many were omitted', () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n');
    expect(capLines(text, 3)).toBe('l0\nl1\nl2\n... (7 more omitted)');
    expect(capLines('a\nb', 3)).toBe('a\nb');
  });
});
