/**
 * Location→nodeId mapper (LSP read-only foundation, WI-#4)
 *
 * Pure, side-effect-free resolver that takes an LSP `Location`
 * (URI + 0-indexed line) and returns the `nodeId` of the
 * matching code node in the graph.
 *
 * Design references:
 *   docs/designs/159-lsp-readonly-foundation.md
 *     - § Components → "location-mapper.ts" (P0)
 *     - § Flows     → #sd-location-mapper
 *     - § EdgeCases → 3, 4, 5, 6, 8, 10
 *     - § Invariants → 1, 3, 5, 6
 *
 * Contract:
 *   mapLocationToNodeId(loc, repoId, deps?) →
 *     | { kind: 'node', nodeId }
 *     | { kind: 'NO_NODE' }
 *     | { kind: 'AMBIGUOUS' }
 *
 * Hard rules (mirroring the spec):
 *   - Refuse over guess (#3). A wrong nodeId silently corrupts every
 *     downstream comparison. AMBIGUOUS is always preferable to a guess.
 *   - Exact node identity (#5). When the graph already stores the id,
 *     return it directly. Otherwise reconstruct via
 *     `generateId(label, filePath:name)` — the same call the analyzer
 *     made when it wrote the node.
 *   - 0-indexed line convention (#6). LSP and tree-sitter both expose
 *     0-indexed lines. NEVER add +1. The BVA cases pin this.
 *   - Single-source path normalization (#6). Uses the same
 *     `normalizeFilePath` the indexer wrote. The mapper strips the
 *     `file://` URI scheme on top of that, so a Location URI normalizes
 *     to the exact string stored in `n.filePath`.
 *   - No graph writes (#1). The only DB surface touched is
 *     `executeParameterized` with a read-only MATCH…RETURN.
 */

import { generateId, normalizeFilePath } from '../../../lib/utils.js';
import { executeParameterized } from '../../../mcp/core/lbug-adapter.js';
import { VALID_NODE_LABELS } from './node-labels.js';

// ─── Public types ──────────────────────────────────────────────────────

/**
 * Minimal Location shape. Mirrors the LSP `Location` type but is
 * narrowed to only the fields the mapper actually consumes. Accepting
 * the full LSP `Location` would couple us to `vscode-languageserver-
 * protocol`, which the foundation pulls in separately — keeping the
 * public surface independent lets the mapper stay unit-testable
 * without that dep.
 */
export type Location = {
  /** LSP URI, e.g. `file:///abs/path/to/foo.ts`. */
  uri: string;
  /** Range — only `start.line` is used (0-indexed). */
  range: { start: { line: number; character: number } };
};

export type MapperResult =
  | { kind: 'node'; nodeId: string }
  | { kind: 'NO_NODE' }
  | { kind: 'AMBIGUOUS' };

/**
 * The dependency bag the mapper uses. Every member has a sensible
 * default (real DB-backed); callers (typically unit tests) inject
 * custom impls to make the algorithm deterministic.
 */
export interface MapperDeps {
  /** Read-only Cypher dispatch. Default: `executeParameterized`. */
  executeParameterized: (
    repoId: string,
    cypher: string,
    params: Record<string, any>,
  ) => Promise<any[]>;
  /** Same shape as `lib/utils.generateId`. Default: real fn. */
  generateId: (label: string, name: string) => string;
  /** Same shape as `lib/utils.normalizeFilePath`. Default: real fn. */
  normalizeFilePath: (p: string) => string;
}

// ─── Leaf node labels (the query union) ────────────────────────────────

/**
 * The labels the mapper queries. Spec §3: "VALID_NODE_LABELS minus
 * 'File', 'Folder', 'Community', 'Process' — we only want leaf code
 * nodes."
 *
 * We compute this set ONCE at module load. The result is a string
 * array we can splice straight into a Cypher `(n:L1 OR n:L2 OR ...)`.
 */
const LEAF_LABELS: string[] = [
  'Function', 'Class', 'Method', 'Interface',
  'Struct', 'Enum', 'Trait', 'Impl', 'Constructor', 'Record',
  'TypeAlias', 'Template', 'Const', 'Static', 'Property',
  'Delegate', 'Annotation',
];

// ─── Internal helpers ─────────────────────────────────────────────────

/**
 * Strip a `file://` URI scheme and any leading `/` so the result
 * looks like a repo-relative POSIX path the indexer would have
 * stored. Pure: never throws.
 *
 * Examples:
 *   file:///repo/src/foo.ts       → src/foo.ts
 *   file:///C:/repo/src/foo.ts    → C:/repo/src/foo.ts
 *   /repo/src/foo.ts              → repo/src/foo.ts
 *   src/foo.ts                    → src/foo.ts
 *   file://server/share/x.ts      → share/x.ts
 */
