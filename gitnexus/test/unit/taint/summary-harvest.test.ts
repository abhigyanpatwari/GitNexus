/**
 * U1 (#2084 M4) — per-function taint summary harvest.
 *
 * Fixtures parse REAL TypeScript through the shared CFG/import harness, so the
 * harvester consumes the exact `FunctionCfg` / `FunctionDefUse` /
 * `FunctionSiteMatches` structures the pipeline produces. The four summary
 * edge categories are asserted directly: param→return, param→callee-arg,
 * param→sink, source→return.
 */

import { describe, it, expect } from 'vitest';
import { cfgOf, importsFor } from '../../helpers/ts-cfg-harness.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import { computeReachingDefs } from '../../../src/core/ingestion/cfg/reaching-defs.js';
import {
  buildTaintImportIndex,
  matchFunctionSites,
} from '../../../src/core/ingestion/taint/match.js';
import type { SourceSinkSanitizerSpec } from '../../../src/core/ingestion/taint/source-sink-config.js';
import { harvestFunctionSummary } from '../../../src/core/ingestion/taint/summary-harvest.js';

const SPEC: SourceSinkSanitizerSpec = {
  sources: [{ kind: 'remote-input', objects: ['req'], properties: ['body', 'query', 'params'] }],
  sinks: [
    { name: 'exec', kind: 'command-injection', args: [0], global: true },
    { name: 'query', kind: 'sql-injection', args: [0], anyReceiver: true },
  ],
  sanitizers: [{ name: 'escape', neutralizes: ['command-injection'], global: true }],
};

const CALL_RESULT_SOURCE_SPEC: SourceSinkSanitizerSpec = {
  sources: [
    {
      type: 'call-result',
      kind: 'remote-input',
      receivers: ['request'],
      methods: ['getParameter'],
    },
  ],
  sinks: [],
  sanitizers: [],
};

function harvest(code: string, spec: SourceSinkSanitizerSpec = SPEC, fnIndex = 0) {
  const cfg: FunctionCfg = cfgOf(code, fnIndex);
  const defUse = computeReachingDefs(cfg);
  const matches = matchFunctionSites(cfg, spec, buildTaintImportIndex(importsFor(code)));
  return harvestFunctionSummary(cfg, defUse, matches).facts;
}

describe('harvestFunctionSummary — param→return', () => {
  it('records a param flowing straight to return', () => {
    const f = harvest(`function f(x: string) { return x; }`);
    expect(f.paramCount).toBe(1);
    expect(f.paramToReturn).toEqual([{ param: 0 }]);
  });

  it('records a param returned through a local assignment', () => {
    const f = harvest(`function f(x: string) { const y = x; return y; }`);
    expect(f.paramToReturn).toEqual([{ param: 0 }]);
  });

  it('records receiver-TITO return (x.trim())', () => {
    const f = harvest(`function f(x: string) { return x.trim(); }`);
    expect(f.paramToReturn.map((r) => r.param)).toContain(0);
  });

  it('does not record an unrelated param', () => {
    const f = harvest(`function f(x: string, y: string) { return x; }`);
    expect(f.paramToReturn.map((r) => r.param)).toEqual([0]);
  });
});

describe('harvestFunctionSummary — param→callee-arg', () => {
  it('records a param flowing into a callee argument', () => {
    const f = harvest(`function f(x: string) { helper(x); }`);
    const ca = f.paramToCallArg;
    expect(ca.length).toBeGreaterThanOrEqual(1);
    expect(ca.some((c) => c.param === 0 && c.argIndex === 0 && c.calleeName === 'helper')).toBe(
      true,
    );
  });

  it('records the correct argument index', () => {
    const f = harvest(`function f(x: string) { helper(a, x); }`);
    expect(f.paramToCallArg.some((c) => c.param === 0 && c.argIndex === 1)).toBe(true);
  });
});

describe('harvestFunctionSummary — param→sink', () => {
  it('records a param reaching a modelled sink', () => {
    const f = harvest(`function f(x: string) { exec(x); }`);
    expect(f.paramToSink).toEqual([{ param: 0, sinkKind: 'command-injection' }]);
  });

  it('a sanitizer neutralises the matching sink kind', () => {
    const f = harvest(`function f(x: string) { const y = escape(x); exec(y); }`);
    // escape neutralises command-injection on the path to exec → no param→sink.
    expect(f.paramToSink).toEqual([]);
  });
});

describe('harvestFunctionSummary — call-arg sanitizer exclusions (#2084 review P1-2)', () => {
  it('carries the neutralized kind onto a param→callee-arg edge', () => {
    // x → escape(x) → y → helper(y): the call-arg edge to the user fn `helper`
    // records that command-injection was neutralised on the path.
    const f = harvest(`function f(x: string) { const y = escape(x); helper(y); }`);
    const edge = f.paramToCallArg.find((c) => c.calleeName === 'helper');
    if (edge === undefined) throw new Error('expected helper call-arg edge');
    expect(edge.neutralized).toEqual(['command-injection']);
  });

  it('records no neutralized when the param reaches the call directly', () => {
    const f = harvest(`function f(x: string) { helper(x); }`);
    const edge = f.paramToCallArg.find((c) => c.calleeName === 'helper');
    if (edge === undefined) throw new Error('expected helper call-arg edge');
    expect(edge.neutralized).toBeUndefined();
  });
});

