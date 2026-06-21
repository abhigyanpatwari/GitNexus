/**
 * U3 (#2084 M4) — interprocedural taint fixpoint.
 *
 * Pure: synthetic summaries + call edges in, cross-function findings out. No
 * graph, no parsing. Exercises the four composition shapes (one-hop seed,
 * multi-hop TITO, cross-file, recursion) plus the boundedness guards.
 */

import { describe, it, expect } from 'vitest';
import {
  solveInterprocTaint,
  type InterprocCallEdge,
} from '../../../src/core/ingestion/taint/interproc-solver.js';
import {
  ownFactsDigest,
  summaryVersion,
  type FunctionSummary,
} from '../../../src/core/ingestion/taint/summary-model.js';

let counter = 0;
function summary(
  fnId: string,
  facts: Partial<Omit<FunctionSummary, 'fnId' | 'version' | 'filePath' | 'startLine'>>,
): FunctionSummary {
  const full = {
    paramCount: facts.paramCount ?? 1,
    paramToReturn: facts.paramToReturn ?? [],
    paramToCallArg: facts.paramToCallArg ?? [],
    paramToSink: facts.paramToSink ?? [],
    sourceToReturn: facts.sourceToReturn ?? [],
    sourceToCallArg: facts.sourceToCallArg ?? [],
    callResults: facts.callResults ?? [],
  };
  return {
    fnId,
    filePath: `f${counter++}.ts`,
    startLine: 1,
    ...full,
    version: summaryVersion(ownFactsDigest(full), []),
  };
}

const map = (...ss: FunctionSummary[]) => new Map(ss.map((s) => [s.fnId, s]));

describe('solveInterprocTaint — seed path respects maxHops (#2084 review P2-7)', () => {
  it('caps the seed path at maxHops:1 (truncated prefix, not a 2-entry path)', () => {
    const A = summary('Function:a.ts:A', {
      paramCount: 0,
      sourceToCallArg: [{ sourceKind: 'remote-input', callLine: 1, argIndex: 0, calleeName: 'B' }],
    });
    const B = summary('Function:b.ts:B', {
      paramCount: 1,
      paramToSink: [{ param: 0, sinkKind: 'command-injection' }],
    });
    const r = solveInterprocTaint(
      map(A, B),
      [{ callerId: A.fnId, calleeId: B.fnId, calleeName: 'B' }],
      {
        maxHops: 1,
      },
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].hops.length).toBeLessThanOrEqual(1);
    expect(r.findings[0].hopsTruncated).toBe(true);
  });
});

describe('solveInterprocTaint — one-hop source→callee-sink', () => {
  it('finds a source passed into a callee that sinks it', () => {
    // A: source flows into helper(arg0); B(helper): param0 → sink.
    const A = summary('Function:a.ts:A', {
      paramCount: 0,
      sourceToCallArg: [{ sourceKind: 'remote-input', callLine: 5, argIndex: 0, calleeName: 'B' }],
    });
    const B = summary('Function:b.ts:B', {
      paramCount: 1,
      paramToSink: [{ param: 0, sinkKind: 'command-injection' }],
    });
    const edges: InterprocCallEdge[] = [{ callerId: A.fnId, calleeId: B.fnId, calleeName: 'B' }];
    const r = solveInterprocTaint(map(A, B), edges);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      sourceFnId: A.fnId,
      sinkFnId: B.fnId,
      sinkKind: 'command-injection',
    });
  });

  it('does not fire when the callee does not sink the param', () => {
    const A = summary('Function:a.ts:A', {
      paramCount: 0,
      sourceToCallArg: [{ sourceKind: 'remote-input', callLine: 5, argIndex: 0 }],
    });
    const B = summary('Function:b.ts:B', { paramCount: 1 });
    const r = solveInterprocTaint(map(A, B), [
      { callerId: A.fnId, calleeId: B.fnId, calleeName: 'B' },
    ]);
    expect(r.findings).toHaveLength(0);
  });
});

