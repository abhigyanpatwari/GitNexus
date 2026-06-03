import { describe, it, expect } from 'vitest';
import { calculateTreeLayout } from './tree-layout';
import type { KnowledgeGraph } from '../core/graph/types';
import type { GraphNode } from 'gitnexus-shared';

function makeNode(id: string, label: string, name: string): GraphNode {
  return {
    id,
    label: label as any,
    properties: { name, filePath: '', startLine: 1, endLine: 1 },
  };
}

describe('calculateTreeLayout', () => {
  it('should place different types in correct layers', () => {
    const graph: KnowledgeGraph = {
      nodes: [
        makeNode('f1', 'Folder', 'src'),
        makeNode('file1', 'File', 'main.ts'),
        makeNode('cls1', 'Class', 'MyClass'),
        makeNode('fn1', 'Function', 'myFunc'),
      ],
      relationships: [],
    };

    const positions = calculateTreeLayout(graph);

    const folderY = positions.get('f1')!.y;
    const fileY = positions.get('file1')!.y;
    const classY = positions.get('cls1')!.y;
    const funcY = positions.get('fn1')!.y;

    // Layer ordering is visually inverted in tree view:
    // Function < Class < File < Folder
    expect(funcY).toBeLessThan(classY);
    expect(classY).toBeLessThan(fileY);
    expect(fileY).toBeLessThan(folderY);
  });

  it('should arrange many same-type nodes in a grid within a layer', () => {
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 40; i++) {
      nodes.push(makeNode(`fn${i}`, 'Function', `func${i}`));
    }

    const graph: KnowledgeGraph = { nodes, relationships: [] };
    const positions = calculateTreeLayout(graph);

    const xValues = nodes.map((n) => positions.get(n.id)!.x);
    const yValues = nodes.map((n) => positions.get(n.id)!.y);

    // Should have multiple columns (spread horizontally)
    const uniqueX = [...new Set(xValues)].sort((a, b) => a - b);
    expect(uniqueX.length).toBeGreaterThan(3);

    // Should have multiple rows (spread vertically within layer)
    const uniqueY = [...new Set(yValues)].sort((a, b) => a - b);
    expect(uniqueY.length).toBeGreaterThan(1);

    // Overall width should be significant
    const minX = Math.min(...xValues);
    const maxX = Math.max(...xValues);
    expect(maxX - minX).toBeGreaterThan(500);

    // Height spread within layer should be moderate (not a single line)
    const minY = Math.min(...yValues);
    const maxY = Math.max(...yValues);
    expect(maxY - minY).toBeGreaterThan(50);
    expect(maxY - minY).toBeLessThan(250); // But not too tall
  });

  it('should sort nodes alphabetically within layers', () => {
    const graph: KnowledgeGraph = {
      nodes: [
        makeNode('z', 'Function', 'zFn'),
        makeNode('a', 'Function', 'aFn'),
        makeNode('m', 'Function', 'mFn'),
      ],
      relationships: [],
    };

    const positions = calculateTreeLayout(graph);

    // In grid layout, 'a' should appear before 'm' and 'z' in reading order
    // (left-to-right, top-to-bottom)
    const aPos = positions.get('a')!;
    const mPos = positions.get('m')!;
    const zPos = positions.get('z')!;

    // Reading order: a comes before m, which comes before z
    const aIndex = aPos.y * 10000 + aPos.x;
    const mIndex = mPos.y * 10000 + mPos.x;
    const zIndex = zPos.y * 10000 + zPos.x;

    expect(aIndex).toBeLessThan(mIndex);
    expect(mIndex).toBeLessThan(zIndex);
  });

  it('should place multiple node types in correct layers', () => {
    const graph: KnowledgeGraph = {
      nodes: [
        makeNode('folder', 'Folder', 'src'),
        makeNode('file', 'File', 'main.ts'),
        makeNode('iface', 'Interface', 'MyInterface'),
        makeNode('enum', 'Enum', 'MyEnum'),
        makeNode('method', 'Method', 'myMethod'),
      ],
      relationships: [],
    };

    const positions = calculateTreeLayout(graph);

    // Folder now appears below files/types/methods in the inverted tree view
    expect(positions.get('file')!.y).toBeLessThan(positions.get('folder')!.y);

    // File (layer 1) should be below Class/Interface/Enum (layer 2)
    expect(positions.get('iface')!.y).toBeLessThan(positions.get('file')!.y);
    expect(positions.get('enum')!.y).toBeLessThan(positions.get('file')!.y);

    // Interface/Enum (layer 2) should be below Method (layer 3)
    expect(positions.get('method')!.y).toBeLessThan(positions.get('iface')!.y);
    expect(positions.get('method')!.y).toBeLessThan(positions.get('enum')!.y);
  });

  it('should keep node sizes reasonable', () => {
    const graph: KnowledgeGraph = {
      nodes: [
        makeNode('folder', 'Folder', 'src'),
        makeNode('file', 'File', 'main.ts'),
        makeNode('fn', 'Function', 'myFunc'),
      ],
      relationships: [],
    };

    const positions = calculateTreeLayout(graph);

    for (const id of ['folder', 'file', 'fn']) {
      expect(positions.get(id)!.size).toBeGreaterThan(2);
      expect(positions.get(id)!.size).toBeLessThan(25);
    }
  });

  it('should spread sibling branches under their structural parent in auto mode', () => {
    const graph: KnowledgeGraph = {
      nodes: [
        makeNode('folder', 'Folder', 'apps'),
        makeNode('fileA', 'File', 'a.ts'),
        makeNode('fileB', 'File', 'b.ts'),
        makeNode('fileC', 'File', 'c.ts'),
        makeNode('fnA', 'Function', 'fnA'),
        makeNode('fnB', 'Function', 'fnB'),
        makeNode('fnC', 'Function', 'fnC'),
      ],
      relationships: [
        { id: 'r1', type: 'CONTAINS', sourceId: 'folder', targetId: 'fileA' },
        { id: 'r2', type: 'CONTAINS', sourceId: 'folder', targetId: 'fileB' },
        { id: 'r3', type: 'CONTAINS', sourceId: 'folder', targetId: 'fileC' },
        { id: 'r4', type: 'DEFINES', sourceId: 'fileA', targetId: 'fnA' },
        { id: 'r5', type: 'DEFINES', sourceId: 'fileB', targetId: 'fnB' },
        { id: 'r6', type: 'DEFINES', sourceId: 'fileC', targetId: 'fnC' },
      ],
    };

    const positions = calculateTreeLayout(graph);
    const fileXs = ['fileA', 'fileB', 'fileC'].map((id) => positions.get(id)!.x);
    const fnXs = ['fnA', 'fnB', 'fnC'].map((id) => positions.get(id)!.x);

    expect(Math.max(...fileXs) - Math.min(...fileXs)).toBeGreaterThan(120);
    expect(Math.max(...fnXs) - Math.min(...fnXs)).toBeGreaterThan(120);
    expect(Math.abs(positions.get('fileA')!.x - positions.get('fnA')!.x)).toBeLessThan(120);
    expect(Math.abs(positions.get('fileB')!.x - positions.get('fnB')!.x)).toBeLessThan(120);
    expect(Math.abs(positions.get('fileC')!.x - positions.get('fnC')!.x)).toBeLessThan(120);
  });

  it('should let long edges pull connected nodes closer without breaking their layer', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => makeNode(`fn${i}`, 'Function', `fn${i}`));

    const baseline = calculateTreeLayout({ nodes, relationships: [] });
    const relaxed = calculateTreeLayout({
      nodes,
      relationships: [
        { id: 'r1', type: 'CALLS', sourceId: 'fn0', targetId: 'fn9' },
        { id: 'r2', type: 'CALLS', sourceId: 'fn1', targetId: 'fn8' },
      ],
    });

    const baselineDistance = Math.abs(baseline.get('fn0')!.x - baseline.get('fn9')!.x);
    const relaxedDistance = Math.abs(relaxed.get('fn0')!.x - relaxed.get('fn9')!.x);
    expect(relaxedDistance).toBeLessThan(baselineDistance);

    const relaxedYValues = nodes.map((node) => relaxed.get(node.id)!.y);
    const minY = Math.min(...relaxedYValues);
    const maxY = Math.max(...relaxedYValues);
    expect(maxY - minY).toBeGreaterThan(50);
    expect(maxY - minY).toBeLessThan(250);
  });

  it('should preserve layer spread under heavy edge attraction', () => {
    const nodes: GraphNode[] = [makeNode('file', 'File', 'hub.ts')];
    for (let i = 0; i < 18; i++) {
      nodes.push(makeNode(`fn${i}`, 'Function', `fn${i}`));
    }

    const relationships = Array.from({ length: 18 }, (_, i) => ({
      id: `r${i}`,
      type: 'CALLS',
      sourceId: `fn${i}`,
      targetId: 'file',
    }));

    const positions = calculateTreeLayout({ nodes, relationships });
    const functionXs = Array.from({ length: 18 }, (_, i) => positions.get(`fn${i}`)!.x);

    expect(Math.max(...functionXs) - Math.min(...functionXs)).toBeGreaterThan(280);
    expect(positions.get('file')!.y).toBeGreaterThan(positions.get('fn0')!.y);
  });
});
