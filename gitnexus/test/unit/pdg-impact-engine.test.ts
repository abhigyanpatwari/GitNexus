import { describe, expect, it } from 'vitest';
import { IMPACT_MAX_DEPTH } from '../../src/mcp/tools.js';
import {
  pdgLayerStatus,
  runImpactPDG,
  type RunPdgImpactDeps,
} from '../../src/mcp/local/pdg-impact.js';

describe('runImpactPDG', () => {
  it('clamps huge maxDepth values to the documented impact traversal cap', async () => {
    let bfsQueries = 0;
    const exec = async (_repo: string, query: string) => {
      if (query.includes('MATCH (a:BasicBlock) WHERE')) {
        return [{ id: 'BasicBlock:src/hot.ts:1:0:0' }];
      }
      if (query.includes('MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)')) {
        bfsQueries += 1;
        return [{ id: `BasicBlock:src/hot.ts:${bfsQueries + 1}:0:0` }];
      }
      if (query.includes('MATCH (b:BasicBlock) WHERE b.id IN $ids')) return [];
      if (query.includes('MATCH (s:`Function`)')) return [];
      return [];
    };

    const result = await runImpactPDG({
      repo: { lbugPath: 'repo' },
      sym: { id: 'func:hot', name: 'hot', filePath: 'src/hot.ts', startLine: 0, endLine: 0 },
      symType: 'Function',
      direction: 'downstream',
      maxDepth: Number.MAX_SAFE_INTEGER,
      limit: 50,
      executeParameterized: exec as any,
    });

    expect(bfsQueries).toBe(IMPACT_MAX_DEPTH);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('depth');
  });

  it('keeps multiple reachable BasicBlocks on the same source line as separate statements', async () => {
    let bfsQueries = 0;
    const sameLineA = 'BasicBlock:src/hot.ts:1:0:1';
    const sameLineB = 'BasicBlock:src/hot.ts:1:0:2';
    const exec = async (_repo: string, query: string) => {
      if (query.includes('MATCH (a:BasicBlock) WHERE')) {
        return [{ id: 'BasicBlock:src/hot.ts:1:0:0' }];
      }
      if (query.includes('MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)')) {
        bfsQueries += 1;
        return bfsQueries === 1 ? [{ id: sameLineB }, { id: sameLineA }] : [];
      }
      if (query.includes('MATCH (b:BasicBlock) WHERE b.id IN $ids')) {
        return [
          { id: sameLineB, line: 2, text: 'b();' },
          { id: sameLineA, line: 2, text: 'a();' },
        ];
      }
      if (query.includes('MATCH (s:`Function`)')) {
        return [{ id: 'func:hot', name: 'hot', label: 'Function', startLine: 0 }];
      }
      return [];
    };

    const result = await runImpactPDG({
      repo: { lbugPath: 'repo' },
      sym: { id: 'func:hot', name: 'hot', filePath: 'src/hot.ts', startLine: 0, endLine: 3 },
      symType: 'Function',
      direction: 'downstream',
      maxDepth: 2,
      limit: 50,
      line: 1,
      executeParameterized: exec as any,
    });

    expect(result.mode).toBe('pdg');
    expect((result as any).affectedStatementCount).toBe(2);
    expect((result as any).affectedStatements.map((s: any) => s.line)).toEqual([2, 2]);
    expect((result as any).affectedStatements.map((s: any) => s.text)).toEqual(['a();', 'b();']);
    expect((result as any).pdgEvidence.statements).toBe('local-dependence');
    expect((result as any).pdgEvidence.localSymbols).toBe('owner-projection');
    expect((result as any).byDepth[1][0].pdgEvidence).toBe('owner-projection');
  });

  it('tags affectedStatements scope=intra for criterion-function lines, scope=inter for cross-function reach (FU-A)', async () => {
    // MIXED slice: the criterion function owns fnLine 1 in src/a.ts (sym.startLine
    // 0 → ownerFnLine 1). The dependence reach surfaces TWO blocks — one in the
    // criterion's own function (fnLine 1, INTRA) and one in a callee function that
    // starts at line 5 (fnLine 5, reached across the call boundary → INTER). The
    // scope tag is a pure parse of the block id against (criterionFile, ownerFnLine);
    // each statement must carry the right tag.
    const seed = 'BasicBlock:src/a.ts:1:0:0'; // criterion fn, fnLine 1
    const intraReach = 'BasicBlock:src/a.ts:1:0:1'; // same fn → INTRA
    const interReach = 'BasicBlock:src/a.ts:5:0:0'; // callee fn fnLine 5 → INTER
    let bfsQueries = 0;
    const exec: RunPdgImpactDeps['executeParameterized'] = async (_repo, query) => {
      if (query.includes('MATCH (a:BasicBlock) WHERE')) {
        return [{ id: seed }];
      }
      if (query.includes('MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)')) {
        bfsQueries += 1;
        return bfsQueries === 1 ? [{ id: intraReach }, { id: interReach }] : [];
      }
      // Interproc descent calleeIds probe → no callees, so the descent is a no-op;
      // the cross-function block already entered the reachable set above.
      if (query.includes('RETURN b.calleeIds AS calleeIds')) return [];
      if (query.includes('MATCH (b:BasicBlock) WHERE b.id IN $ids')) {
        return [
          { id: intraReach, line: 2, text: 'x = local();' },
          { id: interReach, line: 6, text: 'return callee();' },
        ];
      }
      if (query.includes('MATCH (s:`Function`)')) return [];
      return [];
    };

    const result = await runImpactPDG({
      repo: { lbugPath: 'repo' },
      sym: { id: 'func:a', name: 'a', filePath: 'src/a.ts', startLine: 0, endLine: 3 },
      symType: 'Function',
      direction: 'downstream',
      maxDepth: 2,
      limit: 50,
      line: 1,
      executeParameterized: exec,
    });

    // Narrow to a result that carries the statement slice (no `as any`).
    expect('affectedStatements' in result).toBe(true);
    const statements = 'affectedStatements' in result ? result.affectedStatements : [];
    // Sorted by line: the intra block (line 2) precedes the inter block (line 6).
    expect(statements).toMatchObject([
      { line: 2, filePath: 'src/a.ts', scope: 'intra' },
      { line: 6, filePath: 'src/a.ts', scope: 'inter' },
    ]);
  });

  it('pins the owning function: a same-source-line closure block does not leak into the seed', async () => {
    // Symbol starts at 0 → owning fnLine === 1. The seed query (a forgiving
    // startLine-within-window match) returns BOTH the symbol's own block at the
    // seeded line AND a closure body block that happens to start on the same
    // source line but is owned by a function starting at line 5 (fnLine 5).
    const owned = 'BasicBlock:src/hot.ts:1:0:3'; // fnLine 1 === sym.startLine + 1
    const closureLeak = 'BasicBlock:src/hot.ts:5:10:0'; // fnLine 5 — a nested closure
    const exec: RunPdgImpactDeps['executeParameterized'] = async (_repo, query) => {
      if (query.includes('MATCH (a:BasicBlock) WHERE')) {
        return [{ id: owned }, { id: closureLeak }];
      }
      // No downstream reachability — exercises the seedBlocks-carrying branch.
      if (query.includes('MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)')) return [];
      if (query.includes('MATCH (b:BasicBlock) WHERE b.id IN $ids')) return [];
      if (query.includes('MATCH (s:`Function`)')) return [];
      return [];
    };

    const result = await runImpactPDG({
      repo: { lbugPath: 'repo' },
      sym: { id: 'func:hot', name: 'hot', filePath: 'src/hot.ts', startLine: 0, endLine: 20 },
      symType: 'Function',
      direction: 'downstream',
      maxDepth: 2,
      limit: 50,
      line: 7,
      executeParameterized: exec,
    });

    // Only the owning-function block survives; the closure block is dropped.
    // Unconditional match: fails if `seedBlocks` is absent, has the wrong
    // length, or contains the closure block — no vacuous branch.
    expect(result).toMatchObject({ seedBlocks: [owned] });
  });
});