describe('solveInterprocTaint — multi-hop TITO', () => {
  it('propagates through a chain a → b → c(sink)', () => {
    const A = summary('Function:a.ts:A', {
      paramCount: 0,
      sourceToCallArg: [{ sourceKind: 'remote-input', callLine: 1, argIndex: 0, calleeName: 'B' }],
    });
    const B = summary('Function:b.ts:B', {
      paramCount: 1,
      paramToCallArg: [{ param: 0, callLine: 2, argIndex: 0, calleeName: 'C' }],
    });
    const C = summary('Function:c.ts:C', {
      paramCount: 1,
      paramToSink: [{ param: 0, sinkKind: 'sql-injection' }],
    });
    const edges: InterprocCallEdge[] = [
      { callerId: A.fnId, calleeId: B.fnId, calleeName: 'B' },
      { callerId: B.fnId, calleeId: C.fnId, calleeName: 'C' },
    ];
    const r = solveInterprocTaint(map(A, B, C), edges);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].sinkFnId).toBe(C.fnId);
    // hop chain: A → B → C
    expect(r.findings[0].hops.map((h) => h.fnId)).toEqual([A.fnId, B.fnId, C.fnId]);
  });
});

describe('solveInterprocTaint — cross-function sanitizer exclusions (#2084 review P1-2)', () => {
  it('a neutralized call-arg edge suppresses the callee sink of that kind', () => {
    // A's source flows into relay; relay forwards it to helper with
    // command-injection neutralised on the path; helper sinks command-injection.
    const A = summary('Function:a.ts:A', {
      paramCount: 0,
      sourceToCallArg: [
        { sourceKind: 'remote-input', callLine: 1, argIndex: 0, calleeName: 'relay' },
      ],
    });
    const relay = summary('Function:relay.ts:relay', {
      paramCount: 1,
      paramToCallArg: [
        {
          param: 0,
          callLine: 2,
          argIndex: 0,
          calleeName: 'helper',
          neutralized: ['command-injection'],
        },
      ],
    });
    const helper = summary('Function:h.ts:helper', {
      paramCount: 1,
      paramToSink: [{ param: 0, sinkKind: 'command-injection' }],
    });
    const edges: InterprocCallEdge[] = [
      { callerId: A.fnId, calleeId: relay.fnId, calleeName: 'relay' },
      { callerId: relay.fnId, calleeId: helper.fnId, calleeName: 'helper' },
    ];
    const r = solveInterprocTaint(map(A, relay, helper), edges);
    expect(r.findings).toHaveLength(0);
  });

  it('neutralization is kind-scoped — a different sink kind still fires', () => {
    const A = summary('Function:a.ts:A', {
      paramCount: 0,
      sourceToCallArg: [
        { sourceKind: 'remote-input', callLine: 1, argIndex: 0, calleeName: 'relay' },
      ],
    });
    const relay = summary('Function:relay.ts:relay', {
      paramCount: 1,
      paramToCallArg: [
        { param: 0, callLine: 2, argIndex: 0, calleeName: 'helper', neutralized: ['xss'] },
      ],
    });
    const helper = summary('Function:h.ts:helper', {
      paramCount: 1,
      paramToSink: [{ param: 0, sinkKind: 'sql-injection' }],
    });
    const edges: InterprocCallEdge[] = [
      { callerId: A.fnId, calleeId: relay.fnId, calleeName: 'relay' },
      { callerId: relay.fnId, calleeId: helper.fnId, calleeName: 'helper' },
    ];
    const r = solveInterprocTaint(map(A, relay, helper), edges);
    expect(r.findings.some((f) => f.sinkKind === 'sql-injection')).toBe(true);
  });

  it('shrink-reprocess: a less-neutralized second path re-fires the sink (no FN)', () => {
    // helper.param0 is reached from A's source two ways: via relay1 (neutralizes
    // command-injection) and via relay2 (neutralizes nothing). The un-sanitized
    // path must still produce the finding (intersection on revisit → ∅).
    const A = summary('Function:a.ts:A', {
      paramCount: 0,
      sourceToCallArg: [
        { sourceKind: 'remote-input', callLine: 1, argIndex: 0, calleeName: 'relay1' },
        { sourceKind: 'remote-input', callLine: 2, argIndex: 0, calleeName: 'relay2' },
      ],
    });
    const relay1 = summary('Function:r1.ts:relay1', {
      paramCount: 1,
      paramToCallArg: [
        {
          param: 0,
          callLine: 1,
          argIndex: 0,
          calleeName: 'helper',
          neutralized: ['command-injection'],
        },
      ],
    });
    const relay2 = summary('Function:r2.ts:relay2', {
      paramCount: 1,
      paramToCallArg: [{ param: 0, callLine: 1, argIndex: 0, calleeName: 'helper' }],
    });
    const helper = summary('Function:h.ts:helper', {
      paramCount: 1,
      paramToSink: [{ param: 0, sinkKind: 'command-injection' }],
    });
    const edges: InterprocCallEdge[] = [
      { callerId: A.fnId, calleeId: relay1.fnId, calleeName: 'relay1' },
      { callerId: A.fnId, calleeId: relay2.fnId, calleeName: 'relay2' },
      { callerId: relay1.fnId, calleeId: helper.fnId, calleeName: 'helper' },
      { callerId: relay2.fnId, calleeId: helper.fnId, calleeName: 'helper' },
    ];
    const r = solveInterprocTaint(map(A, relay1, relay2, helper), edges);
    expect(
      r.findings.some((f) => f.sinkFnId === helper.fnId && f.sinkKind === 'command-injection'),
    ).toBe(true);
  });
});

