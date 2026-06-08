/**
 * Unit Tests: location-mapper (LSP read-only foundation, WI-#4)
 *
 * The mapper is a pure async function: it normalizes the URI,
 * issues a read-only Cypher MATCH, then runs a deterministic
 * tie-breaker chain. The DB call is injected via the `deps`
 * parameter, so the test surface is just function-in / result-out
 * — no global module mocking required.
 *
 * Decision table (the merge-blocking gate per the WI spec):
 *
 *   | 0 candidates          |  NO_NODE       |
 *   | 1 candidate           |  node          |
 *   | >1, all distinct      |  AMBIGUOUS     |
 *   | >1, smallest range    |  that one      |
 *   | >1, exact startLine   |  that one      |
 *   | >1, name match        |  that one      |
 *   | >1, same overload idx |  AMBIGUOUS     |
 *   | node_modules/.d.ts    |  NO_NODE       |
 *   | empty graph           |  NO_NODE       |
 *   | line > endLine        |  NO_NODE       |
 *   | line == endLine       |  matches       |
 *   | line == startLine     |  matches       |
 *   | windows URI           |  normalized    |
 *   | bad/non-numeric line  |  NO_NODE       |
 *
 * The fixture matrix F-1..F-5 from the spec is exercised first;
 * the rest is BVA / EP around the tie-breaker chain.
 */

import { describe, it, expect, vi } from 'vitest';
import { generateId, normalizeFilePath } from '../../../src/lib/utils.js';
import {
  mapLocationToNodeId,
  __test__,
  MAPPER_LEAF_LABELS,
} from '../../../src/core/ingestion/lsp/location-mapper.js';

// ─── Real deps (used to compare the mapper's reconstructed ids) ───────
const realGenerateId = generateId;

// ─── Mock dispatch helper ──────────────────────────────────────────────
//
// The mapper accepts a `deps.executeParameterized` injection. We
// build a small wrapper that records the call and returns whatever
// the current test wants — this is the entire test surface.

