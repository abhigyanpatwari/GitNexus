// U10 — characterize two sound-but-silent CALL_SUMMARY (return-value ascent)
// coverage gaps:
//   1. Non-TS/JS languages produce EMPTY summaries — only the TS/JS harvester
//      stamps the producer `formalIndex` the ascent needs.
//   2. Constructors are excluded from the functionish node index, so a
//      constructor never receives a CALL_SUMMARY edge (FUNCTIONISH_LABELS).

import { describe, it, expect } from 'vitest';
import { cfgOf, cfgsOf } from '../../helpers/ts-cfg-harness.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import { computeReachingDefs } from '../../../src/core/ingestion/cfg/reaching-defs.js';
import { harvestCallSummary } from '../../../src/core/ingestion/taint/call-summary-harvest.js';
import {
  buildFunctionNodeIndex,
  harvestFileCallSummaries,
} from '../../../src/core/ingestion/taint/summary-harvest-driver.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';

describe('CALL_SUMMARY language coverage (U10)', () => {
  it('a non-TS/JS function (param bindings without producer formalIndex) yields an EMPTY summary', () => {
    // Only the TS/JS harvester stamps `formalIndex`; every other language leaves
    // it undefined, so return-value ascent is structurally empty there. Model
    // that by stripping formalIndex from a real CFG's param bindings.
    const cfg: FunctionCfg = cfgOf(`function f(a: string, b: string) { return b; }`);
    const nonTs: FunctionCfg = {
      ...cfg,
      bindings: cfg.bindings?.map(({ formalIndex: _omit, ...rest }) => rest),
    };
    const result = harvestCallSummary(nonTs, computeReachingDefs(nonTs));
    expect(result).toMatchObject({ status: 'computed', facts: { returnFlowParams: [] } });
  });
});

describe('buildFunctionNodeIndex — Constructor exclusion (U10)', () => {
  it('joins same-line functions by column and never aliases a missing callable to its neighbor (#3489)', () => {
    const cfgs = cfgsOf(
      'function first(v: string) { return v; } function second(v: string) { return v; }',
    );
    const graph = createKnowledgeGraph();
    for (const [i, cfg] of cfgs.entries()) {
      graph.addNode({
        id: `Function:${i}`,
        label: 'Function',
        properties: {
          name: `fn${i}`,
          filePath: cfg.filePath,
          startLine: cfg.functionStartLine - 1,
          startColumn: cfg.functionStartColumn,
        },
      });
    }
    const all = harvestFileCallSummaries(buildFunctionNodeIndex(graph), cfgs);
    expect(all.unresolved).toBe(0);
    expect(all.summaries.map((s) => s.fnId).sort()).toEqual(['Function:0', 'Function:1']);
    const partial = createKnowledgeGraph();
    partial.addNode(graph.getNode('Function:0')!);
    const missing = harvestFileCallSummaries(buildFunctionNodeIndex(partial), cfgs);
    expect(missing.unresolved).toBe(1);
    expect(missing.summaries.map((s) => s.fnId)).toEqual(['Function:0']);
  });
  it('indexes Function and Method nodes but NOT Constructor (no return-value ascent)', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:f.ts:fn',
      label: 'Function',
      properties: { name: 'fn', filePath: 'f.ts', startLine: 10 },
    });
    graph.addNode({
      id: 'Method:f.ts:m',
      label: 'Method',
      properties: { name: 'm', filePath: 'f.ts', startLine: 30 },
    });
    graph.addNode({
      id: 'Constructor:f.ts:ctor',
      label: 'Constructor',
      properties: { name: 'ctor', filePath: 'f.ts', startLine: 20 },
    });
    const index = buildFunctionNodeIndex(graph);
    expect(index.get('f.ts')?.get(10)).toEqual(['Function:f.ts:fn']);
    expect(index.get('f.ts')?.get(30)).toEqual(['Method:f.ts:m']);
    // The Constructor's start line is absent → resolveFnId returns undefined for
    // it (unresolved), so no CALL_SUMMARY summary is harvested.
    expect(index.get('f.ts')?.get(20)).toBeUndefined();
  });
});