describe('solveInterprocTaint — generative sourceToReturn composition (#2084 review P1-1)', () => {
  it('composes a generative call result that hits a sink in the caller', () => {
    // getInput() returns a source; handler does exec(getInput()) — recorded as
    // a callResult{getInput, dest:sink}. No tainted INPUT, so only return
    // composition finds it.
    const getInput = summary('Function:g.ts:getInput', {
      paramCount: 0,
      sourceToReturn: [{ sourceKind: 'remote-input' }],
    });
    const handler = summary('Function:h.ts:handler', {
      paramCount: 0,
      callResults: [
        { calleeName: 'getInput', dest: { to: 'sink', sinkKind: 'command-injection' } },
      ],
    });
    const edges: InterprocCallEdge[] = [
      { callerId: handler.fnId, calleeId: getInput.fnId, calleeName: 'getInput' },
    ];
    const r = solveInterprocTaint(map(getInput, handler), edges);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      sourceFnId: getInput.fnId,
      sinkFnId: handler.fnId,
      sinkKind: 'command-injection',
    });
  });

  it('composes a generative result flowing into another callee arg → sink', () => {
    // handler: forward(getInput()); forward(z){ exec(z) }.
    const getInput = summary('Function:g.ts:getInput', {
      paramCount: 0,
      sourceToReturn: [{ sourceKind: 'remote-input' }],
    });
    const forward = summary('Function:f.ts:forward', {
      paramCount: 1,
      paramToSink: [{ param: 0, sinkKind: 'command-injection' }],
    });
    const handler = summary('Function:h.ts:handler', {
      paramCount: 0,
      callResults: [
        { calleeName: 'getInput', dest: { to: 'callArg', toCallee: 'forward', argIndex: 0 } },
      ],
    });
    const edges: InterprocCallEdge[] = [
      { callerId: handler.fnId, calleeId: getInput.fnId, calleeName: 'getInput' },
      { callerId: handler.fnId, calleeId: forward.fnId, calleeName: 'forward' },
    ];
    const r = solveInterprocTaint(map(getInput, forward, handler), edges);
    expect(r.findings.some((f) => f.sinkFnId === forward.fnId)).toBe(true);
  });

  it('transitively marks a relay that RETURNS a generative result as generative', () => {
    // wrap(){ return getInput() } then handler does exec(wrap()).
    const getInput = summary('Function:g.ts:getInput', {
      paramCount: 0,
      sourceToReturn: [{ sourceKind: 'remote-input' }],
    });
    const wrap = summary('Function:w.ts:wrap', {
      paramCount: 0,
      callResults: [{ calleeName: 'getInput', dest: { to: 'return' } }],
    });
    const handler = summary('Function:h.ts:handler', {
      paramCount: 0,
      callResults: [{ calleeName: 'wrap', dest: { to: 'sink', sinkKind: 'xss' } }],
    });
    const edges: InterprocCallEdge[] = [
      { callerId: wrap.fnId, calleeId: getInput.fnId, calleeName: 'getInput' },
      { callerId: handler.fnId, calleeId: wrap.fnId, calleeName: 'wrap' },
    ];
    const r = solveInterprocTaint(map(getInput, wrap, handler), edges);
    expect(r.findings.some((f) => f.sinkFnId === handler.fnId && f.sinkKind === 'xss')).toBe(true);
  });

  it('does NOT compose when the callee is not generative', () => {
    const pure = summary('Function:p.ts:pure', { paramCount: 0 }); // no sourceToReturn
    const handler = summary('Function:h.ts:handler', {
      paramCount: 0,
      callResults: [{ calleeName: 'pure', dest: { to: 'sink', sinkKind: 'command-injection' } }],
    });
    const edges: InterprocCallEdge[] = [
      { callerId: handler.fnId, calleeId: pure.fnId, calleeName: 'pure' },
    ];
    const r = solveInterprocTaint(map(pure, handler), edges);
    expect(r.findings).toHaveLength(0);
  });
});

