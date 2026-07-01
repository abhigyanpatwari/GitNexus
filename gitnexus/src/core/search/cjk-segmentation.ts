/**
 * CJK bigram segmentation for FTS search (#2331)
 *
 * LadybugDB's bundled FTS tokenizer splits only on the space character, so a
 * contiguous CJK (Chinese/Japanese/Korean) span indexes as one giant token and
 * sub-phrase queries never match. `segmentCjkSpans` rewrites each contiguous
 * run of CJK Unified Ideographs into space-separated overlapping character
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
 * add their ranges to `isCjkIdeograph` if that need arises.
 */

const CJK_UNIFIED_IDEOGRAPHS_START = 0x4e00;
const CJK_UNIFIED_IDEOGRAPHS_END = 0x9fff;

const isCjkIdeograph = (codePoint: number): boolean =>
  codePoint >= CJK_UNIFIED_IDEOGRAPHS_START && codePoint <= CJK_UNIFIED_IDEOGRAPHS_END;

const isWhitespace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/** A run of one script class (CJK or not), in original order. */
interface ScriptRun {
  readonly isCjk: boolean;
  readonly chars: readonly string[];
}

const splitIntoRuns = (chars: readonly string[]): ScriptRun[] => {
  const runs: { isCjk: boolean; chars: string[] }[] = [];
  for (const ch of chars) {
    const isCjk = isCjkIdeograph(ch.codePointAt(0) ?? 0);
    const last = runs[runs.length - 1];
    if (last && last.isCjk === isCjk) {
      last.chars.push(ch);
    } else {
      runs.push({ isCjk, chars: [ch] });
    }
  }
  return runs;
};

/** Overlapping two-character windows, space-joined. A run of 0-1 chars has no bigram, so it is returned unchanged. */
const renderCjkRun = (chars: readonly string[]): string => {
  if (chars.length < 2) return chars.join('');
  const bigrams: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) {
    bigrams.push(chars[i] + chars[i + 1]);
  }
  return bigrams.join(' ');
};

/**
 * Rewrite contiguous CJK spans in `text` into space-separated overlapping
 * bigrams. Non-CJK runs (Latin, digits, punctuation, existing whitespace)
 * pass through unchanged. A single space is inserted at a CJK/non-CJK run
 * boundary when neither side already ends/starts with whitespace, so the
 * whitespace-splitting FTS tokenizer treats the two runs as separate tokens
 * (`ERP审批流程` -> `ERP 审批 批流 流程`, not `ERP审批 批流 流程`).
 */
export const segmentCjkSpans = (text: string): string => {
  const chars = Array.from(text);
  if (chars.length === 0) return text;

  const runs = splitIntoRuns(chars);
  const rendered = runs.map((run) => (run.isCjk ? renderCjkRun(run.chars) : run.chars.join('')));

  let result = rendered[0] ?? '';
  for (let i = 1; i < rendered.length; i++) {
    const next = rendered[i];
    const needsSeparator = !isWhitespace(result[result.length - 1]) && !isWhitespace(next[0]);
    result += (needsSeparator ? ' ' : '') + next;
  }
  return result;
};