function stripFileUriScheme(p: string): string {
  if (!p) return '';
  let out = p;
  // `file://` is the LSP-canonical scheme. Allow `file:/` (some clients).
  if (out.startsWith('file://')) {
    out = out.slice('file://'.length);
    // On UNC-style URIs (file://server/share/...) the segment after
    // the scheme is the hostname. We keep the first path segment as
    // the root for those (best-effort) and drop the rest's leading /.
    // For the local-filesystem case (file:///abs/path) the path is
    // the third '/' onwards; we just strip a single leading slash.
    if (out.startsWith('/')) out = out.slice(1);
  } else if (out.startsWith('file:')) {
    out = out.slice('file:'.length);
    if (out.startsWith('//')) out = out.slice(2);
    if (out.startsWith('/')) out = out.slice(1);
  }
  return out;
}

/**
 * Combine URI-scheme stripping + backslash + `./` normalization
 * (the latter two via `normalizeFilePath`). The order matters:
 * scheme first (so we don't get `\\` mangled inside `file://`),
 * then the lib-level normalizer.
 */
function normalizeLocationUri(uri: string, normalize: (p: string) => string): string {
  if (!uri) return '';
  return normalize(stripFileUriScheme(uri));
}

/**
 * Refuse-to-skip predicate for paths the spec calls out as
 * "not a known file" (EdgeCase 3): `node_modules`, `.d.ts`,
 * anything under `dist/`.
 *
 * The spec lists three patterns; we anchor them generously so a
 * match means "this Location points at a generated / vendored /
 * declaration file we have not indexed, and we should refuse
 * rather than guess".
 */
/**
 * Refuse-to-skip predicate for paths the spec calls out as
 * "not a known file" (EdgeCase 3): `node_modules`, `.d.ts`,
 * anything under `dist/`.
 *
 * Exported for sibling modules (e.g. the Mode A reconciler)
 * that need to short-circuit before issuing a per-candidate
 * request. The spec lists three patterns; we anchor them
 * generously so a match means "this Location points at a
 * generated / vendored / declaration file we have not
 * indexed, and we should refuse rather than guess".
 */
export function isUnindexablePath(relPath: string): boolean {
  if (!relPath) return true;
  if (relPath === 'node_modules') return true;
  if (relPath.startsWith('node_modules/')) return true;
  if (relPath.endsWith('.d.ts')) return true;
  if (relPath.includes('/node_modules/')) return true;
  // anything under dist/ (build output, not source)
  if (relPath.includes('/dist/')) return true;
  if (relPath.startsWith('dist/')) return true;
  return false;
}

/**
 * The parameterized Cypher query the mapper issues. Single
 * MATCH…RETURN, parameterized on `relPath` and `line`. Uses the
 * label disjunction built from `LEAF_LABELS`. Orders by range
 * size ASC so the smallest enclosing range is the head of the
 * list — that's our cheapest tie-breaker.
 *
 * The query references the labels inlined (not as a runtime
 * variable) because Cypher does not allow parameterizing label
 * disjunctions. The label set is hard-coded from a module-level
 * constant, so this is not a dynamic-eval surface.
 */
function buildCandidateQuery(): string {
  // We use `label(n) IN $labels` (parameterized) rather than the
  // `OR` disjunction the spec sketched. Kùzu's Cypher parser rejects
  // `WHERE (n:Function OR n:Class …)` in this position with a
  // `Parser exception: expected rule oC_SingleQuery` at the OR. The
  // `label(n) IN $list` form is canonical, parameterized, and
  // produces an identical result set. (Kùzu also returns
  // `label(n)` as a plain STRING — not a list — so the projection
  // below uses the singular form. This matches the WI-#73 fix in
  // local-backend.ts.)
  return [
    'MATCH (n)',
    'WHERE n.filePath = $relPath',
    '  AND n.startLine <= $line',
    '  AND n.endLine >= $line',
    '  AND label(n) IN $labels',
    'RETURN n.id AS id, n.name AS name, n.startLine AS startLine,',
    '       n.endLine AS endLine, label(n) AS label, n.filePath AS filePath',
    'ORDER BY (n.endLine - n.startLine) ASC, n.id ASC',
  ].join(' ');
}

/**
 * Apply the four-stage tie-breaker chain (spec §3 step 4):
 *   (1) innermost range  (smallest `endLine - startLine`)
 *   (2) exact startLine match
 *   (3) identifier-name match against the URI basename
 *   (4) overload `:index` reconstruction — already encoded in `n.id`
 *
 * Returns the surviving candidate (1) or `null` if the chain
 * cannot reduce >1 → 1 (i.e. AMBIGUOUS).
 */