describe('solveInterprocTaint — multi-source discrimination', () => {
  it('two distinct sources into one sink function both fire (no collapse)', () => {
    // A and A2 both pass a source into B's param 0, which sinks it. Without
    // source-discriminated state, B.param0 is visited once and only the first
    // source's finding survives — the M3 multi-source collapse bug class.
    const B = summary('Function:b.ts:B', {
      paramCount: 1,
      paramToSink: [{ param: 0, sinkKind: 'command-injection' }],
    });
    const A = summary('Function:a.ts:A', {
      paramCount: 0,
      sourceToCallArg: [{ sourceKind: 'remote-input', callLine: 1, argIndex: 0, calleeName: 'B' }],
    });
    const A2 = summary('Function:a2.ts:A2', {
      paramCount: 0,
      sourceToCallArg: [{ sourceKind: 'remote-input', callLine: 1, argIndex: 0, calleeName: 'B' }],
    });
    const edges: InterprocCallEdge[] = [
      { callerId: A.fnId, calleeId: B.fnId, calleeName: 'B' },
      { callerId: A2.fnId, calleeId: B.fnId, calleeName: 'B' },
    ];
    const r = solveInterprocTaint(map(A, A2, B), edges);
    const sources = new Set(r.findings.map((f) => f.sourceFnId));
    expect(sources).toEqual(new Set([A.fnId, A2.fnId]));
  });
});

