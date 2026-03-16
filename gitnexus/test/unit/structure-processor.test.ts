import { describe, it, expect } from 'vitest';
import { processStructure } from '../../src/core/ingestion/structure-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

describe('processStructure', () => {
  it('creates File nodes for each path', () => {
    const graph = createKnowledgeGraph();
    processStructure(graph, ['src/index.ts', 'src/utils.ts']);
    const fileNodes = graph.nodes.filter(n => n.label === 'File');
    expect(fileNodes).toHaveLength(2);
    expect(fileNodes.map(n => n.properties.name)).toContain('index.ts');
    expect(fileNodes.map(n => n.properties.name)).toContain('utils.ts');
  });

  it('creates Folder nodes for directories', () => {
    const graph = createKnowledgeGraph();
    processStructure(graph, ['src/lib/utils.ts']);
    const folderNodes = graph.nodes.filter(n => n.label === 'Folder');
    expect(folderNodes.map(n => n.properties.name)).toContain('src');
    expect(folderNodes.map(n => n.properties.name)).toContain('lib');
  });

  it('creates CONTAINS relationships from parent to child', () => {
    const graph = createKnowledgeGraph();
    processStructure(graph, ['src/index.ts']);
    const rels = graph.relationships.filter(r => r.type === 'CONTAINS');
    expect(rels).toHaveLength(1);
    expect(rels[0].sourceId).toBe('Folder:src');
    expect(rels[0].targetId).toBe('File:src/index.ts');
  });

  it('creates nested folder hierarchy', () => {
    const graph = createKnowledgeGraph();
    processStructure(graph, ['src/core/graph/types.ts']);
    const folderNodes = graph.nodes.filter(n => n.label === 'Folder');
    expect(folderNodes).toHaveLength(3); // src, core, graph
    const rels = graph.relationships.filter(r => r.type === 'CONTAINS');
    expect(rels).toHaveLength(3); // src->core, core->graph, graph->types.ts
  });

  it('deduplicates shared folders', () => {
    const graph = createKnowledgeGraph();
    processStructure(graph, ['src/a.ts', 'src/b.ts']);
    const folderNodes = graph.nodes.filter(n => n.label === 'Folder');
    // 'src' should only appear once
    expect(folderNodes.filter(n => n.properties.name === 'src')).toHaveLength(1);
  });

  it('handles single file without directory', () => {
    const graph = createKnowledgeGraph();
    processStructure(graph, ['index.ts']);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].label).toBe('File');
    expect(graph.relationships).toHaveLength(0);
  });

  it('handles empty paths array', () => {
    const graph = createKnowledgeGraph();
    processStructure(graph, []);
    expect(graph.nodeCount).toBe(0);
    expect(graph.relationshipCount).toBe(0);
  });

  it('sets CONTAINS relationship confidence to 1.0', () => {
    const graph = createKnowledgeGraph();
    processStructure(graph, ['src/index.ts']);
    const rels = graph.relationships;
    for (const rel of rels) {
      expect(rel.confidence).toBe(1.0);
    }
  });

  it('stores filePath as the full cumulative path', () => {
    const graph = createKnowledgeGraph();
    processStructure(graph, ['src/core/utils.ts']);
    const utils = graph.nodes.find(n => n.properties.name === 'utils.ts');
    expect(utils!.properties.filePath).toBe('src/core/utils.ts');
    const core = graph.nodes.find(n => n.properties.name === 'core');
    expect(core!.properties.filePath).toBe('src/core');
  });

  it('handles deeply nested paths', () => {
    const graph = createKnowledgeGraph();
    processStructure(graph, ['a/b/c/d/e.ts']);
    expect(graph.nodes.filter(n => n.label === 'Folder')).toHaveLength(4);
    expect(graph.nodes.filter(n => n.label === 'File')).toHaveLength(1);
  });

  it('generates correct node IDs', () => {
    const graph = createKnowledgeGraph();
    processStructure(graph, ['src/index.ts']);
    expect(graph.getNode('Folder:src')).toBeDefined();
    expect(graph.getNode('File:src/index.ts')).toBeDefined();
  });
});
