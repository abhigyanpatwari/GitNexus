import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../types/pipeline.js';
import { DATA_ROUTE_TABLE_SOURCE } from '../../src/core/ingestion/route-extractors/data-route-table.js';
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

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'data-route-table-app');

describe('data-driven route table ingestion', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
  }, 60_000);

  const routes = (pipeline: PipelineResult = result) => {
    const found: Array<{
      path: string;
      method?: string;
      handler?: string;
      filePath: string;
      responseKeys?: string[];
    }> = [];
    pipeline.graph.forEachNode((node) => {
      if (node.label !== 'Route') return;
      found.push({
        path: String(node.properties.name),
        method: node.properties.method as string | undefined,
        handler: node.properties.handlerSymbolId as string | undefined,
        filePath: String(node.properties.filePath),
        responseKeys: node.properties.responseKeys as string[] | undefined,
      });
    });
    return found;
  };

  it('emits distinct GET and POST Route nodes for the same URL', () => {
    expect(
      routes()
        .map((route) => `${route.method} ${route.path}`)
        .sort(),
    ).toEqual(['GET /auth/me', 'GET /users', 'POST /users']);
  });

  it('resolves free and member handlers across files', () => {
    expect(
      routes().find((route) => route.path === '/users' && route.method === 'GET')?.handler,
    ).toMatch(/listUsers/);
    expect(
      routes().find((route) => route.path === '/users' && route.method === 'GET')?.handler,
    ).not.toMatch(/handleUsers/);
    expect(
      routes().find((route) => route.path === '/users' && route.method === 'POST')?.handler,
    ).toMatch(/createUser/);
    expect(routes().find((route) => route.path === '/auth/me')?.handler).toMatch(/getCurrentUser/);
  });

  it('links every resolved route from the real cross-file handler file', () => {
    const handled: Array<{ filePath: string; method?: string; path: string; reason: string }> = [];
    result.graph.forEachRelationship((rel) => {
      if (rel.type !== 'HANDLES_ROUTE' || rel.reason !== DATA_ROUTE_TABLE_SOURCE) return;
      const source = result.graph.getNode(rel.sourceId);
      const target = result.graph.getNode(rel.targetId);
      if (source === undefined || target === undefined) return;
      // A resolved route also carries a definition-level edge from the handler
      // symbol itself; this assertion is about the file-level edge, which is the
      // one `http-route-extractor.ts` queries. The definition edges are pinned
      // by the next test.
      if (source.label !== 'File') return;
      handled.push({
        filePath: String(source.properties.filePath),
        method: target.properties.method as string | undefined,
        path: String(target.properties.name),
        reason: String(rel.reason),
      });
    });
    expect(
      handled.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`)),
    ).toEqual([
      {
        filePath: 'handlers.js',
        method: 'GET',
        path: '/auth/me',
        reason: DATA_ROUTE_TABLE_SOURCE,
      },
      {
        filePath: 'handlers.js',
        method: 'GET',
        path: '/users',
        reason: DATA_ROUTE_TABLE_SOURCE,
      },
      {
        filePath: 'handlers.js',
        method: 'POST',
        path: '/users',
        reason: DATA_ROUTE_TABLE_SOURCE,
      },
    ]);
  });

  it('also links every resolved route from the handler definition it stamped', () => {
    // The definition-level edge must agree with `Route.handlerSymbolId` — both
    // come from the same graph-resolved symbol — and its source must be a real
    // definition node, not a File.
    const definitionEdges = new Map<string, string>();
    result.graph.forEachRelationship((rel) => {
      if (rel.type !== 'HANDLES_ROUTE' || rel.reason !== DATA_ROUTE_TABLE_SOURCE) return;
      const source = result.graph.getNode(rel.sourceId);
      if (source === undefined || source.label === 'File') return;
      definitionEdges.set(rel.targetId, rel.sourceId);
    });

    const resolved = routes().filter((route) => route.handler !== undefined);
    expect(resolved).toHaveLength(3);
    result.graph.forEachNode((node) => {
      if (node.label !== 'Route') return;
      const handlerSymbolId = node.properties.handlerSymbolId as string | undefined;
      if (handlerSymbolId === undefined) return;
      expect(definitionEdges.get(node.id), String(node.properties.name)).toBe(handlerSymbolId);
      expect(result.graph.getNode(handlerSymbolId)?.label).toMatch(/^(Function|Method)$/);
    });
  });

  it('extracts response shapes from each resolved handler only', () => {
    const getUsers = routes().find((route) => route.path === '/users' && route.method === 'GET');
    const postUsers = routes().find((route) => route.path === '/users' && route.method === 'POST');
    const currentUser = routes().find((route) => route.path === '/auth/me');

    expect(getUsers).toMatchObject({ filePath: 'handlers.js', responseKeys: ['users'] });
    expect(postUsers).toMatchObject({ filePath: 'handlers.js', responseKeys: ['createdId'] });
    expect(currentUser).toMatchObject({ filePath: 'handlers.js', responseKeys: ['accountId'] });
  });

  it('does not emit dynamic, spread, computed, or inline-handler entries', () => {
    const paths = routes().map((route) => route.path);
    expect(paths).not.toContain('/dynamic');
    expect(paths).not.toContain('/spread');
    expect(paths).not.toContain('/computed');
    expect(paths).not.toContain('/inline');
    expect(paths).not.toContain('/unresolved');
  });

  it('resolves declared jsconfig path aliases for handlers', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-route-table-alias-'));
    try {
      fs.mkdirSync(path.join(repoDir, 'src', 'handlers'), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, 'jsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: { '@handler': ['src/handlers/user'] },
          },
        }),
      );
      fs.writeFileSync(
        path.join(repoDir, 'src', 'routes.js'),
        `import { aliasHandler } from '@handler';
const routes = [{ path: '/alias', method: 'GET', handler: aliasHandler }];
for (const route of routes) {
  if (route.path === request.path && route.method === request.method) route.handler();
}`,
      );
      fs.writeFileSync(
        path.join(repoDir, 'src', 'handlers', 'user.js'),
        `export function aliasHandler(_req, res) { return res.json({ id: 'alias' }); }`,
      );
      const aliasResult = await runPipelineFromRepo(repoDir, () => {}, {});
      expect(routes(aliasResult)).toContainEqual(
        expect.objectContaining({
          path: '/alias',
          method: 'GET',
          filePath: 'src/handlers/user.js',
          responseKeys: ['id'],
        }),
      );
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not infer a default-export handler without explicit provenance', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-route-table-default-'));
    try {
      fs.writeFileSync(
        path.join(repoDir, 'routes.js'),
        `import handleDefault from './handler.js';
const routes = [{ path: '/default', method: 'GET', handler: handleDefault }];
for (const route of routes) {
  if (route.path === request.path && route.method === request.method) route.handler();
}`,
      );
      fs.writeFileSync(
        path.join(repoDir, 'handler.js'),
        `export default function defaultHandler(_req, res) {
  return res.json({ source: 'default' });
}`,
      );

      const defaultResult = await runPipelineFromRepo(repoDir, () => {}, {});
      expect(routes(defaultResult)).toEqual([]);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('replays data-table routes from a serialized warm parse cache', async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-route-table-warm-'));
    try {
      const cold: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set<string>(),
        storagePath: storageDir,
        onDiskKeys: new Set<string>(),
      };
      const coldResult = await runPipelineFromRepo(FIXTURE, () => {}, {
        parseCache: cold,
        workerPoolSize: 1,
      });
      expect(coldResult.usedWorkerPool).toBe(true);

      pruneCache(cold, cold.usedKeys);
      const savedKeys = await saveParseCache(storageDir, cold);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storageDir),
        PARSE_CACHE_VERSION,
        new Set(savedKeys),
      );
      const warm = await loadParseCache(storageDir);
      expect(warm).not.toBeNull();

      const replay = await runPipelineFromRepo(FIXTURE, () => {}, {
        parseCache: warm ?? undefined,
        workerPoolSize: 1,
      });
      expect(replay.usedWorkerPool).toBe(false);

      const project = (pipeline: PipelineResult) =>
        routes(pipeline)
          .map((route) => ({
            method: route.method,
            path: route.path,
            handler: route.handler,
            filePath: route.filePath,
            responseKeys: route.responseKeys,
          }))
          .sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
      const coldProjection = project(coldResult);
      expect(coldProjection).toEqual([
        {
          method: 'GET',
          path: '/auth/me',
          handler: expect.stringMatching(/getCurrentUser/),
          filePath: 'handlers.js',
          responseKeys: ['accountId'],
        },
        {
          method: 'GET',
          path: '/users',
          handler: expect.stringMatching(/listUsers/),
          filePath: 'handlers.js',
          responseKeys: ['users'],
        },
        {
          method: 'POST',
          path: '/users',
          handler: expect.stringMatching(/createUser/),
          filePath: 'handlers.js',
          responseKeys: ['createdId'],
        },
      ]);
      expect(project(replay)).toEqual(coldProjection);
    } finally {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  }, 120_000);
});
