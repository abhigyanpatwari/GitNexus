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
 *    `test/integration/*-import-index-reuse.test.ts` resolves through
 *    `<lang>ScopeResolver.resolveImportTarget` — the orchestrator adapter — and
 *    pins the EXACT number of times a run traverses the file set, one file per
 *    covered language over that language's own corpus. (The expected count is
 *    per language and legitimately differs: it is however many times the
 *    adapter derives something from the Set — two indexes, or an index plus the
 *    mutable copy the ts-family context wants.) All of them count traversals
 *    of a `CountingSet` (`test/helpers/counting-file-set.ts`): one instrument,
 *    no production surface, and it catches both the per-import rebuild and a
 *    scan reintroduced beside a reused index (#2909).
 *  - EVERY REGISTERED LANGUAGE, at the same boundary but as one property rather
 *    than one corpus per language: `test/unit/scope-resolution/import-target-index-reuse.contract.test.ts`
 *    drives each entry of `SCOPE_RESOLVERS` and asserts the traversal count for
 *    many imports equals the count for two. A new language cannot skip it, and
 *    the enforcement is a test rather than a roster anyone maintains: that
 *    file's inventory arm compares `SCOPE_RESOLVERS`' keys against its own
 *    fixture table and fails on a registered resolver that has neither a
 *    fixture nor an exemption, and its next arm pins the exemption map empty.
 *  - RESOLVER LEVEL: `test/unit/scope-resolution/import-target-index-parity.test.ts`
 *    calls the resolvers directly, so it never crosses the adapter boundary and
 *    a copy there leaves it green. What it catches is a rescan reintroduced
 *    INSIDE a resolver, by counting how many times the Set is iterated.
 */

import { perFileSet } from './per-file-set.js';
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

export const getWorkspaceFileIndex = perFileSet(
  (allFilePaths: ReadonlySet<string>): WorkspaceFileIndex => {
    const all = [...allFilePaths];
    const normalized = all.map((f) => f.replace(/\\/g, '/'));
    const normToRaw = new Map<string, string>();
    for (let i = 0; i < normalized.length; i++) {
      // First wins, mirroring the `for (const raw of allFilePaths)` scans this
      // replaces: they returned on the first match in iteration order.
      if (!normToRaw.has(normalized[i])) normToRaw.set(normalized[i], all[i]);
    }

    return {
      normalized,
      all,
      index: buildSuffixIndex(normalized, all),
      normToRaw,
    };
  },
);
