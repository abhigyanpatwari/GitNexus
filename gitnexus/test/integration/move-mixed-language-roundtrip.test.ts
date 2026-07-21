import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { buildTestGraph } from '../helpers/test-graph.js';

withTestLbugDB(
  'move-mixed-language-roundtrip',
  () => {
    describe('mixed-language persistence', () => {
      it('stores Move facts and safe defaults for non-Move rows in shared tables', async () => {
        const { executeQuery } = await import('../../src/core/lbug/lbug-adapter.js');

        const functions = (await executeQuery(
          'MATCH (f:Function) RETURN f.id AS id, f.language AS language, ' +
            'f.qualifiedName AS qualifiedName, f.isEntry AS isEntry ORDER BY f.id',
        )) as Array<Record<string, unknown>>;
        expect(functions).toEqual([
          {
            id: 'Function:move',
            language: 'move',
            qualifiedName: '0x1::coin::mint',
            isEntry: true,
          },
          {
            id: 'Function:typescript',
            language: 'typescript',
            qualifiedName: null,
            isEntry: false,
          },
        ]);

        const structs = (await executeQuery(
          'MATCH (s:`Struct`) RETURN s.id AS id, s.language AS language, ' +
            's.qualifiedName AS qualifiedName, s.isResource AS isResource ORDER BY s.id',
        )) as Array<Record<string, unknown>>;
        expect(structs).toEqual([
          {
            id: 'Struct:move',
            language: 'move',
            qualifiedName: '0x1::coin::CoinStore',
            isResource: true,
          },
          {
            id: 'Struct:rust',
            language: 'rust',
            qualifiedName: null,
            isResource: false,
          },
        ]);
      });
    });
  },
  {
    beforeFTS: async (dbPath) => {
      const repoPath = path.join(path.dirname(dbPath), 'repo');
      const storagePath = path.join(path.dirname(dbPath), 'storage');
      await fs.mkdir(repoPath, { recursive: true });

      const graph = buildTestGraph([
        {
          id: 'Function:move',
          label: 'Function',
          name: 'mint',
          filePath: 'sources/coin.move',
          startLine: 1,
          endLine: 4,
          isExported: true,
          extra: {
            language: 'move',
            qualifiedName: '0x1::coin::mint',
            moduleQualifiedName: '0x1::coin',
            isEntry: true,
          },
        },
        {
          id: 'Function:typescript',
          label: 'Function',
          name: 'mint',
          filePath: 'src/coin.ts',
          startLine: 1,
          endLine: 2,
          isExported: true,
          extra: { language: 'typescript' },
        },
        {
          id: 'Struct:move',
          label: 'Struct',
          name: 'CoinStore',
          filePath: 'sources/coin.move',
          startLine: 6,
          endLine: 10,
          extra: {
            language: 'move',
            qualifiedName: '0x1::coin::CoinStore',
            moduleQualifiedName: '0x1::coin',
            isResource: true,
          },
        },
        {
          id: 'Struct:rust',
          label: 'Struct',
          name: 'CoinStore',
          filePath: 'src/coin.rs',
          startLine: 1,
          endLine: 3,
          extra: { language: 'rust' },
        },
      ]);

      const { loadGraphToLbug } = await import('../../src/core/lbug/lbug-adapter.js');
      await loadGraphToLbug(graph, repoPath, storagePath);
    },
  },
);
