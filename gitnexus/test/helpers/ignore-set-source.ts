/**
 * Source-parsing extractor for the bare-name sets in `src/config/ignore-service.ts`.
 *
 * Those sets are module-private, and exporting them purely to be testable would
 * widen a production surface to satisfy a test — the same call
 * `receiver-twin-list-drift.test.ts` documents. So the guards read the source
 * text instead, and this helper is the one parser they share. It lives here
 * rather than inside a single test file because two suites need it: the
 * slash-free guard and the cross-package drift guard.
 *
 * It is a single-pass scanner rather than a regex chain, because comments and
 * strings can each contain the other's delimiters and neither can be removed
 * independently:
 *
 * - The ignore-list comments quote paths and carry an apostrophe (`Next.js's`),
 *   so matching literals before removing comments yields phantom entries —
 *   several slash-bearing, which would fail the slash assertion on correct
 *   source.
 * - A glob string such as `'**‌/*'` contains a comment-open sequence, so
 *   removing comments with a regex first swallows the rest of the declaration
 *   and the scan runs past the closing bracket.
 *
 * Tracking string and comment state in one pass is the only ordering that is
 * correct in both directions.
 *
 * A source parser still cannot resolve a spread, an interpolation, a
 * concatenation, or a later `.add(...)`. Those are rejected loudly rather than
 * silently reducing the entry count, because a guard that quietly stops seeing
 * members is the defect these guards exist to catch.
 */

/** Shapes a source-text parser cannot resolve to a fixed list of string literals. */
const UNRESOLVABLE_SHAPES = ['...', '${', '+'] as const;

interface ScanResult {
  /** String literals declared directly in the block. */
  entries: string[];
  /** Block text with comments and string bodies removed, for shape checks. */
  skeleton: string;
}

/**
 * Walk the bracketed block that starts at `open`, collecting string literals and
 * a comment-free, string-free skeleton. Returns null when the block never closes.
 */
const scanBlock = (source: string, open: number): ScanResult | null => {
  const entries: string[] = [];
  let skeleton = '';
  let depth = 0;

  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let literal = '';
      let j = i + 1;
      for (; j < source.length; j += 1) {
        if (source[j] === '\\') {
          literal += source[j + 1] ?? '';
          j += 1;
          continue;
        }
        if (source[j] === quote) break;
        literal += source[j];
      }
      if (j >= source.length) return null;
      if (literal.length > 0) entries.push(literal);
      i = j;
      continue;
    }

    if (ch === '[') depth += 1;
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) return { entries, skeleton };
    }
    skeleton += ch;
  }

  return null;
};

/**
 * String literals declared in the `[...]` block introduced by `marker`.
 *
 * Throws — never returns a short list — when the marker is missing, the block is
 * malformed, or the declaration contains a member this parser cannot resolve.
 */
export const setEntries = (source: string, marker: string): string[] => {
  const at = source.indexOf(marker);
  if (at === -1) {
    throw new Error(`${marker} not found in ignore-service.ts — update this test`);
  }

  const open = source.indexOf('[', at);
  if (open === -1) {
    throw new Error(`${marker}: no bracketed block follows the marker`);
  }

  const scanned = scanBlock(source, open);
  if (scanned === null) {
    throw new Error(`${marker}: bracketed block never closes`);
  }

  for (const shape of UNRESOLVABLE_SHAPES) {
    if (scanned.skeleton.includes(shape)) {
      throw new Error(
        `${marker}: declaration contains \`${shape}\`, which a source parser cannot resolve. ` +
          `Switch this set to a runtime assertion rather than letting the guard read fewer members.`,
      );
    }
  }

  return scanned.entries;
};

/**
 * True when `setName` is mutated by `.add(...)` anywhere in `source`.
 *
 * `setEntries` reads the declaration only, so a member appended afterwards would
 * be invisible to it. The guards assert this is false rather than silently
 * under-reporting.
 */
export const hasRuntimeAdd = (source: string, setName: string): boolean =>
  new RegExp(`\\b${setName}\\s*\\.\\s*add\\s*\\(`).test(source);
