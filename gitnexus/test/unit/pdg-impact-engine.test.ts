import { describe, expect, it } from 'vitest';
import { IMPACT_MAX_DEPTH } from '../../src/mcp/tools.js';
import { pdgLayerStatus, runImpactPDG } from '../../src/mcp/local/pdg-impact.js';

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