describe('solveInterprocTaint — recursion / cycles', () => {
  it('terminates on direct recursion', () => {
    // R taints its own param 0 → arg 0 of itself, and sinks param 0.
    const R = summary('Function:r.ts:R', {
      paramCount: 1,
      paramToCallArg: [{ param: 0, callLine: 1, argIndex: 0, calleeName: 'R' }],
      paramToSink: [{ param: 0, sinkKind: 'command-injection' }],
    });
    const S = summary('Function:s.ts:S', {
      paramCount: 0,
      sourceToCallArg: [{ sourceKind: 'remote-input', callLine: 9, argIndex: 0, calleeName: 'R' }],
    });
    const edges: InterprocCallEdge[] = [
      { callerId: S.fnId, calleeId: R.fnId, calleeName: 'R' },
      { callerId: R.fnId, calleeId: R.fnId, calleeName: 'R' },
    ];
    const r = solveInterprocTaint(map(R, S), edges);
    // Converges; one finding S→R.
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ sourceFnId: S.fnId, sinkFnId: R.fnId });
  });

  it('terminates on mutual recursion f<->g', () => {
    const F = summary('Function:f.ts:F', {
      paramCount: 1,
      paramToCallArg: [{ param: 0, callLine: 1, argIndex: 0 }],
    });
    const G = summary('Function:g.ts:G', {
      paramCount: 1,
      paramToCallArg: [{ param: 0, callLine: 2, argIndex: 0 }],
      paramToSink: [{ param: 0, sinkKind: 'xss' }],
    });
    const S = summary('Function:s.ts:S', {
      paramCount: 0,
      sourceToCallArg: [{ sourceKind: 'remote-input', callLine: 3, argIndex: 0 }],
    });
    const edges: InterprocCallEdge[] = [
      { callerId: S.fnId, calleeId: F.fnId, calleeName: 'F' },
      { callerId: F.fnId, calleeId: G.fnId, calleeName: 'G' },
      { callerId: G.fnId, calleeId: F.fnId, calleeName: 'F' },
    ];
    const r = solveInterprocTaint(map(F, G, S), edges);
    expect(r.findings.some((f) => f.sinkFnId === G.fnId && f.sinkKind === 'xss')).toBe(true);
  });
});

describe('solveInterprocTaint — guards', () => {
  it('counts an unmatched call site (callee name resolves to no edge)', () => {
    const A = summary('Function:a.ts:A', {
      paramCount: 0,
      // The summary expects to call `Z`, but the only CALLS edge goes to `B`.
      sourceToCallArg: [{ sourceKind: 'remote-input', callLine: 99, argIndex: 0, calleeName: 'Z' }],
    });
    const B = summary('Function:b.ts:B', {
      paramCount: 1,
      paramToSink: [{ param: 0, sinkKind: 'xss' }],
    });
    const r = solveInterprocTaint(map(A, B), [
      { callerId: A.fnId, calleeId: B.fnId, calleeName: 'B' },
    ]);
    expect(r.findings).toHaveLength(0);
    expect(r.unmatchedCallSites).toBeGreaterThan(0);
  });

  it('respects an arity guard (argIndex >= callee paramCount)', () => {
    const A = summary('Function:a.ts:A', {
      paramCount: 0,
      sourceToCallArg: [{ sourceKind: 'remote-input', callLine: 1, argIndex: 3 }],
    });
    const B = summary('Function:b.ts:B', {
      paramCount: 1,
      paramToSink: [{ param: 0, sinkKind: 'xss' }],
    });
    const r = solveInterprocTaint(map(A, B), [
      { callerId: A.fnId, calleeId: B.fnId, calleeName: 'B' },
    ]);
    expect(r.findings).toHaveLength(0);
  });

  it('caps findings and reports the drop', () => {
    const sinks = Array.from({ length: 5 }, (_, i) =>
      summary(`Function:s${i}.ts:S${i}`, {
        paramCount: 1,
        paramToSink: [{ param: 0, sinkKind: 'xss' }],
      }),
    );
    const A = summary('Function:a.ts:A', {
      paramCount: 0,
      sourceToCallArg: sinks.map((_, i) => ({
        sourceKind: 'remote-input' as const,
        callLine: i + 1,
        argIndex: 0,
      })),
    });
    const edges = sinks.map((s) => ({
      callerId: A.fnId,
      calleeId: s.fnId,
      calleeName: s.fnId.split(':').pop() as string,
    }));
    const r = solveInterprocTaint(map(A, ...sinks), edges, { maxFindings: 2 });
    expect(r.findings).toHaveLength(2);
    expect(r.droppedFindings).toBe(3);
  });
});
