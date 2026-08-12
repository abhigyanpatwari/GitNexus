/**
 * Anchoring for matching a graph row's `filePath` against a path a caller
 * supplied.
 *
 * `filePath` is stored repo-relative, and callers arrive with a path that may be
 * rooted differently — a diff reports `lib/a.ts` for a file the index stored as
 * `src/lib/a.ts` — so the match has to allow a trailing run of path SEGMENTS.
 * The obvious `ENDS WITH $p` is a plain STRING suffix, so it also matched an
 * indexed `src/mylib/a.ts` (#2915 review): a file the caller never named.
 * Prefixing the separator anchors the suffix on a segment boundary.
 *
 * The anchored form alone cannot match a row whose stored path IS the caller's
 * path (nothing precedes it), so a match is the pair — `n.filePath = $path OR
 * n.filePath ENDS WITH $suffix`. Both values are BOUND, not spliced into the
 * query text, which is why this returns the string and not a clause: the caller
 * that needs it hands the graph an `UNWIND` of `{path, suffix}` structs whose
 * query text is the same length for one changed file as for a thousand (#2915).
 */
export function pathSuffixOf(filePath: string): string {
  return `/${filePath}`;
}