describe('pdgLayerStatus', () => {
  const unreadableMeta = async () => null as any;

  it('reports visible PDG edges as unknown without a probe error when meta is unreadable', async () => {
    const result = await pdgLayerStatus({
      lbugPath: 'repo/.gitnexus/lbug',
      loadMetaFn: unreadableMeta,
      executeParameterized: (async (_repo: string, query: string) => {
        expect(query).toContain('LIMIT 1');
        return [{ type: 'CDG' }];
      }) as any,
    });

    expect(result.state).toBe('unknown');
    expect(result.note).toContain('edges ARE visible');
    expect(result.probeError).toBeUndefined();
  });

  it('reports no visible PDG edges separately from probe failures', async () => {
    const result = await pdgLayerStatus({
      lbugPath: 'repo/.gitnexus/lbug',
      loadMetaFn: unreadableMeta,
      executeParameterized: (async () => []) as any,
    });

    expect(result.state).toBe('unknown');
    expect(result.note).toContain('no CDG/REACHING_DEF edges visible');
    expect(result.probeError).toBeUndefined();
  });

  it('preserves probe failures instead of reporting a false no-edge signal', async () => {
    const result = await pdgLayerStatus({
      lbugPath: 'repo/.gitnexus/lbug',
      loadMetaFn: unreadableMeta,
      executeParameterized: (async () => {
        throw new Error('database busy');
      }) as any,
    });

    expect(result.state).toBe('unknown');
    expect(result.probeError).toBe('database busy');
    expect(result.note).toContain('probe failed');
    expect(result.note).not.toContain('no CDG/REACHING_DEF edges visible');
    expect(result.recoverySuggestion).toContain('LadybugDB');
  });
});
