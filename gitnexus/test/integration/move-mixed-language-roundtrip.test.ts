import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NodeLabel } from '../../src/core/graph/types.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { buildTestGraph } from '../helpers/test-graph.js';

const sharedTables = [
  {
    table: 'Function',
    otherLanguage: 'typescript',
    detailProperty: 'isEntry',
    moveDetail: true,
  },
  { table: 'Struct', otherLanguage: 'rust', detailProperty: 'isResource', moveDetail: true },
  { table: 'Enum', otherLanguage: 'rust', detailProperty: 'isEvent', moveDetail: true },
  {
    table: 'Type',
    otherLanguage: 'typescript',
    detailProperty: 'locationFidelity',
    moveDetail: 'external',
  },
  {
    table: 'EnumVariant',
    otherLanguage: 'rust',
    detailProperty: 'parentEnum',
    moveDetail: '0x1::sample::Choice',
  },
  { table: 'Const', otherLanguage: 'typescript', detailProperty: 'isErrorCode', moveDetail: true },
  { table: 'Module', otherLanguage: 'python', detailProperty: 'moduleAddress', moveDetail: '0x1' },
] as const;

withTestLbugDB(
  'move-mixed-language-roundtrip',
  () => {
    describe('mixed-language persistence', () => {
      it('stores Move facts and safe defaults in every shared table', async () => {
        const { executeQuery } = await import('../../src/core/lbug/lbug-adapter.js');

        for (const testCase of sharedTables) {
          const rows = (await executeQuery(
            `MATCH (n:\`${testCase.table}\`) ` +
              `RETURN n.id AS id, n.language AS language, n.qualifiedName AS qualifiedName, ` +
              `n.${testCase.detailProperty} AS detail ORDER BY n.id`,
          )) as Array<Record<string, unknown>>;
          expect(rows).toEqual([
            {
              id: `${testCase.table}:move`,
              language: 'move',
              qualifiedName: `0x1::sample::${testCase.table}`,
              detail: testCase.moveDetail,
            },
            {
              id: `${testCase.table}:${testCase.otherLanguage}`,
              language: testCase.otherLanguage,
              qualifiedName: null,
              detail: typeof testCase.moveDetail === 'boolean' ? false : null,
            },
          ]);
        }
      });

      it('stores Move enum fields and local/external type-reference relationships', async () => {
        const { executeQuery } = await import('../../src/core/lbug/lbug-adapter.js');
        const rows = await executeQuery(
          "MATCH (a)-[r:CodeRelation]->(b) WHERE r.reason STARTS WITH 'move-roundtrip-' " +
            'RETURN a.id AS source, r.type AS type, b.id AS target ORDER BY r.reason',
        );

        expect(rows).toEqual([
          {
            source: 'EnumVariant:move',
            type: 'HAS_PROPERTY',
            target: 'Property:move-field',
          },
          { source: 'Function:move', type: 'USES_TYPE', target: 'Type:move' },
          { source: 'Module:move', type: 'DEFINES', target: 'Type:move' },
          { source: 'Property:move-field', type: 'USES_TYPE', target: 'Enum:move' },
          { source: 'Property:move-field', type: 'USES_TYPE', target: 'Struct:move' },
          { source: 'Property:move-field', type: 'USES_TYPE', target: 'Type:move' },
          { source: 'Struct:move', type: 'USES_TYPE', target: 'Type:move' },
        ]);
      });
    });
  },
  {
    beforeFTS: async (dbPath) => {
      const repoPath = path.join(path.dirname(dbPath), 'repo');
      const storagePath = path.join(path.dirname(dbPath), 'storage');
      await fs.mkdir(repoPath, { recursive: true });

      const graph = buildTestGraph(
        [
          ...sharedTables.flatMap((testCase) => [
            {
              id: `${testCase.table}:move`,
              label: testCase.table as NodeLabel,
              name: testCase.table,
              filePath: testCase.table === 'Type' ? '' : 'sources/sample.move',
              startLine: 1,
              endLine: 2,
              isExported: testCase.table === 'Function',
              extra: {
                language: 'move',
                qualifiedName: `0x1::sample::${testCase.table}`,
                moduleQualifiedName: '0x1::sample',
                [testCase.detailProperty]: testCase.moveDetail,
              },
            },
            {
              id: `${testCase.table}:${testCase.otherLanguage}`,
              label: testCase.table as NodeLabel,
              name: testCase.table,
              filePath: `src/sample.${testCase.otherLanguage}`,
              startLine: 1,
              endLine: 2,
              isExported: testCase.table === 'Function',
              extra: { language: testCase.otherLanguage },
            },
          ]),
          {
            id: 'Property:move-field',
            label: 'Property',
            name: 'field',
            filePath: 'sources/sample.move',
            startLine: 1,
            endLine: 2,
            extra: { declaredType: '0x1::sample::Type' },
          },
        ],
        [
          {
            sourceId: 'EnumVariant:move',
            targetId: 'Property:move-field',
            type: 'HAS_PROPERTY',
            reason: 'move-roundtrip-1',
          },
          {
            sourceId: 'Function:move',
            targetId: 'Type:move',
            type: 'USES_TYPE',
            reason: 'move-roundtrip-2',
          },
          {
            sourceId: 'Module:move',
            targetId: 'Type:move',
            type: 'DEFINES',
            reason: 'move-roundtrip-3',
          },
          {
            sourceId: 'Property:move-field',
            targetId: 'Enum:move',
            type: 'USES_TYPE',
            reason: 'move-roundtrip-4',
          },
          {
            sourceId: 'Property:move-field',
            targetId: 'Struct:move',
            type: 'USES_TYPE',
            reason: 'move-roundtrip-5',
          },
          {
            sourceId: 'Property:move-field',
            targetId: 'Type:move',
            type: 'USES_TYPE',
            reason: 'move-roundtrip-6',
          },
          {
            sourceId: 'Struct:move',
            targetId: 'Type:move',
            type: 'USES_TYPE',
            reason: 'move-roundtrip-7',
          },
        ],
      );

      const { loadGraphToLbug } = await import('../../src/core/lbug/lbug-adapter.js');
      await loadGraphToLbug(graph, repoPath, storagePath);
    },
  },
);
