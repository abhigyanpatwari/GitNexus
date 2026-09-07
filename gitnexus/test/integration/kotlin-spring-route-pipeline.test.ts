/**
 * End-to-end Kotlin Spring decorator route ingestion (#3130).
 *
 * Covers literal and composed identities, handler attribution, fail-closed
 * constants/shadows, ambiguous same-file names, and serialized warm-cache replay.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireVendoredGrammar } from '../../src/core/tree-sitter/vendored-grammars.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../types/pipeline.js';
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

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'kotlin-spring-route-app');

let Kotlin: unknown;
try {
  Kotlin = requireVendoredGrammar('tree-sitter-kotlin');
} catch {
  // Optional grammar: platforms without it skip this Kotlin-positive suite.
}

const describeKotlin = Kotlin ? describe : describe.skip;

interface RouteRecord {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly filePath: string;
  readonly handlerSymbolId?: string;
}

function routeRecords(result: PipelineResult): RouteRecord[] {
  return [...result.graph.iterNodes()]
    .filter((node) => node.label === 'Route')
    .map((node) => ({
      id: node.id,
      method: String(node.properties.method ?? '*'),
      path: String(node.properties.name),
      filePath: String(node.properties.filePath),
      ...(typeof node.properties.handlerSymbolId === 'string'
        ? { handlerSymbolId: node.properties.handlerSymbolId }
        : {}),
    }))
    .sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

function routeByIdentity(result: PipelineResult, method: string, routePath: string): RouteRecord {
  const route = routeRecords(result).find(
    (candidate) => candidate.method === method && candidate.path === routePath,
  );
  expect(route, `expected ${method} ${routePath}`).toBeDefined();
  if (!route) throw new Error(`expected ${method} ${routePath}`);
  return route;
}

function handlerName(result: PipelineResult, route: RouteRecord): string | undefined {
  if (!route.handlerSymbolId) return undefined;
  return String(result.graph.getNode(route.handlerSymbolId)?.properties.name);
}

function handlesRouteSources(result: PipelineResult, routeId: string): string[] {
  return [...result.graph.iterRelationshipsByType('HANDLES_ROUTE')]
    .filter((relationship) => relationship.targetId === routeId)
    .map((relationship) => relationship.sourceId)
    .sort();
}

function routeSnapshot(result: PipelineResult): {
  readonly routes: RouteRecord[];
  readonly handles: Array<readonly [string, readonly string[]]>;
} {
  const routes = routeRecords(result);
  return {
    routes,
    handles: routes.map((route) => [route.id, handlesRouteSources(result, route.id)] as const),
  };
}

describeKotlin('Kotlin Spring route ingestion pipeline', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, { workerPoolSize: 1 });
  }, 120_000);

  it('creates normalized literal, imported, wildcard, concatenated, companion, and root routes', () => {
    const expected = [
      ['GET', '/api/pets'],
      ['POST', '/api/api/items'],
      ['PUT', '/api/wild'],
      ['PATCH', '/api/own'],
      ['GET', '/api'],
    ] as const;

    for (const [method, routePath] of expected) {
      expect(routeByIdentity(result, method, routePath)).toBeDefined();
    }
  });

  it('stamps each unique handlerSymbolId and emits file plus definition HANDLES_ROUTE edges', () => {
    const expected = new Map([
      ['GET /api/pets', 'list'],
      ['POST /api/api/items', 'create'],
      ['PUT /api/wild', 'wildcard'],
      ['PATCH /api/own', 'own'],
      ['GET /api', 'root'],
    ]);

    for (const [identity, expectedHandler] of expected) {
      const split = identity.indexOf(' ');
      const route = routeByIdentity(result, identity.slice(0, split), identity.slice(split + 1));
      expect(route.handlerSymbolId, `${identity} handlerSymbolId`).toBeTruthy();
      const handlerSymbolId = route.handlerSymbolId;
      if (!handlerSymbolId) throw new Error(`expected ${identity} handlerSymbolId`);
      expect(handlerName(result, route)).toBe(expectedHandler);
      const handler = result.graph.getNode(handlerSymbolId);
      expect(handler?.label).toBe('Method');
      expect(String(handler?.properties.filePath)).toContain('PetsController.kt');

      const sources = handlesRouteSources(result, route.id);
      expect(sources).toContain(handlerSymbolId);
      expect(sources.some((sourceId) => result.graph.getNode(sourceId)?.label === 'File')).toBe(
        true,
      );
    }
  });

  it('omits missing constants, same-package shadows, ordinary classes, Feign consumers, and class-only mappings', () => {
    const routes = routeRecords(result);
    const identities = new Set(routes.map((route) => `${route.method} ${route.path}`));

    expect(identities).not.toContain('DELETE /api');
    expect(identities).not.toContain('GET /ordinary');
    expect(identities).not.toContain('GET /remote');
    expect(identities).not.toContain('GET /pets');
    expect(routes.some((route) => handlerName(result, route) === 'shadowed')).toBe(false);
    expect(routes.some((route) => handlerName(result, route) === 'EmptyController')).toBe(false);
  });

  it('keeps file-level attribution but omits handler ids for ambiguous same-file names', () => {
    for (const routePath of ['/duplicate/first', '/duplicate/second']) {
      const route = routeByIdentity(result, 'GET', routePath);
      expect(route.handlerSymbolId).toBeUndefined();
      const sources = handlesRouteSources(result, route.id);
      expect(sources).toHaveLength(1);
      const source = result.graph.getNode(sources[0]);
      expect(source?.label).toBe('File');
      expect(String(source?.properties.name)).toContain('DuplicateControllers.kt');
    }
  });

  it('replays identical routes, handler ids, and both edge levels from an all-hit warm cache', async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-kotlin-routes-warm-'));
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
      const replay = await runPipelineFromRepo(FIXTURE, () => {}, {
        parseCache: warm,
        workerPoolSize: 1,
      });
      expect(replay.usedWorkerPool).toBe(false);
      expect(routeSnapshot(replay)).toEqual(routeSnapshot(coldResult));

      const root = routeByIdentity(replay, 'GET', '/api');
      expect(handlerName(replay, root)).toBe('root');
      expect(root.handlerSymbolId).toBeTruthy();
      if (!root.handlerSymbolId) throw new Error('expected root handlerSymbolId');
      expect(handlesRouteSources(replay, root.id)).toContain(root.handlerSymbolId);
    } finally {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  }, 120_000);
});
