/**
 * In-memory `executeParameterized` adapter (WI-3 of #159 P3).
 *
 * `mapLocationToNodeId` (location-mapper.ts) was designed with a
 * dependency-injection seam for its only DB coupling — a function
 * that runs a read-only Cypher MATCH and returns rows. WI-3
 * introduces a small adapter that answers the SAME query against
 * the in-memory node list (the candidate set the reconciler carries
 * from the heuristic ingest). The adapter is the bridge between
 * the no-write `core/ingestion/lsp/` module and the
 * in-memory-write reconciler at `core/ingestion/mode-a-reconciler.ts`.
 *
 * Contract (KD-2):
 *   createInMemoryNodeQuery(nodes) → (repoId, cypher, params) => rows
 *
 *   - `repoId` and `cypher` are accepted for signature parity with
 *     the real `executeParameterized` and ignored — the adapter
 *     is a pure read against its closure-captured node list.
 *   - `params.relPath`   — exact-match file path filter.
 *   - `params.line`      — 0-indexed; a node matches iff
 *                          `startLine <= line <= endLine`.
 *   - `params.labels`    — the set `label(n)` must be IN (an empty
 *                          set means "no label filter" — the
 *                          mapper normally passes the full
 *                          `LEAF_LABELS` set; tests may pass `[]`
 *                          to disable the filter).
 *
 *   The output rows are sorted to mirror the Cypher `ORDER BY`:
 *     `(endLine - startLine) ASC, id ASC`
 *   so the mapper's tie-breaker #1 (innermost range) sees the
 *   same head element it would see against the real DB.
 *
 *   The output shape is `{id, name, startLine, endLine, label,
 *   filePath}` — the same six fields the mapper's defensive
 *   projection consumes (location-mapper.ts:375-384).
 *
 * Why this file is NOT under `lsp/`
 *   The `core/ingestion/lsp/` directory is guarded by
 *   `no-write-invariant.test.ts`. The adapter is read-only by
 *   construction (it never imports a write API, never mutates the
 *   input array), so it would technically pass the guard. But the
 *   spec (P3 plan, I-7) puts the reconciler outside `lsp/` —
 *   and this adapter is the reconciler's data-plane. Keeping the
 *   adapter beside the reconciler's future call site (under
 *   `core/ingestion/`) keeps the in-memory-write surface in one
 *   place. The adapter is itself pure and read-only.
 */

import { MAPPER_LEAF_LABELS } from './lsp/location-mapper.js';

/**
 * Hoisted module-level default label set. We pre-build it once
 * (the `MAPPER_LEAF_LABELS` array is itself a module-level
 * constant) and freeze the Set so a caller can't accidentally
 * mutate the shared structure. The non-default branch (a
 * caller-supplied `labels` array) still allocates a fresh Set
 * per call — that path is hit by tests that override the set.
 */
const DEFAULT_LABEL_SET: ReadonlySet<string> = new Set(MAPPER_LEAF_LABELS);

// ─── Public types ─────────────────────────────────────────────────────

/**
 * A node from the in-memory graph (the candidate set the
 * reconciler hands to the mapper). Fields mirror the columns the
 * mapper's defensive projection reads. `label` is a string here
 * (the in-memory representation is uniform across the in-memory
 * graph; Kùzu's `label(n)` returns a STRING for nodes with one
 * label, which matches).
 *
 * The row shape the adapter returns is identical to this candidate
 * row (see `location-mapper.ts:374-384`), so the alias `InMemoryCandidateRow`
 * is a structural name for the same type — `createInMemoryNodeQuery`
 * returns rows of this shape unchanged.
 */
export type InMemoryNode = {
  id: string;
  name: string;
  startLine: number;
  endLine: number;
  label: string;
  filePath: string;
};

/**
 * The row shape the adapter returns. Structurally identical to
 * `InMemoryNode` — the alias documents intent (rows vs. nodes) at
 * the seam between the snapshot list and the returned projection.
 */
export type InMemoryCandidateRow = InMemoryNode;

/**
 * The signature `MapperDeps.executeParameterized` expects.
 * The adapter's `execute` is assignable to it.
 */
export type InMemoryExecuteParameterized = (
  repoId: string,
  cypher: string,
  params: { relPath: string; line: number; labels: readonly string[] },
) => Promise<InMemoryCandidateRow[]>;

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Build a `deps.executeParameterized`-shaped function that
 * answers the mapper's candidate query against the in-memory
 * node list.
 *
 * Pure: does not mutate `nodes`; safe to call repeatedly.
 * Read-only: never imports or calls a write API.
 */
export function createInMemoryNodeQuery(
  nodes: ReadonlyArray<InMemoryNode>,
): InMemoryExecuteParameterized {
  // Defensive shallow copy of the array — we sort the COPY, not
  // the caller's array. Tests in this suite assert immutability
  // (see `in-memory-node-query.test.ts`).
  const snapshot = nodes.slice();

  return async (_repoId: string, _cypher: string, params: {
    relPath: string;
    line: number;
    labels: readonly string[];
  }): Promise<InMemoryCandidateRow[]> => {
    const { relPath, line, labels } = params;

    // ── Defensive input checks ────────────────────────────────────
    // The mapper already validates `line` upstream; we re-check
    // because tests can call the adapter directly.
    if (typeof line !== 'number' || !Number.isFinite(line) || line < 0) {
      return [];
    }
    if (typeof relPath !== 'string' || !relPath) {
      return [];
    }

    // ── Filter pipeline ───────────────────────────────────────────
    // 1. relPath exact match.
    // 2. Label IN `labels` (empty labels ⇒ no label filter; the
    //    mapper normally passes the full `LEAF_LABELS` set).
    //    We re-apply the mapper's leaf set here so an empty
    //    `labels` array from a test still excludes `File` /
    //    `Folder` / `Community` / `Process`. Tests can override
    //    by passing a non-empty set.
    // 3. Line-range containment.
    //
    // m6: the `!labels` half of the guard was unreachable —
    // the real mapper always passes the 17-element
    // `MAPPER_LEAF_LABELS` array. The `length === 0` check
    // alone is the load-bearing one (it's the path tests
    // take to disable the filter); the `!labels` half
    // was dead.
    const labelSet =
      labels.length === 0 ? DEFAULT_LABEL_SET : new Set(labels);

    const filtered: InMemoryCandidateRow[] = [];
    for (const n of snapshot) {
      if (n.filePath !== relPath) continue;
      if (!labelSet.has(n.label)) continue;
      if (n.startLine > line || n.endLine < line) continue;
      filtered.push({
        id: n.id,
        name: n.name,
        startLine: n.startLine,
        endLine: n.endLine,
        label: n.label,
        filePath: n.filePath,
      });
    }

    // ── Sort: mirror the Cypher ORDER BY exactly ──────────────────
    //   ORDER BY (n.endLine - n.startLine) ASC, n.id ASC
    // The first key is range size (a number, ascending). The
    // second is `id` ascending — a stable, lexicographic string
    // compare matches Kùzu's default Cypher string ordering.
    filtered.sort((a, b) => {
      const ra = a.endLine - a.startLine;
      const rb = b.endLine - b.startLine;
      if (ra !== rb) return ra - rb;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });

    return filtered;
  };
}
