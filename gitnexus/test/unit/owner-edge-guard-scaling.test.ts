import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import { createOwnerEdgeGuard } from '../../src/core/ingestion/workers/owner-edge-guard.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

type Slice = Pick<ParseWorkerResult, 'nodes' | 'relationships'>;
type Rel = Slice['relationships'][number];

const memberNode = (path: string, member: number): Slice['nodes'][number] => ({
  id: `Method:${path}:m${member}`,
  label: 'Method',
  properties: {
    name: `m${member}`,
    filePath: path,
    startLine: 0,
    endLine: 0,
    language: SupportedLanguages.TypeScript,
    isExported: false,
  },
});

const memberEdge = (type: Rel['type'], sourceId: string, targetId: string): Rel => ({
  id: `${type}:${sourceId}->${targetId}`,
  sourceId,
  targetId,
  type,
  confidence: 1,
  reason: '',
});

describe('owner-edge guard scaling', () => {
  it.each([8, 32, 128])('processes %i files without rescanning completed files', (fileCount) => {
    const prefixNode = memberNode('previous.ts', 0);
    const prefixEdge = memberEdge('DEFINES', 'File:previous.ts', prefixNode.id);
    const raw: Slice = { nodes: [prefixNode], relationships: [prefixEdge] };
    let nodeStart = 1;
    let relStart = 1;
    let nodeReads = 0;
    let relReads = 0;
    let relWrites = 0;
    const guarded: Slice = {
      nodes: new Proxy(raw.nodes, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
            expect(Number(property)).toBeGreaterThanOrEqual(nodeStart);
            nodeReads++;
          }
          return Reflect.get(target, property, receiver);
        },
      }),
      relationships: new Proxy(raw.relationships, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
            expect(Number(property)).toBeGreaterThanOrEqual(relStart);
            relReads++;
          }
          return Reflect.get(target, property, receiver);
        },
        set(target, property, value, receiver) {
          if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
            expect(Number(property)).toBeGreaterThanOrEqual(relStart);
            relWrites++;
          }
          return Reflect.set(target, property, value, receiver);
        },
      }),
    };
    const guard = createOwnerEdgeGuard(guarded);
    for (let file = 0; file < fileCount; file++) {
      const path = `file-${file}.ts`;
      guard.open(path);
      nodeStart = raw.nodes.length;
      relStart = raw.relationships.length;
      for (let member = 0; member < 8; member++) {
        const node = memberNode(path, member);
        raw.nodes.push(node);
        if (member % 2 === 0)
          raw.relationships.push(memberEdge('DEFINES', `File:${path}`, node.id));
        raw.relationships.push(memberEdge('HAS_METHOD', `Class:${path}:Missing`, node.id));
        raw.relationships.push(memberEdge('HAS_PROPERTY', `Class:${path}:Missing`, node.id));
      }
    }
    guard.settle();
    // Bound work by current-file input, including duplicate and already-defined members.
    expect(nodeReads).toBeGreaterThan(0);
    expect(nodeReads).toBeLessThanOrEqual(fileCount * 8);
    expect(relReads).toBeGreaterThan(0);
    expect(relReads).toBeLessThanOrEqual(fileCount * 20 * 3);
    expect(relWrites).toBeLessThanOrEqual(fileCount * 20);
    expect(raw.relationships).toHaveLength(1 + fileCount * 8);
    expect(raw.relationships[0]).toBe(prefixEdge);
    expect(raw.relationships.every((rel) => rel.type === 'DEFINES')).toBe(true);
    expect(new Set(raw.relationships.map((rel) => rel.targetId)).size).toBe(
      raw.relationships.length,
    );
  });
});
