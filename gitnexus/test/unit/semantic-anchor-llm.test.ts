import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { applySemanticAnchors } from '../../src/core/ingestion/semantic-anchor.js';
import { applyLLMSemanticAnchors } from '../../src/core/ingestion/semantic-anchor-llm.js';
import { createTempDir } from '../helpers/test-db.js';

const makeGraph = () => {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'Function:src/auth.ts:checkPermissions',
    label: 'Function',
    properties: {
      name: 'checkPermissions',
      filePath: 'src/auth.ts',
      startLine: 1,
      endLine: 5,
      content: 'export function checkPermissions(user) { return user.roles.includes("admin"); }',
    },
  });
  graph.addNode({
    id: 'Function:src/auth.ts:loadUser',
    label: 'Function',
    properties: {
      name: 'loadUser',
      filePath: 'src/auth.ts',
      startLine: 7,
      endLine: 10,
      content: 'export function loadUser(id) { return users.get(id); }',
    },
  });
  graph.addRelationship({
    id: 'call:checkPermissions->loadUser',
    sourceId: 'Function:src/auth.ts:checkPermissions',
    targetId: 'Function:src/auth.ts:loadUser',
    type: 'CALLS',
    confidence: 1,
    reason: 'test',
  });
  applySemanticAnchors(graph, '2026-04-30T12:00:00.000Z');
  return graph;
};

describe('LLM semantic anchor enrichment', () => {
  it('enriches heuristic anchors and writes a content-hash cache', async () => {
    const tmp = await createTempDir('gitnexus-llm-anchors-');
    try {
      const graph = makeGraph();
      const callLLM = vi.fn().mockResolvedValue(
        JSON.stringify({
          summary: 'Checks whether a user has permission for protected behavior.',
          purpose: 'Inspect this before changing authorization rules.',
          tags: ['auth', 'permissions', 'risk-check'],
        }),
      );

      const result = await applyLLMSemanticAnchors(graph, {
        cachePath: path.join(tmp.dbPath, 'semantic-anchor-cache.json'),
        model: 'test-model',
        maxNodes: 1,
        generatedAt: '2026-04-30T13:00:00.000Z',
        callLLM,
      });

      const node = graph.getNode('Function:src/auth.ts:checkPermissions');
      expect(result).toMatchObject({
        enrichedNodes: 1,
        cachedNodes: 0,
        failedNodes: 0,
        skippedNodes: 1,
      });
      expect(callLLM).toHaveBeenCalledTimes(1);
      expect(node?.properties.summary).toBe(
        'Checks whether a user has permission for protected behavior.',
      );
      expect(node?.properties.purpose).toBe('Inspect this before changing authorization rules.');
      expect(node?.properties.tags).toEqual(
        expect.arrayContaining(['auth', 'function', 'permissions', 'risk-check']),
      );
      expect(node?.properties.anchorModel).toBe('llm:test-model');
      expect(node?.properties.anchorVersion).toBe(2);

      const cache = JSON.parse(
        await fs.readFile(path.join(tmp.dbPath, 'semantic-anchor-cache.json'), 'utf-8'),
      );
      expect(Object.keys(cache.entries)).toHaveLength(1);
      expect(cache.entries['Function:src/auth.ts:checkPermissions'].contentHash).toMatch(
        /^[0-9a-f]{64}$/,
      );
    } finally {
      await tmp.cleanup();
    }
  });

  it('reuses cached anchors when the content hash and model match', async () => {
    const tmp = await createTempDir('gitnexus-llm-anchor-cache-');
    try {
      const cachePath = path.join(tmp.dbPath, 'semantic-anchor-cache.json');
      const firstGraph = makeGraph();
      const callLLM = vi.fn().mockResolvedValue(
        JSON.stringify({
          summary: 'Checks authorization.',
          purpose: 'Inspect before permission changes.',
          tags: ['auth'],
        }),
      );

      await applyLLMSemanticAnchors(firstGraph, {
        cachePath,
        model: 'test-model',
        maxNodes: 1,
        callLLM,
      });

      const secondGraph = makeGraph();
      const cachedOnly = vi.fn().mockRejectedValue(new Error('should not call LLM'));
      const result = await applyLLMSemanticAnchors(secondGraph, {
        cachePath,
        model: 'test-model',
        maxNodes: 1,
        callLLM: cachedOnly,
      });

      expect(result.enrichedNodes).toBe(0);
      expect(result.cachedNodes).toBe(1);
      expect(cachedOnly).not.toHaveBeenCalled();
      expect(secondGraph.getNode('Function:src/auth.ts:checkPermissions')?.properties.summary).toBe(
        'Checks authorization.',
      );
    } finally {
      await tmp.cleanup();
    }
  });
});
