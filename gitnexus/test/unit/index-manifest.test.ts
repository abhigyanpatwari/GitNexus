import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createIndexManifest } from '../../src/core/incremental/index-manifest.js';
import { createTempDir } from '../helpers/test-db.js';

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex');

describe('index manifest incremental helpers', () => {
  it('records hashes, emitted ownership, and file dependencies', async () => {
    const tmp = await createTempDir('gitnexus-index-manifest-');
    try {
      await fs.mkdir(path.join(tmp.dbPath, 'src'), { recursive: true });
      await fs.writeFile(path.join(tmp.dbPath, 'src', 'a.ts'), 'import { b } from "./b";\n');
      await fs.writeFile(path.join(tmp.dbPath, 'src', 'b.ts'), 'export const b = 1;\n');

      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'File:src/a.ts',
        label: 'File',
        properties: { name: 'a.ts', filePath: 'src/a.ts' },
      });
      graph.addNode({
        id: 'File:src/b.ts',
        label: 'File',
        properties: { name: 'b.ts', filePath: 'src/b.ts' },
      });
      graph.addNode({
        id: 'Function:src/a.ts:run',
        label: 'Function',
        properties: { name: 'run', filePath: 'src/a.ts', startLine: 1, endLine: 1 },
      });
      graph.addRelationship({
        id: 'IMPORTS:src/a.ts->src/b.ts',
        sourceId: 'File:src/a.ts',
        targetId: 'File:src/b.ts',
        type: 'IMPORTS',
        confidence: 1,
        reason: 'test',
      });

      const manifest = await createIndexManifest(
        tmp.dbPath,
        [
          { path: 'src/a.ts', size: 24, mtimeMs: 1000.9 },
          { path: 'src/b.ts', size: 20, mtimeMs: 2000.1 },
        ],
        graph,
        {
          generatedAt: '2026-04-30T12:00:00.000Z',
          parseDiagnostics: { 'src/a.ts': ['ok'] },
        },
      );

      expect(manifest.version).toBe(1);
      expect(manifest.generatedAt).toBe('2026-04-30T12:00:00.000Z');
      expect(manifest.summary).toEqual({ fileCount: 2, nodeCount: 3, edgeCount: 1 });
      expect(manifest.files['src/a.ts']).toMatchObject({
        size: 24,
        mtimeMs: 1000,
        hash: sha256('import { b } from "./b";\n'),
        emittedNodes: ['File:src/a.ts', 'Function:src/a.ts:run'],
        emittedEdges: ['IMPORTS:src/a.ts->src/b.ts'],
        parseDiagnostics: ['ok'],
        dependencies: ['src/b.ts'],
        dependants: [],
      });
      expect(manifest.files['src/b.ts']).toMatchObject({
        hash: sha256('export const b = 1;\n'),
        dependencies: [],
        dependants: ['src/a.ts'],
      });
    } finally {
      await tmp.cleanup();
    }
  });
});
