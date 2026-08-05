/**
 * B2 — a refresh that reports SUCCESS while leaving the index unusable.
 *
 * The dangerous variant of a broken refresh: metadata IS written, so the index
 * reads as fresh, hooks re-arm, and every tool answers from a graph missing
 * most of its edges — which is indistinguishable from a codebase that
 * genuinely has no such relationships. Observed as edges collapsing
 * 23009 -> 2170, and as a `CodeRelation` table that never materialized (which
 * reads back as a persisted count of zero).
 *
 * `analyze` compares the relationship count the pipeline produced against what
 * the DB hands back after the write and records `graphWriteCollapsed`. This
 * covers the translation of that record into the operator-facing reason, which
 * is what `status` and the MCP resources report.
 */
import { describe, it, expect } from 'vitest';
import {
  getIndexIncompleteReasons,
  INDEX_INCOMPLETE_REASONS,
} from '../../src/core/index-freshness.js';

describe('graph-write-collapsed incomplete reason (B2)', () => {
  it('is part of the stable reason vocabulary', () => {
    expect(INDEX_INCOMPLETE_REASONS).toContain('graph-write-collapsed');
  });

  it('reports a collapsed write as incomplete rather than fresh', () => {
    expect(
      getIndexIncompleteReasons({ graphWriteCollapsed: { expected: 23009, persisted: 2170 } }),
    ).toEqual(['graph-write-collapsed']);
  });

  it('treats a missing relation table (zero persisted) the same way', () => {
    expect(
      getIndexIncompleteReasons({ graphWriteCollapsed: { expected: 23009, persisted: 0 } }),
    ).toEqual(['graph-write-collapsed']);
  });

  it('says nothing on a healthy run', () => {
    expect(getIndexIncompleteReasons({})).toEqual([]);
    expect(getIndexIncompleteReasons(null)).toEqual([]);
  });

  it('reports alongside other reasons rather than masking them', () => {
    const reasons = getIndexIncompleteReasons({
      incrementalInProgress: { startedAt: 1, toWriteCount: 0 },
      graphWriteCollapsed: { expected: 500, persisted: 10 },
    });
    expect(reasons).toContain('incremental-in-progress');
    expect(reasons).toContain('graph-write-collapsed');
  });
});
