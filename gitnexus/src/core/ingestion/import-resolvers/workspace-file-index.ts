/**
 * Per-file-set workspace index for the import-target resolvers that need the
 * shared `SuffixIndex` (C#, Java, PHP, Ruby).
 *
 * The scope-resolution orchestrator passes the SAME `allFilePaths` Set object to
 * every `resolveImportTarget` call in a pass (`pipeline/run.ts` builds it once),
 * so memoizing on the Set's identity in a `WeakMap` turns the per-import
 * "materialize two arrays + build a suffix index" cost into a one-time build.
 *
 * IMPORTANT for callers: the Set must be passed THROUGH, never copied. A
 * defensive `new Set(allFilePaths)` in an adapter hands a fresh `WeakMap` key
 * per call and silently restores the O(imports × files) behaviour — the exact
 * bug PR #1918 shipped and had to fix in review (P1).
 *
 * Three layers guard that, and they guard different things:
 *  - ADAPTER BOUNDARY, where the defensive-copy hazard actually lives:
 *    `test/integration/<lang>-import-index-reuse.test.ts` (csharp, java, php
 *    and ruby for this index; cobol, dart, go, kotlin and python for the
 *    sibling ones) resolves through `<lang>ScopeResolver.resolveImportTarget` —
 *    the orchestrator adapter — and asserts the file set is traversed once per
 *    run (twice for C# and Java, which build two indexes). All nine count
 *    traversals of a `CountingSet` (`test/helpers/counting-file-set.ts`): one
 *    instrument, no production surface, and it catches both the per-import
 *    rebuild and a scan reintroduced beside a reused index (#2909).
 *  - EVERY REGISTERED LANGUAGE, at the same boundary but as one property rather
 *    than nine corpora: `test/unit/scope-resolution/import-target-index-reuse.contract.test.ts`
 *    drives each entry of `SCOPE_RESOLVERS` and asserts the traversal count for
 *    many imports equals the count for two. A new language cannot skip it — the
 *    inventory arm fails when a registered resolver has no fixture.
 *  - RESOLVER LEVEL: `test/unit/scope-resolution/import-target-index-parity.test.ts`
 *    calls the resolvers directly, so it never crosses the adapter boundary and
 *    a copy there leaves it green. What it catches is a rescan reintroduced
 *    INSIDE a resolver, by counting how many times the Set is iterated.
 */

import { buildSuffixIndex, type SuffixIndex } from './utils.js';

export interface WorkspaceFileIndex {
  /** Every path, backslashes normalized to `/`. Parallel to `all`. */
  readonly normalized: string[];
  /** Every path, exactly as it appears in the Set. Parallel to `normalized`. */
  readonly all: string[];
  /** Segment-suffix → first file (in Set iteration order) carrying that suffix. */
  readonly index: SuffixIndex;
  /**
   * Normalized path → first raw path that normalizes to it. Answers "is there a
   * file whose WHOLE path is X", which `index.get(X)` cannot: the suffix map
   * conflates a whole-path hit with a `…/X` suffix hit, and C#'s
   * `resolveDirectMatch` lets a whole-path match win over an earlier suffix
   * match.
   */
  readonly normToRaw: Map<string, string>;
}

const WORKSPACE_FILE_INDEX_CACHE = new WeakMap<ReadonlySet<string>, WorkspaceFileIndex>();

export function getWorkspaceFileIndex(allFilePaths: ReadonlySet<string>): WorkspaceFileIndex {
  const cached = WORKSPACE_FILE_INDEX_CACHE.get(allFilePaths);
  if (cached !== undefined) return cached;

  const all = [...allFilePaths];
  const normalized = all.map((f) => f.replace(/\\/g, '/'));
  const normToRaw = new Map<string, string>();
  for (let i = 0; i < normalized.length; i++) {
    // First wins, mirroring the `for (const raw of allFilePaths)` scans this
    // replaces: they returned on the first match in iteration order.
    if (!normToRaw.has(normalized[i])) normToRaw.set(normalized[i], all[i]);
  }

  const built: WorkspaceFileIndex = {
    normalized,
    all,
    index: buildSuffixIndex(normalized, all),
    normToRaw,
  };
  WORKSPACE_FILE_INDEX_CACHE.set(allFilePaths, built);
  return built;
}
