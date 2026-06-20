/**
 * PDG FU-C (U-C2) — per-function RETURN-VALUE ASCENT harvest soundness.
 *
 * Fixtures parse REAL TypeScript through the shared CFG harness, so the harvester
 * consumes the exact `FunctionCfg` / `FunctionDefUse` the pipeline produces. The
 * load-bearing invariant proved here: `returnFlowParams` is either the correct
 * 0-based ENCLOSING FORMAL positions or empty — NEVER a flattened binding ordinal
 * that misattributes a destructured/rest formal's flow to a later simple formal
 * (the consumer reads the bitset positionally, so an ordinal would be UNSOUND).
 */

import { describe, it, expect } from 'vitest';
import { cfgOf } from '../../helpers/ts-cfg-harness.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import { computeReachingDefs } from '../../../src/core/ingestion/cfg/reaching-defs.js';
import { harvestCallSummary } from '../../../src/core/ingestion/taint/call-summary-harvest.js';

function harvest(code: string, fnIndex = 0) {
  const cfg: FunctionCfg = cfgOf(code, fnIndex);
  const defUse = computeReachingDefs(cfg);
  return harvestCallSummary(cfg, defUse);
}

describe('harvestCallSummary — simple-formal precision', () => {
  it('records a single param flowing straight to the return as formal 0', () => {
    expect(harvest(`function f(x: string) { return x; }`)).toMatchObject({
      status: 'computed',
      facts: { paramCount: 1, returnFlowParams: [0] },
    });
  });

  it('records the SECOND simple formal flowing to return as formal 1 (not 0)', () => {
    expect(harvest(`function f(a: string, b: string) { return b; }`)).toMatchObject({
      status: 'computed',
      facts: { paramCount: 2, returnFlowParams: [1] },
    });
  });

  it('records a param returned through a local assignment', () => {
    expect(harvest(`function f(x: string) { const y = x; return y; }`).facts).toMatchObject({
      returnFlowParams: [0],
    });
  });

  it('records only the flowing formal among several simple params', () => {
    expect(harvest(`function add(a: number, b: number) { return a + 1; }`).facts).toMatchObject({
      paramCount: 2,
      returnFlowParams: [0],
    });
  });
});

describe('harvestCallSummary — destructured / rest formal SOUNDNESS (no false attribution)', () => {
  it('destructured formal BEFORE a simple formal yields the formal-0 position, NEVER ordinal 1', () => {
    // `function f({a, b}, c) { return b }` — b is an inner name of the destructured
    // formal at position 0, NOT formal 1 (= c). The flattened binding ordinal of b
    // is 1, which the positional consumer would read as "c flows" — a FALSE claim.
    // The fix keys on the enclosing FORMAL position, so this is [0], and crucially
    // it is NEVER [1].
    const facts = harvest(
      `function f({ a, b }: { a: string; b: string }, c: string) { return b; }`,
    ).facts;
    expect(facts).toMatchObject({ returnFlowParams: [0] });
    expect(facts.returnFlowParams).not.toContain(1);
  });

  it('simple formal BEFORE a destructured formal yields formal-1 for the inner name', () => {
    // `function g(a, {b, c}) { return c }` — c is an inner name of the destructured
    // formal at position 1, so the recorded return-flow position is 1.
    expect(
      harvest(`function g(a: string, { b, c }: { b: string; c: string }) { return c; }`).facts,
    ).toMatchObject({ returnFlowParams: [1] });
  });

  it('a returned simple formal that follows a rest formal keeps its own formal position', () => {
    // `function r(a, ...rest) { return a }` — a is formal 0, rest is formal 1.
    expect(harvest(`function r(a: string, ...rest: string[]) { return a; }`).facts).toMatchObject({
      returnFlowParams: [0],
    });
  });
});

describe('harvestCallSummary — conservative fallback (formalIndex absent ⇒ EMPTY, never wrong)', () => {
  it('emits an EMPTY summary when a param binding lacks a producer-supplied formalIndex', () => {
    // A producer that does not stamp `formalIndex` (e.g. a stale warm-cache shape)
    // cannot prove ordinal == formal slot, so the harvest must fall back to EMPTY —
    // a documented MISS, never a flattened ordinal. Strip the field to simulate it.
    const cfg = cfgOf(`function f(a: string, b: string) { return b; }`);
    const stripped: FunctionCfg = {
      ...cfg,
      // Re-build each binding WITHOUT formalIndex (rest-destructure drops it).
      bindings: cfg.bindings?.map(({ formalIndex: _omit, ...rest }) => rest),
    };
    const defUse = computeReachingDefs(stripped);
    expect(harvestCallSummary(stripped, defUse)).toMatchObject({
      status: 'computed',
      facts: { paramCount: 2, returnFlowParams: [] },
    });
  });

  it('reports a coverage gap when reaching-defs is not computed (no bindings)', () => {
    const cfg = cfgOf(`function f(x: string) { return x; }`);
    const bare: FunctionCfg = { ...cfg, bindings: undefined };
    const defUse = computeReachingDefs(bare);
    expect(harvestCallSummary(bare, defUse)).toMatchObject({ status: 'coverage-gap' });
  });
});

describe('harvestCallSummary — empty/void cases', () => {
  it('a void function (no return value) records no return-flow', () => {
    expect(harvest(`function f(x: string) { x.trim(); }`).facts).toMatchObject({
      returnFlowParams: [],
    });
  });

  it('a param-less function records no return-flow', () => {
    expect(harvest(`function f() { const a = 1; return a; }`).facts).toMatchObject({
      paramCount: 0,
      returnFlowParams: [],
    });
  });
});
