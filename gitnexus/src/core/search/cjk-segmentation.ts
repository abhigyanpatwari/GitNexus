/**
 * CJK bigram segmentation for FTS search (#2331)
 *
 * LadybugDB's bundled FTS tokenizer splits only on the space character, so a
 * contiguous CJK (Chinese/Japanese/Korean) span indexes as one giant token and
 * sub-phrase queries never match. `segmentCjkSpans` addresses the Han-ideograph
 * case (Chinese text and Japanese Kanji — see scope note below) by rewriting
 * each contiguous run of CJK Unified Ideographs into space-separated overlapping character
 * bigrams (`采购订单` -> `采购 购订 订单`), the same technique MySQL's `ngram`
 * fulltext parser, Elasticsearch's `cjk` analyzer, and Lucene's
 * `CJKBigramFilter` use by default. For any exact contiguous substring query
 * of length >= 2, its bigram decomposition is a subset of the source text's
 * bigram decomposition, so sub-phrase matching works without needing a
 * dictionary or boundary-alignment luck.
 *
 * Scoped to the core CJK Unified Ideographs block (U+4E00-U+9FFF) only —
 * covers Chinese text and Japanese Kanji. Hiragana, Katakana, and Hangul
 * Syllables are deliberately excluded for now (see plan Scope Boundaries);
 * extend `CJK_UNIFIED_IDEOGRAPHS` below if that need arises.
 */

/** The core CJK Unified Ideographs block — single source of truth for both regexes below. */
const CJK_UNIFIED_IDEOGRAPHS = '[\\u4e00-\\u9fff]';
const CJK_CHAR_RE = new RegExp(CJK_UNIFIED_IDEOGRAPHS);
const CJK_RUN_RE = new RegExp(`${CJK_UNIFIED_IDEOGRAPHS}{2,}`, 'g');
const WHITESPACE_RE = /\s/;

/**
 * Worst-case output/input byte ratio for `segmentCjkSpans` on an all-CJK run:
 * each adjacent character pair becomes a 2-character bigram plus a 1-byte
 * separator, i.e. ~7 output bytes per 3 input bytes of UTF-8 CJK text (each
 * CJK character is 3 bytes). Single source of truth — imported by both the
 * CSV-flush safety-margin test (`csv-pipeline.test.ts`) and the growth-factor
 * regression guard (`cjk-segmentation.test.ts`), and referenced by name in
 * `csv-generator.ts`'s `FLUSH_BYTES` margin comment, so all three stay in
 * sync if the algorithm's expansion ratio ever changes.
 */
export const CJK_BIGRAM_WORST_CASE_GROWTH_FACTOR = 7 / 3;

/**
 * True if `text` contains at least one CJK Unified Ideograph. Callers use
 * this to warn when a query looks like it could benefit from
 * `GITNEXUS_FTS_CJK_SEGMENTATION=bigram` but the resolved mode is `none`.
 */
export const containsCjkIdeograph = (text: string): boolean => CJK_CHAR_RE.test(text);

/**
 * Rewrite contiguous CJK spans in `text` into space-separated overlapping
 * bigrams (a run of exactly 2 chars becomes a single bigram; a lone CJK
 * char has no possible pairing and passes through unchanged). Non-CJK text
 * is never touched by `replace` in the first place, so a run's boundary
 * spacing is decided by peeking at the *original* string's neighboring
 * character (via the callback's `offset`/`full` args) rather than tracking
 * state across matches — each match stays independent even when two CJK
 * runs sit close together, and a space is added only when the neighbor
 * isn't already whitespace, so the whitespace-splitting FTS tokenizer
 * treats runs as separate tokens (`ERP审批流程` -> `ERP 审批 批流 流程`,
 * not `ERP审批 批流 流程`).
 */
export const segmentCjkSpans = (text: string): string =>
  text.replace(CJK_RUN_RE, (run: string, offset: number, full: string) => {
    const bigrams: string[] = [];
    for (let i = 0; i < run.length - 1; i++) bigrams.push(run.slice(i, i + 2));

    const before = full[offset - 1];
    const after = full[offset + run.length];
    const leadingSpace = before !== undefined && !WHITESPACE_RE.test(before) ? ' ' : '';
    const trailingSpace = after !== undefined && !WHITESPACE_RE.test(after) ? ' ' : '';
    return leadingSpace + bigrams.join(' ') + trailingSpace;
  });

// ============================================================================
// GITNEXUS_FTS_CJK_SEGMENTATION — env var validation and the segmentation gate
// ============================================================================

/**
 * Modes shipped by this plan. Deliberately does not include a `'jieba'`
 * value: LadybugDB's native `tokenizer := 'jieba'` parameter FATAL-crashes
 * the process without a bundled dictionary (no such dictionary ships with
 * `@ladybugdb/core`), and `QUERY_FTS_INDEX` has no way to apply it to a query
 * string anyway — see the plan's Key Technical Decision 1. Stubbing an
 * unimplemented option here would misrepresent it as available.
 */
const SUPPORTED_FTS_CJK_SEGMENTATION_MODES = new Set<string>(['none', 'bigram']);

export const DEFAULT_FTS_CJK_SEGMENTATION = 'none';

let resolvedCjkSegmentation: string | undefined;

/** Read + validate `GITNEXUS_FTS_CJK_SEGMENTATION`. Throws on an unsupported value. */
function resolveFTSCjkSegmentation(): string {
  const raw = process.env.GITNEXUS_FTS_CJK_SEGMENTATION?.trim().toLowerCase();
  if (!raw) return DEFAULT_FTS_CJK_SEGMENTATION;
  if (SUPPORTED_FTS_CJK_SEGMENTATION_MODES.has(raw)) return raw;

  throw new Error(
    `Invalid GITNEXUS_FTS_CJK_SEGMENTATION "${process.env.GITNEXUS_FTS_CJK_SEGMENTATION}". ` +
      `Expected one of: ${[...SUPPORTED_FTS_CJK_SEGMENTATION_MODES].sort().join(', ')}.`,
  );
}

/**
 * Resolve + validate `GITNEXUS_FTS_CJK_SEGMENTATION` once, up front at analyze
 * startup, and cache it — mirrors `initialiseSearchFTSStemmer` so an invalid
 * value fails in milliseconds instead of partway through a run. The cached
 * value is what {@link getSearchFTSCjkSegmentation} returns for the rest of
 * the run, so config is read and validated in exactly one place.
 */
export function initialiseSearchFTSCjkSegmentation(): string {
  resolvedCjkSegmentation = resolveFTSCjkSegmentation();
  return resolvedCjkSegmentation;
}

/**
 * Return the mode resolved by {@link initialiseSearchFTSCjkSegmentation}.
 * Falls back to resolving on demand when init was never called (read-only
 * hosts, unit tests) so validation always applies.
 */
export function getSearchFTSCjkSegmentation(): string {
  return resolvedCjkSegmentation ?? resolveFTSCjkSegmentation();
}

/**
 * The single entry point the write path (`csv-generator.ts`) and read path
 * (`bm25-index.ts`) both call, so indexed text and query text are always
 * segmented identically. No-ops when the resolved mode is `none` (default).
 */
export const applyCjkSegmentationIfEnabled = (text: string): string =>
  getSearchFTSCjkSegmentation() === 'bigram' ? segmentCjkSpans(text) : text;