describe('harvestFunctionSummary — source→callee-arg (fixpoint seed)', () => {
  it('records a source passed directly into a callee argument', () => {
    const f = harvest(`function f() { runIt(req.body); }`);
    expect(f.sourceToCallArg.some((s) => s.argIndex === 0 && s.calleeName === 'runIt')).toBe(true);
  });

  it('records a source passed via a local into a callee argument', () => {
    const f = harvest(`function f() { const u = req.body; runIt(u); }`);
    expect(f.sourceToCallArg.some((s) => s.calleeName === 'runIt')).toBe(true);
  });

  it('records an assigned call-result source passed via a local into a callee argument', () => {
    const f = harvest(
      `function f(request: { getParameter(name: string): string }) {
        const u = request.getParameter('path');
        runIt(u);
      }`,
      CALL_RESULT_SOURCE_SPEC,
    );
    expect(f.sourceToCallArg).toEqual([
      { sourceKind: 'remote-input', callLine: 3, argIndex: 0, calleeName: 'runIt' },
    ]);
  });
});

describe('harvestFunctionSummary — call-result seeds (#2084 review P1-1)', () => {
  it('records a generative call result reaching a sink via a local', () => {
    const f = harvest(`function f() { const t = getInput(); exec(t); }`);
    expect(f.callResults.some((cr) => cr.calleeName === 'getInput' && cr.dest.to === 'sink')).toBe(
      true,
    );
  });

  it('records a call result flowing into another callee arg', () => {
    const f = harvest(`function f() { const t = getInput(); forward(t); }`);
    expect(
      f.callResults.some(
        (cr) =>
          cr.calleeName === 'getInput' &&
          cr.dest.to === 'callArg' &&
          cr.dest.toCallee === 'forward',
      ),
    ).toBe(true);
  });

  it('records a bare `return getInput()` as a call result → return', () => {
    const f = harvest(`function f() { return getInput(); }`);
    expect(
      f.callResults.some((cr) => cr.calleeName === 'getInput' && cr.dest.to === 'return'),
    ).toBe(true);
  });

  it('does not record call results for sink/sanitizer calls', () => {
    const f = harvest(`function f(x: string) { exec(escape(x)); }`);
    // exec is a sink, escape is a sanitizer — neither is a user-fn call result.
    expect(f.callResults.some((cr) => cr.calleeName === 'exec' || cr.calleeName === 'escape')).toBe(
      false,
    );
  });
});

describe('harvestFunctionSummary — source→return', () => {
  it('records a generated source returned directly', () => {
    const f = harvest(`function f() { return req.body; }`);
    expect(f.sourceToReturn).toEqual([{ sourceKind: 'remote-input' }]);
  });

  it('records a generated source returned via a local', () => {
    const f = harvest(`function f() { const u = req.body; return u; }`);
    expect(f.sourceToReturn).toEqual([{ sourceKind: 'remote-input' }]);
  });

  it('records an assigned call-result source returned via a local', () => {
    const f = harvest(
      `function f(request: { getParameter(name: string): string }) {
        const u = request.getParameter('path');
        return u;
      }`,
      CALL_RESULT_SOURCE_SPEC,
    );
    expect(f.sourceToReturn).toEqual([{ sourceKind: 'remote-input' }]);
  });

  it('is empty when no source is present', () => {
    const f = harvest(`function f(x: string) { return x; }`);
    expect(f.sourceToReturn).toEqual([]);
  });
});

describe('harvestFunctionSummary — documented limitations', () => {
  it('all-simple params map to their formal argument position', () => {
    const f = harvest(`function f(a: string, b: string) { exec(b); }`);
    // `b` is formal param 1 — the index the interproc solver joins against.
    expect(f.paramToSink).toEqual([{ param: 1, sinkKind: 'command-injection' }]);
  });

  it('destructured param before a simple param shifts the index (known FN, pinned)', () => {
    // `function f([a, b], x)` — formal positions are [a,b]=0, x=1. The harvest
    // assigns by binding ordinal (a=0, b=1, x=2), so x's port is 2, not the
    // formal 1 the solver joins against → documented cross-function FN. Pinned
    // so the behaviour is a known boundary, not a silent surprise; the proper
    // fix (formal-param index from the worker) is deferred.
    const f = harvest(`function f([a, b]: string[], x: string) { exec(x); }`);
    const xSink = f.paramToSink.find((s) => s.sinkKind === 'command-injection');
    if (xSink === undefined) throw new Error('expected command-injection param sink');
    // Current (limited) behaviour: ordinal index 2, NOT the formal index 1.
    expect(xSink.param).toBe(2);
  });
});

describe('harvestFunctionSummary — edges & gaps', () => {
  it('empty summary for a param-less, site-less function', () => {
    const f = harvest(`function f() { const a = 1; return a; }`);
    expect(f.paramToReturn).toEqual([]);
    expect(f.paramToCallArg).toEqual([]);
    expect(f.paramToSink).toEqual([]);
    expect(f.sourceToReturn).toEqual([]);
  });

  it('reports a coverage gap when reaching-defs is not computed', () => {
    // A hand-built CFG with no bindings → reaching-defs returns no-facts.
    const cfg = cfgOf(`function f(x: string) { return x; }`);
    const bare = { ...cfg, bindings: undefined } as FunctionCfg;
    const defUse = computeReachingDefs(bare);
    const matches = matchFunctionSites(bare, SPEC, buildTaintImportIndex([]));
    const r = harvestFunctionSummary(bare, defUse, matches);
    expect(r.status).toBe('coverage-gap');
  });
});
