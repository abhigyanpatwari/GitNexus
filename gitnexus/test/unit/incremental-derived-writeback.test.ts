import { describe, expect, it } from 'vitest';
import type { GraphNode } from 'gitnexus-shared';
import { NODE_TABLES } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  ftsTablesAmong,
  incrementalFtsTablesFromGraph,
  nodeTablesForIncrementalDelete,
  shouldPreservePersistedDerivedGraph,
} from '../../src/core/incremental/derived-writeback.js';

const node = (id: string, label: string, filePath: string): GraphNode =>
  ({
    id,
    label,
    properties: { filePath, name: id },
  }) as unknown as GraphNode;

describe('shouldPreservePersistedDerivedGraph (#3016)', () => {
  it('is true when the incremental diff has no deleted files', () => {
    expect(shouldPreservePersistedDerivedGraph(0)).toBe(true);
  });

  it('is false when any file was deleted (old labels are not in the fresh graph)', () => {
    expect(shouldPreservePersistedDerivedGraph(1)).toBe(false);
  });
});

describe('incrementalFtsTablesFromGraph', () => {
  it('returns only FTS tables that have write-set nodes', () => {
    const g = createKnowledgeGraph();
    g.addNode(node('f', 'File', 'a.ts'));
    g.addNode(node('fn', 'Function', 'a.ts'));
    g.addNode(node('tr', 'Trait', 'b.rs'));
    const touched = incrementalFtsTablesFromGraph(g, new Set(['a.ts']));
    expect([...touched].sort()).toEqual(['File', 'Function']);
  });

  it('ignores labels that are not FTS-indexed', () => {
    const g = createKnowledgeGraph();
    g.addNode(node('folder', 'Folder', 'src'));
    const touched = incrementalFtsTablesFromGraph(g, new Set(['src']));
    expect(touched.size).toBe(0);
  });

  it('cannot see a table whose last row the edit removed — hence the DB probe', () => {
    // The graph is what the run WILL write. A trait deleted by this edit is
    // absent here but still a row in the index, so on its own this answer
    // would leave that row behind with a live index over it. run-analyze
    // unions this with nodeTablesWithRowsForFiles for exactly that reason.
    const g = createKnowledgeGraph();
    g.addNode(node('f', 'File', 'a.rs'));
    const touched = incrementalFtsTablesFromGraph(g, new Set(['a.rs']));
    expect(touched.has('Trait')).toBe(false);
  });
});

describe('ftsTablesAmong', () => {
  it('keeps the FTS-backed tables and drops the rest', () => {
    expect([...ftsTablesAmong(['File', 'Folder', 'Function'])].sort()).toEqual([
      'File',
      'Function',
    ]);
  });

  it('is empty for a probe that found only non-indexed tables', () => {
    expect(ftsTablesAmong(['Folder']).size).toBe(0);
  });
});

describe('nodeTablesForIncrementalDelete', () => {
  it('keeps the FTS tables being rebuilt and drops the rest from the delete', () => {
    const tables = nodeTablesForIncrementalDelete(NODE_TABLES, new Set(['File', 'Function']));
    expect(tables).toContain('File');
    expect(tables).toContain('Function');
    expect(tables).not.toContain('Trait');
  });

  it('never withholds a non-FTS table, whatever is being rebuilt', () => {
    const tables = nodeTablesForIncrementalDelete(NODE_TABLES, new Set(['File']));
    expect(tables).toContain('Folder');
  });

  it('targets every FTS table when every FTS index is being rebuilt', () => {
    const tables = nodeTablesForIncrementalDelete(NODE_TABLES, new Set(NODE_TABLES));
    expect(tables).toEqual([...NODE_TABLES]);
  });
});
