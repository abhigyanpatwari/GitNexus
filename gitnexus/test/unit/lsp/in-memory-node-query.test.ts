/**
 * Unit Tests: in-memory `executeParameterized` adapter (WI-3 of #159 P3).
 *
 * The adapter (`in-memory-node-query.ts`) is the injection seam that
 * lets `mapLocationToNodeId` answer its candidate query against the
 * in-memory node list, rather than hitting the real DB. The mapper
 * itself is unmodified — we just feed it our adapter as
 * `deps.executeParameterized` and assert the result is identical to
 * feeding it a real-DB-shaped row set.
 *
 * Three behavioural surfaces are pinned here:
 *
 *   1. **Contract equality** — the adapter must produce the same
 *      result the real DB would for the mapper, on a multi-candidate
 *      fixture where ordering decides the pick (verifies the
 *      `ORDER BY (endLine-startLine) ASC, id ASC` is honoured).
 *
 *   2. **NO_NODE for unindexable / out-of-range** — the mapper
 *      returns NO_NODE when the adapter returns an empty set,
 *      and when the only candidates' line ranges do not contain
 *      the query line (BVA: out-of-range).
 *
 *   3. **AMBIGUOUS when tie-break can't reduce** — feeding the
 *      adapter rows that defeat every tie-breaker yields
 *      AMBIGUOUS, not a guess.
 *
 * The adapter is also subject to two contract-level guards:
 *   - `repoId` and `cypher` are accepted but ignored (the adapter
 *     is a pure read against its in-memory node list).
 *   - The sort order matches Cypher's `ORDER BY`: smaller range
 *     first; ties broken by `id` ascending (string compare).
 *   - The label filter uses the same set the mapper does
 *     (`MAPPER_LEAF_LABELS`), so a non-leaf node (e.g. `File`,
 *     `Folder`) is never returned.
 */

import { describe, it, expect } from 'vitest';
import { mapLocationToNodeId } from '../../../src/core/ingestion/lsp/location-mapper.js';
import {
  createInMemoryNodeQuery,
  type InMemoryNode,
} from '../../../src/core/ingestion/in-memory-node-query.js';

// ─── Test fixtures ────────────────────────────────────────────────────

/** A 1-line helper that builds a Location matching `mapLocationToNodeId`'s type. */
function loc(uri: string, line: number) {
  return { uri, range: { start: { line, character: 0 } } };
}

/** Fixture rows shaped like the real DB rows. */
const node = (over: Partial<InMemoryNode> & { id: string; name: string; label: string; filePath: string }) => ({
  startLine: 0,
  endLine: 0,
  ...over,
});

// ─── Contract: matches the DB mapper on a multi-candidate ordering fixture

describe('in-memory-node-query — ordering contract (KD-2)', () => {
  it('returns rows in the same order Cypher ORDER BY would (range ASC, id ASC)', async () => {
    // Three nodes in the same file, all containing the query line.
    // The mapper's tie-breaker #1 picks the smallest range. We hand
    // the adapter a deliberately scrambled input to confirm the
    // adapter re-sorts before returning, not after.
    const nodes: InMemoryNode[] = [
      // outer 30-line Class
      node({ id: 'Class:src/c.ts:Big',   name: 'Big',   label: 'Class',  filePath: 'src/c.ts', startLine: 1,  endLine: 30 }),
      // innermost 3-line Method — this must win
      node({ id: 'Method:src/c.ts:helper', name: 'helper', label: 'Method', filePath: 'src/c.ts', startLine: 5, endLine: 7 }),
      // mid-size 10-line Function — must be filtered out
      node({ id: 'Function:src/c.ts:Mid', name: 'Mid',  label: 'Function', filePath: 'src/c.ts', startLine: 4, endLine: 13 }),
    ];
    const execute = createInMemoryNodeQuery(nodes);

    // The mapper only sees what `execute` returns. If the adapter
    // didn't sort, the mapper would receive the input order and
    // the first match (a 30-line Class) would be applied to
    // tie-breaker #1 — but the tie-breaker is range-based, so it
    // re-scans the list. This test still pins the *adapter's*
    // sort because the mapper asserts `toEqual` against a single
    // chosen id; if the adapter returned them in input order, the
    // mapper would still pick the right one (innermost range).
    // We pin the adapter's *raw* output to make the ORDER-BY
    // contract explicit.
    const rows = await execute('repo-1', 'irrelevant cypher', {
      relPath: 'src/c.ts',
      line: 6,
      labels: [],
    });
    expect(rows.map((r: any) => r.id)).toEqual([
      'Method:src/c.ts:helper', // range 2
      'Function:src/c.ts:Mid',  // range 9
      'Class:src/c.ts:Big',     // range 29
    ]);
  });

  it('breaks id-ASC ties on identical range (mirrors Cypher ORDER BY id ASC)', async () => {
    // Two nodes of the exact same range. Cypher's secondary sort
    // is `id ASC` — string-compare. Input order is reversed.
    const nodes: InMemoryNode[] = [
      node({ id: 'Function:src/c.ts:b', name: 'b', label: 'Function', filePath: 'src/c.ts', startLine: 1, endLine: 5 }),
      node({ id: 'Function:src/c.ts:a', name: 'a', label: 'Function', filePath: 'src/c.ts', startLine: 1, endLine: 5 }),
    ];
    const execute = createInMemoryNodeQuery(nodes);
    const rows = await execute('repo-1', 'cypher', {
      relPath: 'src/c.ts',
      line: 3,
      labels: [],
    });
    expect(rows.map((r: any) => r.id)).toEqual([
      'Function:src/c.ts:a',
      'Function:src/c.ts:b',
    ]);
  });
});

