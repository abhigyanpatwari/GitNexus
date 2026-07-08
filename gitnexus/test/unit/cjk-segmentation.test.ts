import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyCjkSegmentationIfEnabled,
  CJK_BIGRAM_WORST_CASE_GROWTH_FACTOR,
  cjkSegmentationModeMismatch,
  containsCjkIdeograph,
  containsSegmentableCjkRun,
  getSearchFTSCjkSegmentation,
  initialiseSearchFTSCjkSegmentation,
  segmentCjkSpans,
} from '../../src/core/search/cjk-segmentation.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it('does not double an existing whitespace boundary in the reverse direction', () => {
    expect(segmentCjkSpans('流程 ERP')).toBe('流程 ERP');
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
    const expectedBytes = inputBytes * CJK_BIGRAM_WORST_CASE_GROWTH_FACTOR;
    expect(outputBytes).toBeGreaterThan(expectedBytes * 0.95);
    expect(outputBytes).toBeLessThan(expectedBytes * 1.05);
  });

  it('scales linearly on realistic interleaved CJK/non-CJK content, not quadratically', () => {
    // Regression guard: an earlier implementation indexed into the growing
    // accumulated output string once per run boundary, which forces V8 to
    // flatten its internal rope representation on every access — O(n^2) on
    // content that alternates CJK and non-CJK runs (ordinary source code
    // with inline CJK comments, the feature's actual target). A single-run
    // input (like the growth-factor test above) never exercises this path,
    // since there is only one run boundary regardless of size.
    const unit = '采购订单自动审批流程 // approve the request after manual review\n';
    const build = (totalBytes: number) => unit.repeat(Math.ceil(totalBytes / unit.length));

    const small = build(64 * 1024);
    const large = build(512 * 1024); // 8x the input size

    const timeOf = (input: string) => {
      const start = performance.now();
      segmentCjkSpans(input);
      return performance.now() - start;
    };

    // Warm up the JIT before measuring either size.
    timeOf(small);
    timeOf(large);

    const smallMs = timeOf(small);
    const largeMs = timeOf(large);

    // Linear scaling means ~8x input takes roughly ~8x time, with headroom
    // for noise; quadratic scaling would mean ~64x time. 20x catches the
    // regression while tolerating CI timing variance.
    expect(largeMs).toBeLessThan(Math.max(smallMs, 1) * 20);
  });
});

describe('containsCjkIdeograph', () => {
  it('returns true for a CJK Unified Ideograph, including a single character', () => {
    expect(containsCjkIdeograph('审')).toBe(true);
    expect(containsCjkIdeograph('采购订单自动审批流程')).toBe(true);
  });

  it('returns false for Hiragana', () => {
    expect(containsCjkIdeograph('あ')).toBe(false);
  });

  it('returns false for Katakana', () => {
    expect(containsCjkIdeograph('ア')).toBe(false);
  });

  it('returns false for Hangul Syllables', () => {
    expect(containsCjkIdeograph('가')).toBe(false);
  });

  it('returns false for plain ASCII/Latin text', () => {
    expect(containsCjkIdeograph('hello world')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(containsCjkIdeograph('')).toBe(false);
  });
});

describe('containsSegmentableCjkRun', () => {
  it('returns false for a single CJK character (no possible pairing)', () => {
    expect(containsSegmentableCjkRun('审')).toBe(false);
  });

  it('returns true for a 2+-character contiguous CJK run', () => {
    expect(containsSegmentableCjkRun('审批')).toBe(true);
    expect(containsSegmentableCjkRun('采购订单自动审批流程')).toBe(true);
  });

  it('returns false for non-CJK text', () => {
    expect(containsSegmentableCjkRun('hello world')).toBe(false);
  });

  it('is not stateful across repeated calls on the same input (regression guard)', () => {
    // A prior implementation called .test() on the shared, global-flagged
    // CJK_RUN_RE directly, which mutates lastIndex between calls and
    // alternates true/false/true on repeated calls with the same string.
    const text = '审批流程';
    expect(containsSegmentableCjkRun(text)).toBe(true);
    expect(containsSegmentableCjkRun(text)).toBe(true);
    expect(containsSegmentableCjkRun(text)).toBe(true);
  });
});

// NOTE ON ORDERING: `getSearchFTSCjkSegmentation`'s on-demand fallback only
// applies while the module-level cache is still unset. The describe blocks
// below are ordered so every test relying on that fallback (via `vi.stubEnv`)
// runs before `initialiseSearchFTSCjkSegmentation`'s "caches" test, which
// permanently sets the cache for the rest of this file — mirrors the same
// ordering constraint in fts-indexes.test.ts's sibling suite.

describe('getSearchFTSCjkSegmentation', () => {
  it('defaults to none when unset', () => {
    expect(getSearchFTSCjkSegmentation()).toBe('none');
  });

  it('normalizes a configured mode (case-insensitive, trimmed)', () => {
    vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', ' Bigram ');
    expect(getSearchFTSCjkSegmentation()).toBe('bigram');
  });

  it('throws on an unsupported value, listing valid options', () => {
    vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'jieba');
    expect(() => getSearchFTSCjkSegmentation()).toThrow('Invalid GITNEXUS_FTS_CJK_SEGMENTATION');
    expect(() => getSearchFTSCjkSegmentation()).toThrow('bigram, none');
  });
});

describe('applyCjkSegmentationIfEnabled', () => {
  it('is a no-op when the resolved mode is none (default)', () => {
    const text = '采购订单自动审批流程';
    expect(applyCjkSegmentationIfEnabled(text)).toBe(text);
  });

  it('delegates to segmentCjkSpans when the resolved mode is bigram', () => {
    vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'bigram');
    expect(applyCjkSegmentationIfEnabled('审批流程')).toBe(segmentCjkSpans('审批流程'));
  });
});

describe('initialiseSearchFTSCjkSegmentation', () => {
  it('throws on an unsupported value without poisoning the cache', () => {
    vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'jieba');
    expect(() => initialiseSearchFTSCjkSegmentation()).toThrow(
      'Invalid GITNEXUS_FTS_CJK_SEGMENTATION',
    );
  });

  it('resolves once so later reads ignore a changed env', () => {
    vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'bigram');
    expect(initialiseSearchFTSCjkSegmentation()).toBe('bigram');

    vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'none');
    expect(getSearchFTSCjkSegmentation()).toBe('bigram');
  });
});

describe('cjkSegmentationModeMismatch (#2331/#2339)', () => {
  it('legacy meta (no recorded stamp) + default live mode → no mismatch', () => {
    expect(cjkSegmentationModeMismatch(undefined, 'none')).toBe(false);
  });

  it('legacy meta + bigram live mode → mismatch (feature newly enabled)', () => {
    expect(cjkSegmentationModeMismatch(undefined, 'bigram')).toBe(true);
  });

  it('recorded bigram + live none → mismatch (on→off flip)', () => {
    expect(cjkSegmentationModeMismatch('bigram', 'none')).toBe(true);
  });

  it('recorded bigram + live bigram → no mismatch (unchanged)', () => {
    expect(cjkSegmentationModeMismatch('bigram', 'bigram')).toBe(false);
  });
});
