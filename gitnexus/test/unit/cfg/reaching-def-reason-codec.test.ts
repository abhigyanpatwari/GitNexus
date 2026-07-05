import { describe, it, expect } from 'vitest';
import {
  encodeReachingDefReason,
  encodeReachingDefReasonPairs,
  decodeReachingDefReason,
  REACHING_DEF_REASON_CODEC_VERSION,
} from '../../../src/core/ingestion/cfg/reaching-def-reason-codec.js';
import { sanitizeUTF8, escapeCSVField } from '../../../src/core/lbug/csv-generator.js';

// FU-B-2: the REACHING_DEF `reason` codec carries the binding NAME (first,
// verbatim — `pdg_query` flows keys on it) plus a compact versioned annotation
// holding the ORDERED LIST of def/use-line pairs for the (block-pair, binding)
// group. The statement-granular intra-block projection (pdg-impact.ts) walks the
// annotation's def→use pairs to recover a coalesced block's interior dependents,
// so the round-trip + CSV-survival contract is load-bearing.

describe('FU-B-2 reaching-def reason codec', () => {
  it('round-trips name + a single def/use pair', () => {
    const wire = encodeReachingDefReason('acc', 7, 9);
    expect(wire).toBe(`acc|${REACHING_DEF_REASON_CODEC_VERSION}:7:9`);
    expect(decodeReachingDefReason(wire)).toEqual({
      name: 'acc',
      pairs: [{ defLine: 7, useLine: 9 }],
      defLine: 7,
      useLine: 9,
    });
  });

  it('round-trips a MULTI-pair list (same-binding reassignment chain)', () => {
    // `acc = f(acc); acc = g(acc); acc = h(acc)` — one (self-block, accIdx) group,
    // three def→use steps. The full list must survive so the projection walk can
    // chain 24->25->26->27 to fixpoint (a first-pair-only encoding would stop at 25).
    const wire = encodeReachingDefReasonPairs('acc', [
      { defLine: 24, useLine: 25 },
      { defLine: 25, useLine: 26 },
      { defLine: 26, useLine: 27 },
    ]);
    expect(wire).toBe(`acc|${REACHING_DEF_REASON_CODEC_VERSION}:24:25;25:26;26:27`);
    expect(decodeReachingDefReason(wire)).toEqual({
      name: 'acc',
      pairs: [
        { defLine: 24, useLine: 25 },
        { defLine: 25, useLine: 26 },
        { defLine: 26, useLine: 27 },
      ],
      // `defLine`/`useLine` mirror the FIRST pair for back-compat consumers.
      defLine: 24,
      useLine: 25,
    });
  });

  it('decodes a self-edge (defLine === useLine) — a same-line read-then-write', () => {
    const wire = encodeReachingDefReason('x', 12, 12);
    expect(decodeReachingDefReason(wire)).toEqual({
      name: 'x',
      pairs: [{ defLine: 12, useLine: 12 }],
      defLine: 12,
      useLine: 12,
    });
  });

  it('preserves a synthetic-binding name (`name@module`) verbatim — `@` is not the separator', () => {
    const wire = encodeReachingDefReason('config@module', 3, 40);
    expect(decodeReachingDefReason(wire)).toEqual({
      name: 'config@module',
      pairs: [{ defLine: 3, useLine: 40 }],
      defLine: 3,
      useLine: 40,
    });
  });

  it('a legacy bare-name reason (no annotation) decodes to the name with no pairs', () => {
    expect(decodeReachingDefReason('total')).toEqual({ name: 'total', pairs: [] });
  });

  it('drops a malformed/negative line to the bare name (sound default — never a bad annotation)', () => {
    expect(encodeReachingDefReason('y', -1, 9)).toBe('y');
    expect(encodeReachingDefReason('y', 7, Number.NaN)).toBe('y');
    expect(decodeReachingDefReason(encodeReachingDefReason('y', -1, 9))).toEqual({
      name: 'y',
      pairs: [],
    });
  });

  it('drops a single malformed pair but keeps the well-formed pairs of the list', () => {
    // `<name>|1:1:2;bad;5:6` — the middle chunk is not a `def:use` pair; it is
    // dropped, the rest kept (the decoder never throws and never loses good pairs).
    expect(decodeReachingDefReason('w|1:1:2;bad;5:6')).toEqual({
      name: 'w',
      pairs: [
        { defLine: 1, useLine: 2 },
        { defLine: 5, useLine: 6 },
      ],
      defLine: 1,
      useLine: 2,
    });
  });

  it('never throws on garbage — yields the best-effort name, no pairs', () => {
    expect(decodeReachingDefReason(undefined)).toEqual({ name: '', pairs: [] });
    expect(decodeReachingDefReason(123)).toEqual({ name: '', pairs: [] });
    // wrong version / shape → name kept, annotation discarded
    expect(decodeReachingDefReason('z|9:1:2')).toEqual({ name: 'z', pairs: [] });
    expect(decodeReachingDefReason('z|1:abc:2')).toEqual({ name: 'z', pairs: [] });
    expect(decodeReachingDefReason('z|1:2')).toEqual({ name: 'z', pairs: [] });
  });

  it('survives escapeCSVField ∘ sanitizeUTF8 byte-exact (printable ASCII only)', () => {
    const wire = encodeReachingDefReasonPairs('count', [
      { defLine: 100, useLine: 250 },
      { defLine: 250, useLine: 400 },
    ]);
    expect(sanitizeUTF8(wire)).toBe(wire);
    // round-trips out of the escaped CSV cell (strip the surrounding quotes)
    const escaped = escapeCSVField(wire);
    const unquoted = escaped.slice(1, -1).replace(/""/g, '"');
    expect(decodeReachingDefReason(unquoted)).toEqual({
      name: 'count',
      pairs: [
        { defLine: 100, useLine: 250 },
        { defLine: 250, useLine: 400 },
      ],
      defLine: 100,
      useLine: 250,
    });
  });
});
