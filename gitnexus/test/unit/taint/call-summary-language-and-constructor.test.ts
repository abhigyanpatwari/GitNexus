// U10 — characterize two sound-but-silent CALL_SUMMARY (return-value ascent)
// coverage gaps:
//   1. Non-TS/JS languages produce EMPTY summaries — only the TS/JS harvester
//      stamps the producer `formalIndex` the ascent needs.
//   2. Constructors are excluded from the functionish node index, so a
//      constructor never receives a CALL_SUMMARY edge (FUNCTIONISH_LABELS).

import { describe, it, expect } from 'vitest';
import { cfgOf } from '../../helpers/ts-cfg-harness.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import { computeReachingDefs } from '../../../src/core/ingestion/cfg/reaching-defs.js';
import { harvestCallSummary } from '../../../src/core/ingestion/taint/call-summary-harvest.js';
import { buildFunctionNodeIndex } from '../../../src/core/ingestion/taint/summary-harvest-driver.js';
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
