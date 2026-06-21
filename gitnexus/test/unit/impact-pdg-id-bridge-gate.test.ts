// U9 — resolved-symbol-id soundness GATE scorer for the impact-PDG accuracy
// harness (plan 2026-06-18-001 U9; Covers R1, R5).
//
// Asserts the PURE gate helpers (`idProvenIdsFromResult`, `evaluateIdBridge`)
// that `bench/impact-pdg/measure.mjs` uses to gate the `intra-overloaded-callee`
// fixture — on SYNTHETIC impact-result shapes ONLY, no LocalBackend / analyze /
// DB. The helpers live in the build-free `.mjs` harness, imported directly here,
// so this test is deterministic and stays OUT of the flaky full-pipeline lane
// (mirroring impact-pdg-id-vs-name-metrics.test.ts). The live id-bridge axis
// runs only via `node --import tsx bench/impact-pdg/measure.mjs`, never in
// `npm test`.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs pure-JS harness module, no types (intentional; build-free).
import * as M from '../../bench/impact-pdg/measure.mjs';

interface ReachedItem {
  readonly id?: string;
  readonly name?: string;
  readonly filePath?: string;
  readonly pdgEvidence?: string;
}

interface IdBridgeExpectation {
  readonly seedLine?: number;
  readonly idProven?: readonly string[];
  readonly nameWouldProve?: readonly string[];
  readonly fpEliminated?: readonly string[];
}

interface IdBridgeVerdict {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly idProven: readonly string[];
  readonly nameProven: readonly string[];
  readonly fpEliminated: readonly string[];
  readonly over: number;
}

interface PdgInterproceduralShape {
  readonly statementPreciseByDepth?: Record<string, readonly ReachedItem[]>;
}
interface PdgResultShape {
  readonly pdgInterprocedural?: PdgInterproceduralShape;
}

const idProvenIdsFromResult = M.idProvenIdsFromResult as (res: PdgResultShape) => string[];
const evaluateIdBridge = M.evaluateIdBridge as (
  idProven: readonly string[],
  nameWouldProve: readonly string[],
  expected: IdBridgeExpectation,
) => IdBridgeVerdict;

// The fixture's two collision callees — same leaf `process`, distinct ids.
const ALPHA = 'Method:src/route.ts:Alpha.process#1';
const BETA = 'Method:src/route.ts:Beta.process#1';

const item = (id: string): ReachedItem => ({
  id,
  name: 'process',
  filePath: 'src/route.ts',
  pdgEvidence: 'callgraph-bridge',
});

describe('impact-pdg id-bridge gate — idProvenIdsFromResult()', () => {
  it('flattens statementPreciseByDepth across depths into a sorted id set', () => {
    const res: PdgResultShape = {
      pdgInterprocedural: {
        statementPreciseByDepth: { 1: [item(ALPHA)], 2: [item(BETA)] },
      },
    };
    expect(idProvenIdsFromResult(res)).toEqual([ALPHA, BETA].sort());
  });

  it('returns the single proven id when only the on-slice callee is statement-precise', () => {
    // The U9 soundness case: Beta is reached but unproven-bridge, so it is NOT in
    // statementPreciseByDepth — only Alpha (the on-slice callee) appears.
    const res: PdgResultShape = {
      pdgInterprocedural: { statementPreciseByDepth: { 1: [item(ALPHA)] } },
    };
    expect(idProvenIdsFromResult(res)).toEqual([ALPHA]);
  });

  it('falls back to name@filePath for an id-less reached item, never dropping it', () => {
    const res: PdgResultShape = {
      pdgInterprocedural: {
        statementPreciseByDepth: { 1: [{ name: 'dyn', filePath: 'd.ts' }] },
      },
    };
    expect(idProvenIdsFromResult(res)).toEqual(['dyn@d.ts']);
  });

  it('returns an empty set when there is no statement-precise reach', () => {
    expect(idProvenIdsFromResult({})).toEqual([]);
  });
});

describe('impact-pdg id-bridge gate — evaluateIdBridge()', () => {
  const expected: IdBridgeExpectation = {
    seedLine: 32,
    idProven: [ALPHA],
    nameWouldProve: [ALPHA, BETA],
    fpEliminated: [BETA],
  };

  it('PASSES the soundness gate: id proves exactly Alpha, name over-attributes Beta', () => {
    const v = evaluateIdBridge([ALPHA], [ALPHA, BETA], expected);
    expect(v).toMatchObject({ ok: true, over: 1 });
    expect(v.problems).toEqual([]);
    expect(v.idProven).toEqual([ALPHA]);
    expect(v.fpEliminated).toEqual([BETA]);
  });

  it('FAILS when the id-proven set over-attributes (proves both — the name-bridge bug)', () => {
    // If the id bridge regressed to prove BOTH, the id set != ground-truth single
    // id AND the name match no longer over-attributes — the gate must fail.
    const v = evaluateIdBridge([ALPHA, BETA], [ALPHA, BETA], expected);
    expect(v).toMatchObject({ ok: false, over: 0 });
    expect(v.problems.length).toBeGreaterThan(0);
  });

  it('FAILS when the id-proven set drops the correct callee (under-attribution)', () => {
    const v = evaluateIdBridge([], [ALPHA, BETA], expected);
    expect(v).toMatchObject({ ok: false });
    expect(v.problems.join(' ')).toContain('id-proven set');
  });

  it('FAILS when name-match does not over-attribute the expected collision id', () => {
    // id-proven matches, but the name counterfactual proves only Alpha (the slice
    // lost its collision power) — fpEliminated would be empty → loud failure.
    const v = evaluateIdBridge([ALPHA], [ALPHA], expected);
    expect(v).toMatchObject({ ok: false, over: 0 });
    expect(v.problems.join(' ')).toContain('over-attribute');
  });

  it('is order- and duplicate-independent over its inputs (determinism)', () => {
    const a = evaluateIdBridge([ALPHA], [BETA, ALPHA, BETA], expected);
    const b = evaluateIdBridge([ALPHA, ALPHA], [ALPHA, BETA], expected);
    expect(a).toMatchObject({ ok: true, over: 1 });
    expect(b).toMatchObject({ ok: true, over: 1 });
    expect(a.fpEliminated).toEqual(b.fpEliminated);
  });
});