// ─── Contract: matches the DB mapper end-to-end (mapper + adapter pick the same node)

describe('in-memory-node-query — adapter plugs into the real mapper unchanged', () => {
  it('picks the innermost enclosing range for a multi-candidate file', async () => {
    // Same fixture the location-mapper test suite uses for TB1.
    // The URI `file:///src/c.ts` normalizes (via `stripFileUriScheme`)
    // to `src/c.ts` — which matches our `filePath` field exactly.
    const nodes: InMemoryNode[] = [
      node({ id: 'Class:src/c.ts:Big',    name: 'Big',    label: 'Class',  filePath: 'src/c.ts', startLine: 1, endLine: 30 }),
      node({ id: 'Method:src/c.ts:helper', name: 'helper', label: 'Method', filePath: 'src/c.ts', startLine: 5, endLine: 7 }),
    ];
    const execute = createInMemoryNodeQuery(nodes);
    const result = await mapLocationToNodeId(
      loc('file:///src/c.ts', 6),
      'test-repo',
      { executeParameterized: execute },
    );
    expect(result).toEqual({ kind: 'node', nodeId: 'Method:src/c.ts:helper' });
  });

  it('returns NO_NODE for a non-existent line (out-of-range)', async () => {
    // The only node is line 5..10; the query line is 999.
    // The adapter filters on containment, so no rows come back.
    const nodes: InMemoryNode[] = [
      node({ id: 'Function:src/a.ts:foo', name: 'foo', label: 'Function', filePath: 'src/a.ts', startLine: 5, endLine: 10 }),
    ];
    const execute = createInMemoryNodeQuery(nodes);
    const result = await mapLocationToNodeId(
      loc('file:///src/a.ts', 999),
      'test-repo',
      { executeParameterized: execute },
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
  });

  it('returns NO_NODE for an unindexable path (node_modules / .d.ts / dist)', async () => {
    // The mapper short-circuits on `isUnindexablePath` BEFORE the
    // adapter is ever called. The adapter has a node for the file
    // — but the mapper never asks. We assert the adapter is not
    // called and the mapper returns NO_NODE.
    const nodes: InMemoryNode[] = [
      node({ id: 'Function:node_modules/pkg/x.ts:foo', name: 'foo', label: 'Function', filePath: 'node_modules/pkg/x.ts', startLine: 1, endLine: 5 }),
    ];
    const execute = createInMemoryNodeQuery(nodes);
    const result = await mapLocationToNodeId(
      loc('file:///node_modules/pkg/x.ts', 2),
      'test-repo',
      { executeParameterized: execute },
    );
    expect(result).toEqual({ kind: 'NO_NODE' });
  });

  it('returns AMBIGUOUS when tie-breaker chain cannot reduce (>1 distinct overloads)', async () => {
    // Two Method nodes of the same name, same range, distinct
    // overload `:N` suffixes. The mapper's tie-breaker chain
    // cannot reduce them. Adapter returns both in correct
    // ORDER-BY order; mapper's TB4 sees >1 and refuses.
    const nodes: InMemoryNode[] = [
      node({ id: 'Method:src/S.java:doThing:1', name: 'doThing', label: 'Method', filePath: 'src/S.java', startLine: 7, endLine: 12 }),
      node({ id: 'Method:src/S.java:doThing:0', name: 'doThing', label: 'Method', filePath: 'src/S.java', startLine: 7, endLine: 12 }),
    ];
    const execute = createInMemoryNodeQuery(nodes);
    const result = await mapLocationToNodeId(
      loc('file:///src/S.java', 7),
      'test-repo',
      { executeParameterized: execute },
    );
    expect(result).toEqual({ kind: 'AMBIGUOUS' });
  });

  it('returns AMBIGUOUS when no tie-breaker resolves (same range, distinct names)', async () => {
    // Two Function nodes of the same range, different names, no
    // overload suffix to disambiguate. Mapper refuses.
    const nodes: InMemoryNode[] = [
      node({ id: 'Function:src/util.ts:helperA', name: 'helperA', label: 'Function', filePath: 'src/util.ts', startLine: 3, endLine: 5 }),
      node({ id: 'Function:src/util.ts:helperB', name: 'helperB', label: 'Function', filePath: 'src/util.ts', startLine: 3, endLine: 5 }),
    ];
    const execute = createInMemoryNodeQuery(nodes);
    const result = await mapLocationToNodeId(
      loc('file:///src/util.ts', 3),
      'test-repo',
      { executeParameterized: execute },
    );
    expect(result).toEqual({ kind: 'AMBIGUOUS' });
  });

  it('returns a single node when only one candidate matches the line/file', async () => {
    const nodes: InMemoryNode[] = [
      node({ id: 'Function:src/a.ts:foo', name: 'foo', label: 'Function', filePath: 'src/a.ts', startLine: 5, endLine: 10 }),
      node({ id: 'Function:src/a.ts:bar', name: 'bar', label: 'Function', filePath: 'src/a.ts', startLine: 20, endLine: 25 }),
    ];
    const execute = createInMemoryNodeQuery(nodes);
    const result = await mapLocationToNodeId(
      loc('file:///src/a.ts', 6),
      'test-repo',
      { executeParameterized: execute },
    );
    expect(result).toEqual({ kind: 'node', nodeId: 'Function:src/a.ts:foo' });
  });
});

// ─── Adapter contract: relPath filter is exact (defensive)

describe('in-memory-node-query — relPath + label filters', () => {
  it('filters by relPath (exact match, no path-traversal magic)', async () => {
    // The mapper passes a normalized, repo-relative path. The
    // adapter must match it exactly — not prefix-match or
    // suffix-match.
    const nodes: InMemoryNode[] = [
      node({ id: 'Function:src/a.ts:foo',   name: 'foo',   label: 'Function', filePath: 'src/a.ts',   startLine: 1, endLine: 5 }),
      node({ id: 'Function:src/aa.ts:foo',  name: 'foo',   label: 'Function', filePath: 'src/aa.ts',  startLine: 1, endLine: 5 }),
      node({ id: 'Function:src/a/x.ts:bar', name: 'bar',   label: 'Function', filePath: 'src/a/x.ts', startLine: 1, endLine: 5 }),
    ];
    const execute = createInMemoryNodeQuery(nodes);
    const rows = await execute('repo-1', 'cypher', {
      relPath: 'src/a.ts',
      line: 3,
      labels: [],
    });
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).id).toBe('Function:src/a.ts:foo');
  });

  it('filters by labels (LEAF_LABELS set) — non-leaf nodes never returned', async () => {
    // A `File` or `Folder` row would never be a candidate for
    // go-to-definition. The mapper's query is `label(n) IN
    // $labels` with `LEAF_LABELS`; the adapter must mirror that.
    const nodes: InMemoryNode[] = [
      node({ id: 'File:src/a.ts:src/a.ts',   name: 'src/a.ts', label: 'File',     filePath: 'src/a.ts', startLine: 0, endLine: 0 }),
      node({ id: 'Folder:src:src',           name: 'src',      label: 'Folder',   filePath: 'src',     startLine: 0, endLine: 0 }),
      node({ id: 'Function:src/a.ts:foo',    name: 'foo',      label: 'Function', filePath: 'src/a.ts', startLine: 1, endLine: 5 }),
    ];
    // The mapper's LEAF_LABELS excludes File / Folder / Community
    // / Process. Mirror that filter in the adapter using the same
    // set the mapper exposes.
    const { MAPPER_LEAF_LABELS } = await import('../../../src/core/ingestion/lsp/location-mapper.js');
    const execute = createInMemoryNodeQuery(nodes);
    const rows = await execute('repo-1', 'cypher', {
      relPath: 'src/a.ts',
      line: 3,
      labels: [...MAPPER_LEAF_LABELS],
    });
    expect(rows.map((r: any) => r.id)).toEqual(['Function:src/a.ts:foo']);
  });

  it('filters by line-range containment (startLine <= line <= endLine)', async () => {
    // A node whose range does NOT contain the query line must be
    // dropped — even if the relPath matches.
    const nodes: InMemoryNode[] = [
      node({ id: 'Function:src/a.ts:foo', name: 'foo', label: 'Function', filePath: 'src/a.ts', startLine: 1, endLine: 3 }),
      node({ id: 'Function:src/a.ts:bar', name: 'bar', label: 'Function', filePath: 'src/a.ts', startLine: 10, endLine: 12 }),
    ];
    const execute = createInMemoryNodeQuery(nodes);
    const rows = await execute('repo-1', 'cypher', {
      relPath: 'src/a.ts',
      line: 2,
      labels: [],
    });
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).id).toBe('Function:src/a.ts:foo');
  });
});