function applyTieBreakers(
  candidates: Candidate[],
  queryLine: number,
  baseName: string,
): Candidate | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Tie-breaker 1: smallest range.
  let minRange = Infinity;
  for (const c of candidates) {
    const r = c.endLine - c.startLine;
    if (r < minRange) minRange = r;
  }
  let tier1 = candidates.filter((c) => c.endLine - c.startLine === minRange);
  if (tier1.length === 1) return tier1[0];
  if (tier1.length === 0) return null; // unreachable, but defensive

  // Tie-breaker 2: exact startLine match.
  const tier2 = tier1.filter((c) => c.startLine === queryLine);
  if (tier2.length === 1) return tier2[0];
  if (tier2.length > 1) tier1 = tier2;
  // if tier2 is empty, fall through with tier1 unchanged

  // Tie-breaker 3: identifier-name match.
  // Best-effort: a candidate whose `name` contains the URI basename
  // (without extension) AND is strictly more specific (i.e. the
  // candidate's name is longer than the basename) is preferred.
  // The strict-length guard avoids the degenerate case where the
  // candidate's name IS the basename — `'a'.includes('a')` is
  // trivially true and would mask real ambiguity.
  if (baseName) {
    const tier3 = tier1.filter(
      (c) =>
        typeof c.name === 'string' &&
        c.name.length > baseName.length &&
        c.name.includes(baseName),
    );
    if (tier3.length === 1) return tier3[0];
    if (tier3.length > 1) tier1 = tier3;
  }

  // Tie-breaker 4: overload `:index` reconstruction.
  // The graph stores `Method:filePath:name[:index]` for overloads.
  // If the candidate ids already include a `:N` suffix we cannot
  // disambiguate further without knowing which overload was meant.
  // We pick the lowest-index overload deterministically — that
  // matches the analyzer's stable sort and avoids a random pick.
  if (tier1.length > 1) {
    const sorted = [...tier1].sort((a, b) => extractOverloadIndex(a.id) - extractOverloadIndex(b.id));
    if (sorted.length > 1) {
      // Multiple distinct overloads AND still >1 → AMBIGUOUS.
      // Refuse over guess (Invariant 3).
      return null;
    }
    return sorted[0];
  }

  return tier1[0] ?? null;
}

/**
 * Extract the trailing `:N` overload index from a nodeId. Returns
 * 0 when the id has no `:N` suffix. Used to disambiguate Java-style
 * overloads (`MyService:com/x/MyService.java:doThing:0`,
 * `MyService:com/x/MyService.java:doThing:1`, …).
 */