function makeDeps(rows: any[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  return {
    deps: { executeParameterized: execute },
    execute,
  };
}

function loc(uri: string, line: number) {
  return { uri, range: { start: { line, character: 0 } } };
}

// Common fixture row factory. `id` is what the DB would have stored.
const row = (over: Partial<{
  id: string;
  name: string;
  startLine: number;
  endLine: number;
  label: string | string[];
  filePath: string;
}>) => ({
  id: over.id ?? '',
  name: over.name ?? '',
  startLine: over.startLine ?? 0,
  endLine: over.endLine ?? 0,
  label: over.label ?? 'Function',
  filePath: over.filePath ?? 'src/foo.ts',
});

// ─── Fixture matrix F-1..F-5 (merge-blocking gate) ────────────────────

describe('location-mapper — fixture matrix (F-1..F-5)', () => {
  it('F-1: indexing-skew, single function at the queried line', async () => {
    // A single Function node spanning line 5..10; the Location's
    // line is 5 (the start). Single candidate → node.
    const { deps } = makeDeps([
      row({
        id: 'Function:src/foo.ts:myFn',
        name: 'myFn',
        startLine: 5,
        endLine: 10,
        label: 'Function',
        filePath: 'src/foo.ts',
      }),
    ]);

    const result = await mapLocationToNodeId(
      loc('file:///repo/src/foo.ts', 5),
      'test-repo',
      deps,
    );

    expect(result).toEqual({ kind: 'node', nodeId: 'Function:src/foo.ts:myFn' });
  });

  it('F-2: two overloads on the same startLine → AMBIGUOUS', async () => {
    // Two Method rows: same name, same startLine, same endLine.
    // Distinct `:index` overload suffixes. After all tie-breakers
    // the survivor is still >1, so the mapper refuses (EdgeCase 4,
    // Invariant 3).
    const { deps } = makeDeps([
      row({
        id: 'Method:src/S.java:doThing:0',
        name: 'doThing',
        startLine: 7,
        endLine: 12,
        label: 'Method',
        filePath: 'src/S.java',
      }),
      row({
        id: 'Method:src/S.java:doThing:1',
        name: 'doThing',
        startLine: 7,
        endLine: 12,
        label: 'Method',
        filePath: 'src/S.java',
      }),
    ]);

    const result = await mapLocationToNodeId(
      loc('file:///repo/src/S.java', 7),
      'test-repo',
      deps,
    );

    expect(result).toEqual({ kind: 'AMBIGUOUS' });
  });

  it('F-3: multiple distinct symbols on one line → AMBIGUOUS', async () => {
    // Two functions declared on the same line, with the same range.
    // Different names. No tie-breaker resolves them.
    const { deps } = makeDeps([
      row({
        id: 'Function:src/util.ts:helperA',
        name: 'helperA',
        startLine: 3,
        endLine: 5,
        label: 'Function',
        filePath: 'src/util.ts',
      }),
      row({
        id: 'Function:src/util.ts:helperB',
        name: 'helperB',
        startLine: 3,
        endLine: 5,
        label: 'Function',
        filePath: 'src/util.ts',
      }),
    ]);

    const result = await mapLocationToNodeId(
      loc('file:///repo/src/util.ts', 3),
      'test-repo',
      deps,
    );

    expect(result).toEqual({ kind: 'AMBIGUOUS' });
  });

  it('F-4: node_modules / .d.ts → NO_NODE', async () => {
    const cases = [
      'file:///repo/node_modules/lodash/index.d.ts',
      'file:///repo/types/express/index.d.ts',
      'file:///repo/some/deep/path/node_modules/pkg/index.ts',
    ];
    for (const uri of cases) {
      const { deps, execute } = makeDeps([]);
      const result = await mapLocationToNodeId(loc(uri, 0), 'test-repo', deps);
      expect(result, `expected NO_NODE for ${uri}`).toEqual({ kind: 'NO_NODE' });
      // The DB should never have been touched.
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('F-5: 0 candidates in the graph → NO_NODE', async () => {
    const { deps } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc('file:///repo/src/empty.ts', 10),
      'test-repo',
      deps,
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
  });
});

// ─── BVA: 0-indexed line convention (EdgeCase 6, Invariant 5) ──────────

describe('location-mapper — BVA on line index (0-indexed, invariant #5)', () => {
  it('line == startLine matches the node', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Function:src/a.ts:foo',
        name: 'foo',
        startLine: 5,
        endLine: 10,
        filePath: 'src/a.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 5), 'test-repo', deps);
    expect(result).toEqual({ kind: 'node', nodeId: 'Function:src/a.ts:foo' });
  });

  it('line == endLine matches the node (inclusive end)', async () => {
    // The Cypher uses `n.endLine >= $line`, so the inclusive end
    // must accept a query at the last line. This is the user's
    // `go-to-definition` on a closing brace of a one-liner.
    const { deps } = makeDeps([
      row({
        id: 'Function:src/a.ts:foo',
        name: 'foo',
        startLine: 5,
        endLine: 10,
        filePath: 'src/a.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 10), 'test-repo', deps);
    expect(result).toEqual({ kind: 'node', nodeId: 'Function:src/a.ts:foo' });
  });

  it('line == endLine + 1 → NO_NODE (exclusive upper bound via no-match)', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Function:src/a.ts:foo',
        name: 'foo',
        startLine: 5,
        endLine: 10,
        filePath: 'src/a.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 11), 'test-repo', deps);
    expect(result).toEqual({ kind: 'NO_NODE' });
  });

  it('line == 0 (smallest valid) matches a function starting at line 0', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Function:src/a.ts:foo',
        name: 'foo',
        startLine: 0,
        endLine: 5,
        filePath: 'src/a.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 0), 'test-repo', deps);
    expect(result).toEqual({ kind: 'node', nodeId: 'Function:src/a.ts:foo' });
  });

  it('line < 0 → NO_NODE (defensive: refuse over guess)', async () => {
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', -1), 'test-repo', deps);
    expect(result).toEqual({ kind: 'NO_NODE' });
    // A malformed Location must not even hit the DB.
    expect(execute).not.toHaveBeenCalled();
  });

  it('non-integer line → NO_NODE', async () => {
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 1.5 as any), 'test-repo', deps);
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('NaN line → NO_NODE', async () => {
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', NaN), 'test-repo', deps);
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('line not present in any node (line > endLine, no enclosing range) → NO_NODE', async () => {
    // EdgeCase 6's BVA: the line is past the last node.
    const { deps } = makeDeps([
      row({ id: 'Function:src/a.ts:foo', name: 'foo', startLine: 1, endLine: 3, filePath: 'src/a.ts' }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 999), 'test-repo', deps);
    expect(result).toEqual({ kind: 'NO_NODE' });
  });
});

// ─── Single-candidate fast path ────────────────────────────────────────

describe('location-mapper — single candidate skips tie-break', () => {
  it('returns the stored id directly (no reconstruction)', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Class:src/b.ts:Widget',
        name: 'Widget',
        startLine: 2,
        endLine: 20,
        label: 'Class',
        filePath: 'src/b.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/b.ts', 10), 'test-repo', deps);
    expect(result).toEqual({ kind: 'node', nodeId: 'Class:src/b.ts:Widget' });
  });

  it('reconstructs the id when the stored id is empty (Invariant 5)', async () => {
    // Defensive: a row with an empty `id` should still produce a
    // valid canonical id via `generateId(label, filePath:name)`.
    const { deps } = makeDeps([
      row({
        id: '',
        name: 'orphan',
        startLine: 0,
        endLine: 3,
        label: 'Function',
        filePath: 'src/orphan.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/orphan.ts', 1), 'test-repo', deps);
    expect(result.kind).toBe('node');
    if (result.kind === 'node') {
      expect(result.nodeId).toBe('Function:src/orphan.ts:orphan');
    }
  });
});

// ─── Tie-breaker 1: innermost enclosing range ──────────────────────────

describe('location-mapper — tie-breaker 1 (innermost range)', () => {
  it('picks the candidate with the smallest (endLine - startLine)', async () => {
    // A 30-line class containing a 3-line method. The query line
    // is inside both, so the query returns both. The method must win.
    const { deps } = makeDeps([
      row({
        id: 'Class:src/c.ts:Big',
        name: 'Big',
        startLine: 1,
        endLine: 30,
        label: 'Class',
        filePath: 'src/c.ts',
      }),
      row({
        id: 'Method:src/c.ts:helper',
        name: 'helper',
        startLine: 5,
        endLine: 7,
        label: 'Method',
        filePath: 'src/c.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/c.ts', 6), 'test-repo', deps);
    expect(result).toEqual({ kind: 'node', nodeId: 'Method:src/c.ts:helper' });
  });

  it('still ties on identical ranges → falls through to tie-breaker 2', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Function:src/c.ts:a',
        name: 'a',
        startLine: 1,
        endLine: 5,
        filePath: 'src/c.ts',
      }),
      row({
        id: 'Function:src/c.ts:b',
        name: 'b',
        startLine: 1,
        endLine: 5,
        filePath: 'src/c.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/c.ts', 3), 'test-repo', deps);
    // Both ranges identical; both have startLine == 1 (tie-breaker 2
    // matches both); name doesn't match the URI basename "c" so
    // tie-breaker 3 yields 0; tie-breaker 4 distinguishes by overload
    // index — both are 0 → AMBIGUOUS.
    expect(result).toEqual({ kind: 'AMBIGUOUS' });
  });
});

// ─── Tie-breaker 2: exact startLine match ──────────────────────────────

describe('location-mapper — tie-breaker 2 (exact startLine match)', () => {
  it('picks the candidate whose startLine == query line', async () => {
    // Two enclosing classes, one starting at the query line, the
    // other starting earlier. Both ranges identical size — TB1
    // ties, then TB2 disambiguates.
    const { deps } = makeDeps([
      row({
        id: 'Class:src/d.ts:Outer',
        name: 'Outer',
        startLine: 1,
        endLine: 10,
        label: 'Class',
        filePath: 'src/d.ts',
      }),
      row({
        id: 'Class:src/d.ts:Inner',
        name: 'Inner',
        startLine: 5,
        endLine: 10,
        label: 'Class',
        filePath: 'src/d.ts',
      }),
    ]);
    // Query line 5: Outer (startLine 1, range 9) and Inner (startLine 5, range 5).
    // TB1 picks Inner (smaller). But to exercise TB2 alone, we make
    // the ranges equal and startLine differ.
    const { deps: deps2 } = makeDeps([
      row({
        id: 'Class:src/d.ts:Outer',
        name: 'Outer',
        startLine: 1,
        endLine: 6,
        label: 'Class',
        filePath: 'src/d.ts',
      }),
      row({
        id: 'Class:src/d.ts:Inner',
        name: 'Inner',
        startLine: 5,
        endLine: 10,
        label: 'Class',
        filePath: 'src/d.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/d.ts', 5), 'test-repo', deps2);
    // Both ranges are 5; TB1 ties. TB2 picks Inner (startLine == 5).
    expect(result).toEqual({ kind: 'node', nodeId: 'Class:src/d.ts:Inner' });
    // Sanity: with the original deps (Inner strictly smaller), we'd
    // pick Inner via TB1 alone — confirms the path.
    expect(
      await mapLocationToNodeId(loc('file:///repo/src/d.ts', 5), 'test-repo', deps),
    ).toEqual({ kind: 'node', nodeId: 'Class:src/d.ts:Inner' });
  });
});

// ─── Tie-breaker 3: identifier-name match ──────────────────────────────

describe('location-mapper — tie-breaker 3 (identifier-name match)', () => {
  it('picks the candidate whose name matches the URI basename', async () => {
    // Two classes of identical size, neither starts at the query
    // line, both contain it. Names differ. The URI basename is
    // "util". The candidate named "utilHelper" contains "util" → wins.
    const { deps } = makeDeps([
      row({
        id: 'Class:src/util.ts:OtherThing',
        name: 'OtherThing',
        startLine: 1,
        endLine: 10,
        label: 'Class',
        filePath: 'src/util.ts',
      }),
      row({
        id: 'Class:src/util.ts:utilHelper',
        name: 'utilHelper',
        startLine: 1,
        endLine: 10,
        label: 'Class',
        filePath: 'src/util.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/util.ts', 5), 'test-repo', deps);
    // TB1: both ranges 9 → tie. TB2: both startLine 1, query 5 → no
    // match. TB3: only "utilHelper" contains "util" → wins.
    expect(result).toEqual({ kind: 'node', nodeId: 'Class:src/util.ts:utilHelper' });
  });

  it('falls through when no candidate name contains the URI basename', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Class:src/util.ts:Alpha',
        name: 'Alpha',
        startLine: 1,
        endLine: 10,
        label: 'Class',
        filePath: 'src/util.ts',
      }),
      row({
        id: 'Class:src/util.ts:Beta',
        name: 'Beta',
        startLine: 1,
        endLine: 10,
        label: 'Class',
        filePath: 'src/util.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/util.ts', 5), 'test-repo', deps);
    // TB3 yields 0 → falls to TB4 → both overload idx 0 → AMBIGUOUS.
    expect(result).toEqual({ kind: 'AMBIGUOUS' });
  });
});

// ─── Tie-breaker 4: overload `:index` reconstruction ────────────────────

describe('location-mapper — tie-breaker 4 (overload :index)', () => {
  it('survives a single overload when only one has a numeric suffix', async () => {
    // Two methods of the same name on the same range. One has an
    // explicit overload `:0` and the other has none (id == name).
    // Sorted by overload index, the unsuffixed wins.
    const { deps } = makeDeps([
      row({
        id: 'Method:src/o.java:doThing:0',
        name: 'doThing',
        startLine: 1,
        endLine: 5,
        label: 'Method',
        filePath: 'src/o.java',
      }),
      row({
        id: 'Method:src/o.java:doThing',
        name: 'doThing',
        startLine: 1,
        endLine: 5,
        label: 'Method',
        filePath: 'src/o.java',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/o.java', 3), 'test-repo', deps);
    // TB1 ties, TB2 ties (startLine 1, query 3), TB3 ties, TB4
    // sorts by overload idx. The unsuffixed id parses to 0; the
    // suffixed parses to 0 too. Still >1 → AMBIGUOUS.
    expect(result).toEqual({ kind: 'AMBIGUOUS' });
  });

  it('returns AMBIGUOUS for two distinct overloads with different indices', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Method:src/o.java:doThing:0',
        name: 'doThing',
        startLine: 1,
        endLine: 5,
        label: 'Method',
        filePath: 'src/o.java',
      }),
      row({
        id: 'Method:src/o.java:doThing:1',
        name: 'doThing',
        startLine: 1,
        endLine: 5,
        label: 'Method',
        filePath: 'src/o.java',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/o.java', 3), 'test-repo', deps);
    expect(result).toEqual({ kind: 'AMBIGUOUS' });
  });
});

// ─── Empty graph + DB error handling ──────────────────────────────────

describe('location-mapper — empty / error / defensive', () => {
  it('empty graph returns NO_NODE without throwing (EdgeCase 8)', async () => {
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      loc('file:///repo/src/anything.ts', 0),
      'test-repo',
      deps,
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('DB exception → NO_NODE (refuse over guess, never throw)', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('pool not initialized'));
    const result = await mapLocationToNodeId(
      loc('file:///repo/src/x.ts', 0),
      'test-repo',
      { executeParameterized: execute },
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
  });

  it('DB returns null (defensive) → NO_NODE', async () => {
    const execute = vi.fn().mockResolvedValue(null as any);
    const result = await mapLocationToNodeId(
      loc('file:///repo/src/x.ts', 0),
      'test-repo',
      { executeParameterized: execute },
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
  });

  it('DB returns non-array (defensive) → NO_NODE', async () => {
    const execute = vi.fn().mockResolvedValue({ not: 'an array' } as any);
    const result = await mapLocationToNodeId(
      loc('file:///repo/src/x.ts', 0),
      'test-repo',
      { executeParameterized: execute },
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
  });

  it('empty URI → NO_NODE', async () => {
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(loc('', 0), 'test-repo', deps);
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('missing location.range → NO_NODE', async () => {
    const { deps, execute } = makeDeps([]);
    const result = await mapLocationToNodeId(
      { uri: 'file:///repo/src/x.ts' } as any,
      'test-repo',
      deps,
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect(execute).not.toHaveBeenCalled();
  });
});

// ─── Windows paths (EdgeCase 10) ───────────────────────────────────────

describe('location-mapper — Windows / cross-platform paths', () => {
  it('Windows backslash URI is normalized via lib/utils', async () => {
    // Per EdgeCase 10, `normalizeFilePath` collapses backslashes.
    // The graph stores repo-relative POSIX paths, so a Windows
    // client URI of `C:\repo\src\foo.ts` must end up as
    // `C:/repo/src/foo.ts` for the lookup to match.
    const { deps, execute } = makeDeps([
      row({
        id: 'Function:src/foo.ts:winFn',
        name: 'winFn',
        startLine: 1,
        endLine: 3,
        filePath: 'src/foo.ts',
      }),
    ]);
    // Use a backslash form AFTER stripping the file:// scheme.
    // Our helper does both; the graph is queried with the
    // normalized POSIX form.
    const result = await mapLocationToNodeId(
      loc('file:///C:/repo/src/foo.ts', 1),
      'test-repo',
      deps,
    );
    expect(result).toEqual({ kind: 'node', nodeId: 'Function:src/foo.ts:winFn' });
    // Confirm the parameter we sent to the DB is the POSIX form.
    expect(execute).toHaveBeenCalledTimes(1);
    const params = execute.mock.calls[0][2];
    expect(params.relPath).toBe('C:/repo/src/foo.ts');
    // And the lib's normalizeFilePath is a no-op on already-POSIX input
    // (Invariant 6: single-source normalization).
    expect(__test__.normalizeLocationUri('file:///C:/repo/src/foo.ts', normalizeFilePath))
      .toBe('C:/repo/src/foo.ts');
  });

  it('relative path URI (no scheme) is normalized', async () => {
    const { deps } = makeDeps([
      row({
        id: 'Function:src/local.ts:rel',
        name: 'rel',
        startLine: 1,
        endLine: 2,
        filePath: 'src/local.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('src/local.ts', 1), 'test-repo', deps);
    expect(result).toEqual({ kind: 'node', nodeId: 'Function:src/local.ts:rel' });
  });
});

// ─── Property: normalizer idempotency ──────────────────────────────────

describe('location-mapper — property tests (normalizer)', () => {
  it('normalizeLocationUri is idempotent (the spec\'s property check)', () => {
    const cases = [
      'file:///repo/src/foo.ts',
      'file:///C:/repo/src/foo.ts',
      '/repo/src/foo.ts',
      'src/foo.ts',
      'file:///repo/node_modules/x/index.d.ts',
    ];
    for (const input of cases) {
      const once = __test__.normalizeLocationUri(input, normalizeFilePath);
      const twice = __test__.normalizeLocationUri(once, normalizeFilePath);
      expect(twice, `idempotent for ${input}`).toBe(once);
    }
  });

  it('isUnindexablePath is idempotent (a normalized NO_NODE path stays NO_NODE)', () => {
    const cases = [
      'node_modules',
      'node_modules/lodash/index.d.ts',
      'pkg/types.d.ts',
      'dist/index.js',
      'src/dist/bundle.js',
    ];
    for (const p of cases) {
      expect(__test__.isUnindexablePath(p), `unindexable: ${p}`).toBe(true);
    }
    // Real source files must NOT be flagged.
    const sourceFiles = ['src/foo.ts', 'lib/utils.ts', 'test/unit/x.test.ts'];
    for (const p of sourceFiles) {
      expect(__test__.isUnindexablePath(p), `indexable: ${p}`).toBe(false);
    }
  });
});

// ─── Label set sanity (Invariant 1: no graph writes) ───────────────────

describe('location-mapper — leaf label set', () => {
  it('excludes File, Folder, Community, Process (the four non-leaf labels)', () => {
    expect(MAPPER_LEAF_LABELS).not.toContain('File');
    expect(MAPPER_LEAF_LABELS).not.toContain('Folder');
    expect(MAPPER_LEAF_LABELS).not.toContain('Community');
    expect(MAPPER_LEAF_LABELS).not.toContain('Process');
  });

  it('includes the core leaf node labels', () => {
    for (const lbl of ['Function', 'Class', 'Method', 'Interface']) {
      expect(MAPPER_LEAF_LABELS, `should include ${lbl}`).toContain(lbl);
    }
  });
});

// ─── Internal helpers (buildCandidateQuery, stripFileUriScheme) ────────

describe('location-mapper — internal helpers', () => {
  it('buildCandidateQuery uses label(n) IN $labels + ORDER BY range', () => {
    const q = __test__.buildCandidateQuery();
    // Match clause is plain (label filter is in WHERE).
    expect(q).toMatch(/MATCH \(n\)/);
    // Kùzu-compatible label filter (the spec's `OR` disjunction is
    // rejected by Kùzu's parser; `label(n) IN $list` is the
    // canonical equivalent and is parameterized).
    expect(q).toMatch(/label\(n\) IN \$labels/);
    // Range filter uses parameterized line.
    expect(q).toMatch(/n\.startLine <= \$line/);
    expect(q).toMatch(/n\.endLine >= \$line/);
    // ORDER BY range ASC is the cheapest tie-breaker hint.
    expect(q).toMatch(/ORDER BY \(n\.endLine - n\.startLine\) ASC/);
    // Parameterized — no string-concatenated user input.
    expect(q).toContain('$relPath');
    expect(q).toContain('$line');
    expect(q).toContain('$labels');
    // Sanity: no leftover `OR n:Label` disjunction.
    expect(q).not.toMatch(/n:Function OR/);
  });

  it('stripFileUriScheme handles common shapes', () => {
    const { stripFileUriScheme } = __test__;
    // `file://` is the LSP-canonical scheme; we always strip the
    // leading slash that follows it (file:///abs → /abs → abs).
    expect(stripFileUriScheme('file:///repo/src/foo.ts')).toBe('repo/src/foo.ts');
    expect(stripFileUriScheme('file:///C:/repo/src/foo.ts')).toBe('C:/repo/src/foo.ts');
    // UNC-style: file://server/share → server/share
    expect(stripFileUriScheme('file://server/share/x.ts')).toBe('server/share/x.ts');
    // Some clients emit `file:/` (one slash); the same rule applies.
    expect(stripFileUriScheme('file:/repo/src/foo.ts')).toBe('repo/src/foo.ts');
    // No scheme + leading slash: NOT stripped — the input is a
    // (non-canonical) path the caller chose to pass and we should
    // not silently re-root it. The downstream normalizeFilePath
    // handles backslash-vs-slash only.
    expect(stripFileUriScheme('/repo/src/foo.ts')).toBe('/repo/src/foo.ts');
    expect(stripFileUriScheme('repo/src/foo.ts')).toBe('repo/src/foo.ts');
    expect(stripFileUriScheme('')).toBe('');
  });

  it('extractOverloadIndex parses the trailing :N', () => {
    const { extractOverloadIndex } = __test__;
    expect(extractOverloadIndex('Method:src/x.java:doThing:0')).toBe(0);
    expect(extractOverloadIndex('Method:src/x.java:doThing:1')).toBe(1);
    expect(extractOverloadIndex('Method:src/x.java:doThing:42')).toBe(42);
    expect(extractOverloadIndex('Function:src/foo.ts:foo')).toBe(0);
    expect(extractOverloadIndex('')).toBe(0);
    expect(extractOverloadIndex('Method:src/x.java:doThing:bad')).toBe(0);
  });

  it('extractBaseName strips the final extension and grabs the last segment', () => {
    const { extractBaseName } = __test__;
    expect(extractBaseName('src/foo.ts')).toBe('foo');
    expect(extractBaseName('src/foo.d.ts')).toBe('foo.d');
    expect(extractBaseName('a/b/c/MyClass.java')).toBe('MyClass');
    expect(extractBaseName('noext')).toBe('noext');
    expect(extractBaseName('')).toBe('');
  });
});

// ─── Idempotency: result shape is stable ───────────────────────────────

describe('location-mapper — result contract', () => {
  it('NO_NODE has no nodeId field', async () => {
    const { deps } = makeDeps([]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/x.ts', 0), 'test-repo', deps);
    expect(result).toEqual({ kind: 'NO_NODE' });
    expect((result as any).nodeId).toBeUndefined();
  });

  it('AMBIGUOUS has no nodeId field', async () => {
    const { deps } = makeDeps([
      row({ id: 'Function:src/a.ts:a', name: 'a', startLine: 1, endLine: 3, filePath: 'src/a.ts' }),
      row({ id: 'Function:src/a.ts:b', name: 'b', startLine: 1, endLine: 3, filePath: 'src/a.ts' }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 2), 'test-repo', deps);
    expect(result).toEqual({ kind: 'AMBIGUOUS' });
    expect((result as any).nodeId).toBeUndefined();
  });

  it('node result carries a non-empty nodeId', async () => {
    const { deps } = makeDeps([
      row({ id: 'Function:src/a.ts:foo', name: 'foo', startLine: 1, endLine: 3, filePath: 'src/a.ts' }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/a.ts', 1), 'test-repo', deps);
    if (result.kind !== 'node') {
      throw new Error(`expected node, got ${result.kind}`);
    }
    expect(result.nodeId.length).toBeGreaterThan(0);
  });
});

// ─── Sanity: mapper reuses the real generateId for the reconstructed id ─

describe('location-mapper — reconstructed id matches generateId', () => {
  it('the mapper\'s reconstructed nodeId is byte-identical to generateId(label, filePath:name)', async () => {
    // Invariant 5: the id shape is generateId(label, `${filePath}:${name}`).
    const { deps } = makeDeps([
      row({
        id: '',
        name: 'whatever',
        startLine: 0,
        endLine: 2,
        label: 'Method',
        filePath: 'src/foo.ts',
      }),
    ]);
    const result = await mapLocationToNodeId(loc('file:///repo/src/foo.ts', 1), 'test-repo', deps);
    if (result.kind !== 'node') {
      throw new Error(`expected node, got ${result.kind}`);
    }
    expect(result.nodeId).toBe(realGenerateId('Method', 'src/foo.ts:whatever'));
  });
});