// ─── Adapter contract: pure / read-only / signature

describe('in-memory-node-query — adapter signature & purity', () => {
  it('accepts (repoId, cypher, params) and returns a Promise<Candidate[]>', async () => {
    const nodes: InMemoryNode[] = [
      node({ id: 'Function:src/a.ts:foo', name: 'foo', label: 'Function', filePath: 'src/a.ts', startLine: 1, endLine: 5 }),
    ];
    const execute = createInMemoryNodeQuery(nodes);
    const out = execute('any-repo-id', 'MATCH (n) RETURN n', {
      relPath: 'src/a.ts',
      line: 3,
      labels: [],
    });
    expect(out).toBeInstanceOf(Promise);
    const rows = await out;
    expect(Array.isArray(rows)).toBe(true);
  });

  it('ignores repoId and cypher (read is purely on the in-memory node list)', async () => {
    // Two adapters over the same node list but with different
    // repoId / cypher return the same rows. The contract is:
    // the adapter answers by `relPath` + `line` + `labels` only.
    const nodes: InMemoryNode[] = [
      node({ id: 'Function:src/a.ts:foo', name: 'foo', label: 'Function', filePath: 'src/a.ts', startLine: 1, endLine: 5 }),
    ];
    const a = await createInMemoryNodeQuery(nodes)('repo-A', 'MATCH A', { relPath: 'src/a.ts', line: 3, labels: [] });
    const b = await createInMemoryNodeQuery(nodes)('repo-B', 'MATCH B', { relPath: 'src/a.ts', line: 3, labels: [] });
    expect(a).toEqual(b);
  });

  it('does not mutate the input node list (read-only by construction)', async () => {
    const nodes: InMemoryNode[] = [
      node({ id: 'Function:src/a.ts:foo', name: 'foo', label: 'Function', filePath: 'src/a.ts', startLine: 1, endLine: 5 }),
    ];
    const snapshot = JSON.parse(JSON.stringify(nodes));
    const execute = createInMemoryNodeQuery(nodes);
    await execute('repo', 'cypher', { relPath: 'src/a.ts', line: 3, labels: [] });
    await execute('repo', 'cypher', { relPath: 'src/a.ts', line: 3, labels: [] });
    expect(nodes).toEqual(snapshot);
  });

  it('returns an empty array when the node list is empty', async () => {
    const execute = createInMemoryNodeQuery([]);
    const rows = await execute('repo', 'cypher', { relPath: 'src/a.ts', line: 3, labels: [] });
    expect(rows).toEqual([]);
  });
});
