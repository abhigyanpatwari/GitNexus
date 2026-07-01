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
// Same pattern as CJK_RUN_RE, but WITHOUT the 'g' flag — kept as a separate
// instance deliberately. RegExp.prototype.test() on a global-flagged regex
// is stateful (mutates lastIndex between calls); CJK_RUN_RE only stays safe
// today because its one consumer (segmentCjkSpans) drives it exclusively via
// String.prototype.replace, which always resets matching from index 0. A
// second consumer calling .test() on that same shared instance would leak
// state across calls (and across requests, in a long-lived process).
const CJK_SEGMENTABLE_RUN_RE = new RegExp(`${CJK_UNIFIED_IDEOGRAPHS}{2,}`);
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
 * A real search query is always a short phrase — unlike indexed File content
 * (deliberately uncapped, #2317/#2323), nothing else bounds a query's length
 * before it reaches `segmentCjkSpans`. Without a cap, a pathologically long
 * query string (accidental or adversarial) would pay `segmentCjkSpans`'s
 * per-character allocation cost on every search request. 2000 characters
 * comfortably covers any real natural-language query.
 *
 * Lives here rather than in `bm25-index.ts` (its only other consumer) so
 * `local-backend.ts` can import it statically alongside this module's other
 * symbols — `bm25-index.ts` transitively imports `@ladybugdb/core` (a native
 * binding, via `lbug-adapter.js`), which is exactly the kind of module
 * `local-backend.ts`'s `bm25Search` deliberately dynamic-imports instead of
 * statically (#1489: can fail in sandboxed MCP contexts). A static import of
 * even one constant from `bm25-index.ts` would force that native binding to
 * load at MCP-server startup instead of at first query.
 */
export const MAX_CJK_SEGMENTATION_QUERY_LENGTH = 2000;

/**
 * True if `text` contains at least one CJK Unified Ideograph, including a
 * single character. Generic presence check — for gating the "enable bigram
 * mode" query warning specifically, use {@link containsSegmentableCjkRun}
 * instead (#2339): a lone CJK character can never be bigram-segmented, so
 * this broader check would misleadingly flag queries bigram mode can't help.
 */
export const containsCjkIdeograph = (text: string): boolean => CJK_CHAR_RE.test(text);

/**
 * True if `text` contains a CJK run of 2+ contiguous ideographs —
 * i.e. a span `segmentCjkSpans` can actually bigram-segment. A lone CJK
 * character can never be segmented (no possible pairing), so callers
 * warning "enable bigram mode" for a query should gate on this, not on
 * `containsCjkIdeograph` (#2339). Uses its own non-global RegExp instance
 * (see `CJK_SEGMENTABLE_RUN_RE` above) — never call `.test()` on the
 * shared, global-flagged `CJK_RUN_RE` directly.
 */
export const containsSegmentableCjkRun = (text: string): boolean =>
  CJK_SEGMENTABLE_RUN_RE.test(text);

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

/**
 * True if `value` is one of the recognized segmentation modes. Callers that
 * interpolate a persisted `RepoMeta.cjkSegmentation` value into agent-visible
 * text (e.g. the MCP query-tool's mode-drift warning, #2339) must validate
 * with this first — that field comes from `meta.json`, a schema-less
 * `JSON.parse` of on-disk state inside the analyzed repo, not a trusted
 * input, so an unvalidated value could otherwise be echoed verbatim into
 * tool output an agent is expected to trust and act on.
 */
export const isSupportedCjkSegmentationMode = (value: unknown): value is string =>
  typeof value === 'string' && SUPPORTED_FTS_CJK_SEGMENTATION_MODES.has(value);

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
 * Whether the CJK segmentation mode an index was built under (as persisted in
 * `RepoMeta.cjkSegmentation`) differs from the mode the live process resolves
 * (#2331/#2339) — used by `run-analyze.ts` to force a full rebuild on drift,
 * and by the MCP query path to warn when a repo's index and the serving
 * process disagree. A single scalar, so a plain equality check suffices —
 * unlike `pdgModeMismatch` in `run-analyze.ts`, no key-union comparator is
 * needed. An absent recorded stamp defaults to 'none' (this feature's own
 * default), so a repo that never touched this feature never mismatches.
 * Pure + exported for testing. Lives here (not `run-analyze.ts`) so callers
 * that only need this comparator — e.g. the MCP query path — don't have to
 * pull in the full analyze-pipeline module.
 */
export const cjkSegmentationModeMismatch = (
  recorded: string | undefined,
  resolved: string,
): boolean => (recorded ?? 'none') !== resolved;

/**
 * The single entry point the write path (`csv-generator.ts`) and read path
 * (`bm25-index.ts`) both call, so indexed text and query text are always
 * segmented identically. No-ops when the resolved mode is `none` (default).
 */
export const applyCjkSegmentationIfEnabled = (text: string): string =>
  getSearchFTSCjkSegmentation() === 'bigram' ? segmentCjkSpans(text) : text;
