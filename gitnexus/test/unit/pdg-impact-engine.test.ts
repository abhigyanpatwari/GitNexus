import { describe, expect, it } from 'vitest';
import { IMPACT_MAX_DEPTH } from '../../src/mcp/tools.js';
import { runImpactPDG } from '../../src/mcp/local/pdg-impact.js';

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
