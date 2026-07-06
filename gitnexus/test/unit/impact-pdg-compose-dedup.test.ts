// U5 regression — composeUnifiedPdgImpactResult must NOT double-count a symbol
// reached by BOTH the local PDG block-expansion AND the inter-procedural
// callgraph layer. The headline impactedCount / summary.direct are the distinct
// union across layers; byDepthCounts is per-depth distinct (so a symbol reached
// at two different depths legitimately appears in two depth buckets, and
// sum(byDepthCounts) can exceed impactedCount — documented, not a bug). risk
// must stay UNKNOWN (never lowered by the new count).

import { describe, it, expect } from 'vitest';
import {
  composeUnifiedPdgImpactResult,
  type PdgImpactSuccessResult,
} from '../../src/mcp/local/pdg-impact.js';

interface ByDepthItem {
  depth: number;
  id: string | null;
  name: string;
  type: string;
  filePath: string;
}

const item = (id: string | null, depth: number): ByDepthItem => ({
  depth,
  id,
  name: id ?? '(unresolved)',
  type: 'Function',
  filePath: 'src/a.ts',
});

const countsOf = (byDepth: Record<number, ByDepthItem[]>): Record<number, number> =>
  Object.fromEntries(Object.entries(byDepth).map(([d, items]) => [Number(d), items.length]));

const local = (
  byDepth: Record<number, ByDepthItem[]>,
  impactedCount: number,
): PdgImpactSuccessResult => ({
  mode: 'pdg',
  pdgResultVersion: 2,
  target: { id: 'T', name: 'criterion', type: 'Function', filePath: 'src/a.ts' },
  direction: 'downstream',
  risk: 'UNKNOWN',
  epistemic: 'pdg-intra-procedural',
  impactedCount,
  byDepth,
  byDepthCounts: countsOf(byDepth),
  summary: { direct: impactedCount, processes_affected: 0, modules_affected: 0 },
  affected_processes: [],
  affected_modules: [],
  partial: false,
  reachableBlocks: [],
  intraReachableBlocks: [],
  seedBlocks: [],
  blockCount: 0,
  affectedStatements: [],
  affectedStatementCount: 0,
  depthReached: 1,
  unresolvedBlockCount: 0,
  ambiguousProjectionCount: 0,
});

const interproc = (
  byDepth: Record<number, ByDepthItem[]>,
  impactedCount: number,
  direct: number,
) => ({
  byDepth,
  byDepthCounts: countsOf(byDepth),
  impactedCount,
  summary: { direct, processes_affected: 0, modules_affected: 0 },
  affected_processes: [],
  affected_modules: [],
  partial: false,
});

describe('composeUnifiedPdgImpactResult — cross-bucket dedup (U5)', () => {
  it('same-depth overlap → counted once (was local+interproc sum)', () => {
    // local {A,B}@d1, interproc {A,B}@d1 — both layers reach the same two symbols.
    const result = composeUnifiedPdgImpactResult(
      local({ 1: [item('A', 1), item('B', 1)] }, 2),
      interproc({ 1: [item('B', 1), item('A', 1)] }, 2, 2),
    );
    // distinct {A,B} = 2 (NOT 2+2 = 4).
    expect(result).toMatchObject({
      impactedCount: 2,
      risk: 'UNKNOWN',
      byDepthCounts: { 1: 2 },
      summary: { direct: 2 },
    });
  });

  it('disjoint layers → dedup is a no-op (full sum)', () => {
    const result = composeUnifiedPdgImpactResult(
      local({ 1: [item('A', 1)] }, 1),
      interproc({ 1: [item('B', 1)] }, 1, 1),
    );
    expect(result).toMatchObject({
      impactedCount: 2,
      byDepthCounts: { 1: 2 },
      summary: { direct: 2 },
    });
  });

  it('cross-depth same symbol → counted once in headline, retained per-depth', () => {
    // C is local@d1 AND interproc@d2 — one distinct symbol, two legitimate buckets.
    const result = composeUnifiedPdgImpactResult(
      local({ 1: [item('C', 1)] }, 1),
      interproc({ 2: [item('C', 2)] }, 1, 0),
    );
    expect(result).toMatchObject({
      impactedCount: 1, // distinct
      byDepthCounts: { 1: 1, 2: 1 }, // sum 2 > impactedCount 1, documented
      summary: { direct: 1 },
    });
  });

  it('unresolved (null-id) item is excluded from the distinct count', () => {
    const result = composeUnifiedPdgImpactResult(
      local({ 1: [item('A', 1), item(null, 1)] }, 1),
      interproc({ 1: [item('A', 1)] }, 1, 1),
    );
    expect(result).toMatchObject({ impactedCount: 1, risk: 'UNKNOWN' });
  });

  it('no inter-procedural layer → local count unchanged', () => {
    const result = composeUnifiedPdgImpactResult(
      local({ 1: [item('A', 1), item('B', 1)] }, 2),
      null,
    );
    expect(result).toMatchObject({ impactedCount: 2, summary: { direct: 2 } });
  });
});