function extractOverloadIndex(nodeId: string): number {
  if (!nodeId) return 0;
  const idx = nodeId.lastIndexOf(':');
  if (idx < 0) return 0;
  const tail = nodeId.slice(idx + 1);
  const n = parseInt(tail, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The shape returned by the candidate query.
 * `label` is the array form from `labels(n)` — Kùzu actually
 * returns a single-element array here, but the mapper never
 * relies on the count; it joins + splits defensively.
 */
interface Candidate {
  id: string;
  name: string;
  startLine: number;
  endLine: number;
  label: string | string[];
  filePath: string;
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Resolve a single LSP Location to a graph nodeId. See module
 * docstring for the full contract.
 *
 * @param loc    LSP Location (uri + 0-indexed start line)
 * @param repoId The repoId used by `executeParameterized`. Required.
 * @param deps   Optional dependency overrides. Test-only.
 */
export async function mapLocationToNodeId(
  loc: Location,
  repoId: string,
  deps?: Partial<MapperDeps>,
): Promise<MapperResult> {
  // ── Dep assembly ───────────────────────────────────────────────────
  // Default every dep to the real, production-grade implementation.
  // Tests pass `deps = { executeParameterized: vi.fn(...) }` to
  // bypass the DB entirely.
  const resolvedDeps: MapperDeps = {
    executeParameterized,
    generateId,
    normalizeFilePath,
    ...(deps ?? {}),
  };

  // ── 1) Normalize URI → repo-relative POSIX path ───────────────────
  // EdgeCase 3 (node_modules / .d.ts) + EdgeCase 10 (Windows
  // backslashes) + Invariant 6 (single-source normalization).
  const relPath = normalizeLocationUri(loc?.uri ?? '', resolvedDeps.normalizeFilePath);
  if (isUnindexablePath(relPath)) {
    return { kind: 'NO_NODE' };
  }

  // ── 1a) Sanity: query line must be a non-negative integer ─────────
  // A malformed Location (NaN/undefined) would otherwise produce
  // a "valid" Cypher that returns 0 rows. Treat that as NO_NODE
  // (refuse over guess) rather than letting the DB silently miss.
  const line = loc?.range?.start?.line;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 0) {
    return { kind: 'NO_NODE' };
  }

  // ── 2) Query candidates ───────────────────────────────────────────
  // The label disjunction is built once (module-level constant);
  // we only parameterize `relPath` and `line` so user input never
  // reaches the query string.
  const cypher = buildCandidateQuery();
  let rows: any[];
  try {
    rows = await resolvedDeps.executeParameterized(repoId, cypher, {
      relPath,
      line,
      labels: LEAF_LABELS,
    });
  } catch {
    // If the DB call itself fails (pool not initialized, query
    // timeout, etc.), refuse rather than guess. The spec's "no
    // graph writes" invariant is preserved because `executeParameterized`
    // cannot mutate state, and we never write anything here.
    return { kind: 'NO_NODE' };
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return { kind: 'NO_NODE' };
  }

  // ── 3) Project to Candidate[] + post-filter on line containment ──
  // The Cypher already enforces `n.startLine <= $line AND
  // n.endLine >= $line`, but we re-apply it here as defense-in-
  // depth. If a real DB returns a row that violates the range
  // (engine bug, partial index, mock returning unfiltered rows
  // in tests) the mapper MUST still refuse — never guess.
  // This is the BVA guard for line == endLine + 1.
  const candidates: Candidate[] = rows
    .map((r: any) => ({
      id: typeof r.id === 'string' ? r.id : '',
      name: typeof r.name === 'string' ? r.name : '',
      startLine: typeof r.startLine === 'number' ? r.startLine : 0,
      endLine: typeof r.endLine === 'number' ? r.endLine : 0,
      label: r.label ?? '',
      filePath: typeof r.filePath === 'string' ? r.filePath : '',
    }))
    .filter((c: Candidate) => c.startLine <= line && c.endLine >= line);

  if (candidates.length === 0) {
    return { kind: 'NO_NODE' };
  }

  // ── 4) Single-candidate fast path ─────────────────────────────────
  if (candidates.length === 1) {
    const c = candidates[0];
    return { kind: 'node', nodeId: c.id || reconstructId(c, relPath, resolvedDeps) };
  }

  // ── 5) Tie-breaker chain ───────────────────────────────────────────
  const baseName = extractBaseName(relPath);
  const survivor = applyTieBreakers(candidates, line, baseName);
  if (!survivor) {
    return { kind: 'AMBIGUOUS' };
  }
  return {
    kind: 'node',
    nodeId: survivor.id || reconstructId(survivor, relPath, resolvedDeps),
  };
}

// ─── Internal ID reconstruction (Invariant 5) ──────────────────────────

/**
 * Rebuild the canonical nodeId from a candidate row when the row
 * is missing it (defensive — the spec says the DB may or may not
 * store `n.id`). The shape is `Label:filePath:name[:overloadIndex]`,
 * the same call the analyzer made when it wrote the node.
 */
function reconstructId(
  c: Candidate,
  relPath: string,
  deps: MapperDeps,
): string {
  const label = labelToString(c.label);
  // Fall back to the candidate's own filePath if the query
  // projection didn't return it (paranoid; shouldn't happen).
  const fp = c.filePath || relPath;
  return deps.generateId(label, `${fp}:${c.name}`);
}

/** Coerce the label field (string | string[] | other) to a clean string. */
function labelToString(label: string | string[] | unknown): string {
  if (typeof label === 'string') return label;
  if (Array.isArray(label) && typeof label[0] === 'string') return label[0];
  return '';
}

/**
 * Extract the basename (no extension) from a path. Used by
 * tie-breaker 3 to prefer candidates whose `name` matches the
 * filename. Pure.
 */
function extractBaseName(relPath: string): string {
  if (!relPath) return '';
  // Last segment after `/`.
  const segs = relPath.split('/');
  const last = segs[segs.length - 1] ?? '';
  if (!last) return '';
  // Strip the final extension (`.ts`, `.tsx`, `.d.ts`).
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

// ─── Re-exports for tests / advanced callers ──────────────────────────

/** Internal: the candidate query (exposed for diagnostic / unit tests). */
export const __test__ = {
  buildCandidateQuery,
  stripFileUriScheme,
  normalizeLocationUri,
  isUnindexablePath,
  applyTieBreakers,
  extractOverloadIndex,
  reconstructId,
  extractBaseName,
  LEAF_LABELS,
};

/**
 * The set of labels the mapper considers. Re-exported for tests
 * and for callers that want to assert "did the mapper skip the
 * non-leaf labels?" without re-deriving the set.
 */
export const MAPPER_LEAF_LABELS: ReadonlyArray<string> = LEAF_LABELS;

/**
 * Re-export the upstream set so consumers can compare it
 * against the mapper's leaf set (sanity check that we
 * stripped exactly the four non-leaf labels).
 */
export const ALL_VALID_NODE_LABELS: ReadonlySet<string> = VALID_NODE_LABELS;
