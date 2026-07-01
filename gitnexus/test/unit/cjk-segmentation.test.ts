import { describe, expect, it } from 'vitest';
import { segmentCjkSpans } from '../../src/core/search/cjk-segmentation.js';

describe('segmentCjkSpans', () => {
  it('segments a pure CJK phrase into overlapping bigrams', () => {
    // Issue #2331's own example: "purchase order automatic approval process"
    expect(segmentCjkSpans('采购订单自动审批流程')).toBe(
      '采购 购订 订单 单自 自动 动审 审批 批流 流程',
    );
  });

  it('inserts a boundary space between a non-CJK run and a CJK run', () => {
    expect(segmentCjkSpans('ERP审批流程')).toBe('ERP 审批 批流 流程');
  });

  it('leaves an exactly-2-character CJK run as the single unchanged bigram', () => {
    expect(segmentCjkSpans('审批')).toBe('审批');
  });

  it('leaves a single CJK character unchanged (no bigram possible)', () => {
    expect(segmentCjkSpans('审')).toBe('审');
  });

  it('does not produce a bigram spanning punctuation between two CJK runs', () => {
    const result = segmentCjkSpans('你好。世界');
    // The punctuation mark resets the run on both sides, so no two-character
    // token may fuse a pre-punctuation and post-punctuation character.
    expect(result).not.toContain('好。');
    expect(result).not.toContain('。世');
    expect(result).toBe('你好 。 世界');
  });

  it('passes pure ASCII/Latin text through unchanged (idempotent no-op)', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    expect(segmentCjkSpans(text)).toBe(text);
  });

  it('returns an empty string unchanged', () => {
    expect(segmentCjkSpans('')).toBe('');
  });

  it('does not double an existing whitespace boundary between scripts', () => {
    expect(segmentCjkSpans('ERP 审批')).toBe('ERP 审批');
  });

  it('matches the ~7n/3-bytes-per-input-byte growth-factor formula for long CJK runs', () => {
    // Implementation Unit 3's CSV-flush margin math depends on this ratio —
    // a silent change to the expansion factor should fail this test loudly.
    const cjkChar = '采';
    const n = 10_000;
    const input = cjkChar.repeat(n);
    const inputBytes = Buffer.byteLength(input, 'utf8');
    const output = segmentCjkSpans(input);
    const outputBytes = Buffer.byteLength(output, 'utf8');
    const expectedBytes = (7 * inputBytes) / 3;
    expect(outputBytes).toBeGreaterThan(expectedBytes * 0.95);
    expect(outputBytes).toBeLessThan(expectedBytes * 1.05);
  });
});
