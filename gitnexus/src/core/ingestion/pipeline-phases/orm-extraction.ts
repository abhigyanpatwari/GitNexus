/**
 * Inline ORM query extraction (sequential fallback path).
 *
 * Extracts Prisma and Supabase query calls from source content using
 * regex patterns. Used by the sequential parse path when workers are
 * not available — the worker path extracts ORM queries via tree-sitter
 * queries instead.
 *
 * @module
 */

import type { ExtractedORMQuery } from '../workers/parse-worker.js';

// ── Regex patterns ─────────────────────────────────────────────────────────

/** Matches Prisma client method calls: `prisma.user.findMany(...)` */
const PRISMA_QUERY_RE =
  /\bprisma\.(\w+)\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|create|createMany|update|updateMany|delete|deleteMany|upsert|count|aggregate|groupBy)\s*\(/g;

/** Matches Supabase client method calls: `supabase.from('users').select(...)` */
const SUPABASE_QUERY_RE =
  /\bsupabase\.from\s*\(\s*['"](\w+)['"]\s*\)\s*\.(select|insert|update|delete|upsert)\s*\(/g;

// ── Extraction function ───────────────────────────────────────────────────

/**
 * Extract ORM query calls from file content using regex.
 *
 * Fast-path: skips files that don't contain `prisma.` or `supabase.from`.
 * Results are appended to the `out` array (push pattern avoids allocation).
 *
 * @param filePath  Relative path of the source file
 * @param content   File content string
 * @param out       Output array to append extracted queries to
 */
export function extractORMQueriesInline(
  filePath: string,
  content: string,
  out: ExtractedORMQuery[],
): void {
  const hasPrisma = content.includes('prisma.');
  const hasSupabase = content.includes('supabase.from');
  if (!hasPrisma && !hasSupabase) return;

  // Pre-compute line number offsets to avoid O(n²) substring+split per match
  const lineOffsets = buildLineOffsets(content);

  if (hasPrisma) {
    PRISMA_QUERY_RE.lastIndex = 0;
    let m;
    while ((m = PRISMA_QUERY_RE.exec(content)) !== null) {
      const model = m[1];
      if (model.startsWith('$')) continue;
      out.push({
        filePath,
        orm: 'prisma',
        model,
        method: m[2],
        lineNumber: lineNumberAtOffset(lineOffsets, m.index),
      });
    }
  }

  if (hasSupabase) {
    SUPABASE_QUERY_RE.lastIndex = 0;
    let m;
    while ((m = SUPABASE_QUERY_RE.exec(content)) !== null) {
      out.push({
        filePath,
        orm: 'supabase',
        model: m[1],
        method: m[2],
        lineNumber: lineNumberAtOffset(lineOffsets, m.index),
      });
    }
  }
}

// ── Line offset helpers ───────────────────────────────────────────────────

/** Build an array of byte offsets where each newline occurs (O(n) once). */
function buildLineOffsets(content: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') offsets.push(i);
  }
  return offsets;
}

/**
 * Binary search for 0-based line number at a given character offset.
 *
 * Returns the number of newlines that occur before `offset` in the content,
 * which is the 0-based line number. When `offset` is beyond the last newline,
 * returns `lineOffsets.length` (i.e., the last line index).
 */
function lineNumberAtOffset(lineOffsets: number[], offset: number): number {
  let lo = 0;
  let hi = lineOffsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lineOffsets[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
