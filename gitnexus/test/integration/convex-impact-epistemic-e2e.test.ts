import fs from 'fs';
import path from 'path';
import { beforeAll, expect, it, vi } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  loadParseCache,
  PARSE_CACHE_VERSION,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../src/storage/parsedfile-store.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, saveMeta } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

let repoDir = '';
let warmReplayUsedWorkers = true;
const replayProperties = new Map<string, unknown>();
let bareHandlerFunctionId = '';

withTestLbugDB(
  'convex-impact-epistemic-e2e',
  (handle) => {
    let backend: LocalBackend;

    beforeAll(() => {
      backend = (handle as typeof handle & { _backend: LocalBackend })._backend;
    });

    it('persists import-proven endpoint metadata through a warm parse cache', () => {
      expect(warmReplayUsedWorkers).toBe(false);
      expect(replayProperties).toEqual(
        new Map([
          ['aliasedWrite', 'mutation'],
          ['generatedAction', 'internalAction'],
          ['javascriptQuery', 'query'],
          ['bareHandler', 'query'],
          ['publicQuery', 'query'],
        ]),
      );
    });

    it.each([
      ['publicQuery', 'endpoints.ts', 'query'],
      ['aliasedWrite', 'endpoints.ts', 'mutation'],
      ['generatedAction', 'endpoints.ts', 'internalAction'],
      ['javascriptQuery', 'endpoints.js', 'query'],
    ])(
      'marks real indexed Convex endpoint %s as lower-bound',
      async (target, filePath, factory) => {
        const result = await backend.callTool('impact', {
          target,
          file_path: filePath,
          direction: 'upstream',
        });

        expect(result.epistemic).toBe('lower-bound');
        expect(result.boundaries.join(' ')).toContain(`Convex ${factory}`);
        expect(result.causes.dispatchBoundary).toBe(0);
      },
    );

    it('marks a bare Function handler as lower-bound', async () => {
      expect(bareHandlerFunctionId).not.toBe('');
      const result = await backend.callTool('impact', {
        target_uid: bareHandlerFunctionId,
        direction: 'upstream',
      });

      expect(result.epistemic).toBe('lower-bound');
      expect(result.boundaries.join(' ')).toContain('Convex query');
      expect(result.causes.dispatchBoundary).toBe(0);
    });

    it.each([
      ['unrelatedQuery', 'endpoints.ts'],
      ['localQuery', 'local.ts'],
    ])('keeps non-Convex same-shape control %s exact', async (target, filePath) => {
      const result = await backend.callTool('impact', {
        target,
        file_path: filePath,
        direction: 'upstream',
      });

      expect(result.epistemic).toBe('exact');
      expect(result.boundaries).toBeUndefined();
    });

    it('does not apply the inbound Convex boundary to downstream impact', async () => {
      const result = await backend.callTool('impact', {
        target: 'publicQuery',
        file_path: 'endpoints.ts',
        direction: 'downstream',
      });

      expect(result.epistemic).toBe('exact');
      expect(result.boundaries).toBeUndefined();
    });

    it('carries the Convex boundary through context()', async () => {
      const result = await backend.callTool('context', {
        name: 'publicQuery',
        file_path: 'endpoints.ts',
      });

      expect(result.status).toBe('found');
      expect(result.epistemic).toBe('lower-bound');
      expect(result.boundaries.join(' ')).toContain('Convex query');
    });

    it('keeps a non-Convex same-shape context exact', async () => {
      const result = await backend.callTool('context', {
        name: 'localQuery',
        file_path: 'local.ts',
      });

      expect(result.status).toBe('found');
      expect(result.epistemic).toBe('exact');
      expect(result.boundaries).toBeUndefined();
    });
  },
  {
    beforeFTS: async (dbPath) => {
      const storageDir = path.dirname(dbPath);
      repoDir = path.join(storageDir, 'repo');
      const cacheDir = path.join(storageDir, 'parse-cache');
      fs.mkdirSync(repoDir, { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, 'endpoints.ts'),
        `import { queryGeneric as query, mutationGeneric as write } from 'convex/server';
import { query as generatedQuery, internalAction as internalRun } from './_generated/server';
import { query as dbQuery } from './database';

export const publicQuery = // legal line-comment trivia
  query({ handler: async () => null });
export const aliasedWrite = write({ handler: async () => null });
export const generatedAction = internalRun({ handler: async () => null });
export const bareHandler = generatedQuery(async () => null);
export const unrelatedQuery = dbQuery({ handler: async () => null });
`,
      );
      fs.writeFileSync(
        path.join(repoDir, 'local.ts'),
        `function query(config: unknown) { return config; }
export const localQuery = query({ handler: async () => null });
`,
      );
      fs.writeFileSync(
        path.join(repoDir, 'endpoints.js'),
        `import { query } from './_generated/server.js';
export const javascriptQuery = query({ handler: async () => null });
`,
      );

      const cold: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: cacheDir,
        onDiskKeys: new Set(),
      };
      await runPipelineFromRepo(repoDir, () => {}, { parseCache: cold, workerPoolSize: 1 });
      pruneCache(cold, cold.usedKeys);
      const savedKeys = await saveParseCache(cacheDir, cold);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(cacheDir),
        PARSE_CACHE_VERSION,
        new Set(savedKeys),
      );

      const warm = await loadParseCache(cacheDir);
      const replay = await runPipelineFromRepo(repoDir, () => {}, {
        parseCache: warm ?? undefined,
        workerPoolSize: 1,
      });
      warmReplayUsedWorkers = replay.usedWorkerPool;
      replay.graph.forEachNode((node) => {
        if (node.properties.convexEndpointFactory !== undefined) {
          replayProperties.set(node.properties.name, node.properties.convexEndpointFactory);
          if (node.label === 'Function' && node.properties.name === 'bareHandler') {
            bareHandlerFunctionId = node.id;
          }
        }
      });

      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.loadGraphToLbug(replay.graph, repoDir, storageDir);
      await saveMeta(storageDir, { scopeExtractionReceipt: 1 } as any);
    },
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'convex-e2e',
          path: repoDir,
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'convex-e2e',
          stats: { files: 3, nodes: 6, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as typeof handle & { _backend?: LocalBackend })._backend = backend;
    },
    timeout: 180_000,
  },
);
