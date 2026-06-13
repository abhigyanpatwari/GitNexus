import { describe, expect, it } from 'vitest';
import {
  decideSkipGraph,
  parseSkipGraphParam,
  shouldConfirmGraphLoad,
} from '../../src/lib/graph-load-decision';

const THRESHOLD = 25_000;
const EDGE_THRESHOLD = 50_000;

describe('decideSkipGraph', () => {
  it('auto-detects: skips when node count exceeds the threshold', () => {
    expect(decideSkipGraph({ explicit: undefined, nodeCount: 300_000, threshold: THRESHOLD })).toBe(
      true,
    );
  });

  it('auto-detects: keeps the full graph for small projects', () => {
    expect(decideSkipGraph({ explicit: undefined, nodeCount: 500, threshold: THRESHOLD })).toBe(
      false,
    );
  });

  it('explicit choice overrides auto-detection in both directions', () => {
    // Force chat-only even for a tiny repo.
    expect(decideSkipGraph({ explicit: true, nodeCount: 10, threshold: THRESHOLD })).toBe(true);
    // Force a full graph even for a huge repo.
    expect(decideSkipGraph({ explicit: false, nodeCount: 999_999, threshold: THRESHOLD })).toBe(
      false,
    );
  });

  it('uses strictly-greater comparison at the threshold boundary', () => {
    expect(
      decideSkipGraph({ explicit: undefined, nodeCount: THRESHOLD, threshold: THRESHOLD }),
    ).toBe(false);
    expect(
      decideSkipGraph({ explicit: undefined, nodeCount: THRESHOLD + 1, threshold: THRESHOLD }),
    ).toBe(true);
  });

  it('fails open to a full download when the node count is unknown', () => {
    expect(
      decideSkipGraph({ explicit: undefined, nodeCount: undefined, threshold: THRESHOLD }),
    ).toBe(false);
    expect(decideSkipGraph({ explicit: undefined, nodeCount: null, threshold: THRESHOLD })).toBe(
      false,
    );
    expect(decideSkipGraph({ explicit: undefined, nodeCount: NaN, threshold: THRESHOLD })).toBe(
      false,
    );
  });

  it('skips on the edge count even when nodes are under the node threshold', () => {
    // Edge-heavy, node-light repo: 20K nodes (< 25K) but 80K edges (> 50K).
    expect(
      decideSkipGraph({
        explicit: undefined,
        nodeCount: 20_000,
        threshold: THRESHOLD,
        edgeCount: 80_000,
        edgeThreshold: EDGE_THRESHOLD,
      }),
    ).toBe(true);
  });

  it('does not skip when both node and edge counts are under their thresholds', () => {
    expect(
      decideSkipGraph({
        explicit: undefined,
        nodeCount: 5_000,
        threshold: THRESHOLD,
        edgeCount: 10_000,
        edgeThreshold: EDGE_THRESHOLD,
      }),
    ).toBe(false);
  });

  it('explicit choice overrides the edge auto-detect too', () => {
    expect(
      decideSkipGraph({
        explicit: false,
        nodeCount: 1,
        threshold: THRESHOLD,
        edgeCount: 999_999,
        edgeThreshold: EDGE_THRESHOLD,
      }),
    ).toBe(false);
  });

  it('fails open when edge count is unknown and nodes are under threshold', () => {
    expect(
      decideSkipGraph({
        explicit: undefined,
        nodeCount: 5_000,
        threshold: THRESHOLD,
        edgeCount: undefined,
        edgeThreshold: EDGE_THRESHOLD,
      }),
    ).toBe(false);
  });
});

describe('parseSkipGraphParam', () => {
  it('parses affirmative values to true', () => {
    expect(parseSkipGraphParam('1')).toBe(true);
    expect(parseSkipGraphParam('true')).toBe(true);
    expect(parseSkipGraphParam('TRUE')).toBe(true);
    expect(parseSkipGraphParam(' true ')).toBe(true);
  });

  it('parses negative values to false', () => {
    expect(parseSkipGraphParam('0')).toBe(false);
    expect(parseSkipGraphParam('false')).toBe(false);
    expect(parseSkipGraphParam('False')).toBe(false);
  });

  it('returns undefined for missing or unrecognized values', () => {
    expect(parseSkipGraphParam(null)).toBeUndefined();
    expect(parseSkipGraphParam(undefined)).toBeUndefined();
    expect(parseSkipGraphParam('')).toBeUndefined();
    expect(parseSkipGraphParam('yes')).toBeUndefined();
    expect(parseSkipGraphParam('2')).toBeUndefined();
  });
});

describe('shouldConfirmGraphLoad', () => {
  it('confirms for a large repo', () => {
    expect(shouldConfirmGraphLoad(300_000, THRESHOLD)).toBe(true);
    expect(shouldConfirmGraphLoad(THRESHOLD + 1, THRESHOLD)).toBe(true);
  });

  it('does NOT confirm for a small repo at or below the threshold', () => {
    expect(shouldConfirmGraphLoad(500, THRESHOLD)).toBe(false);
    expect(shouldConfirmGraphLoad(THRESHOLD, THRESHOLD)).toBe(false);
  });

  it('confirms (fail-safe) when the node count is unknown', () => {
    // The key regression guard: an unknown count must NOT silently re-load,
    // which would risk re-introducing the #2178 hang.
    expect(shouldConfirmGraphLoad(null, THRESHOLD)).toBe(true);
    expect(shouldConfirmGraphLoad(undefined, THRESHOLD)).toBe(true);
    expect(shouldConfirmGraphLoad(NaN, THRESHOLD)).toBe(true);
  });
});
