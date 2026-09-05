/**
 * Review finding on #3182 (name-fallback-summary.ts:104): the census
 * denominator `callsByLanguage` was never supplied in production. The pipeline
 * now builds `resolvedCalleeNamesByCaller` (caller node → callee simple names)
 * through the edge source that is complete under streaming, and `run-analyze`
 * feeds it to `countCallsByLanguage`.
 */
import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { collectResolvedCalleeNames } from '../../../src/core/ingestion/pipeline.js';
import { countCallsByLanguage } from '../../../src/core/ingestion/scope-resolution/name-fallback-summary.js';
import type { NodeLabel } from 'gitnexus-shared';

describe('collectResolvedCalleeNames', () => {
  it('groups CALLS targets by caller and ignores other edge types and nameless targets', () => {
    const g = createKnowledgeGraph();
    const fn = (id: string, name: string, filePath: string) =>
      g.addNode({ id, label: 'Function' as NodeLabel, properties: { name, filePath } });
    fn('a', 'a', 'src/a.go');
    fn('b', 'b', 'src/b.go');
    fn('c', 'c', 'src/c.ts');
    g.addNode({ id: 'file', label: 'File' as NodeLabel, properties: { filePath: 'src/a.go' } });
    g.addRelationship({ id: 'r1', sourceId: 'a', targetId: 'b', type: 'CALLS', confidence: 0.85 });
    g.addRelationship({ id: 'r2', sourceId: 'a', targetId: 'c', type: 'CALLS', confidence: 0.5 });
    g.addRelationship({ id: 'r3', sourceId: 'c', targetId: 'b', type: 'CALLS', confidence: 0.85 });
    g.addRelationship({
      id: 'r4',
      sourceId: 'file',
      targetId: 'a',
      type: 'DEFINES',
      confidence: 1,
    });
    g.addRelationship({ id: 'r5', sourceId: 'a', targetId: 'file', type: 'CALLS', confidence: 1 });

    const index = collectResolvedCalleeNames(g, g);
    expect([...index.keys()].sort()).toEqual(['a', 'c']);
    expect([...index.get('a')!].sort()).toEqual(['b', 'c']);
    expect([...index.get('c')!]).toEqual(['b']);

    // ...and it is the shape the census denominator consumes.
    expect(countCallsByLanguage(index, g)).toEqual({ go: 2, typescript: 1 });
  });
});
