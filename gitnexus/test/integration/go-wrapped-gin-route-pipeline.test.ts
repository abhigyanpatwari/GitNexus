/**
 * Routes registered on a wrapper package's engine alias (`*core.Engine`, where
 * the dependency declares `type Engine = gin.Engine`) with handlers wrapped by
 * an application adapter (`common.Wrapper(api.CreateJob)`).
 *
 * Neither fact is provable from the repository: the dependency's source is not
 * vendored, and a call in the handler slot may be middleware. Both are user
 * configuration (`goRouterAliases`, `goHandlerWrappers`), applied on the main
 * thread — so the same parse output yields no routes without it.
 *
 * Fixture: `test/fixtures/go-wrapped-gin-route-app/`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';
import { loadParseCache, saveParseCache } from '../../src/storage/parse-cache.js';
import { runtimeParseIdentity } from '../helpers/runtime-parse-identity.js';
import {
  clearParsedFileStore,
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../src/storage/parsedfile-store.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'go-wrapped-gin-route-app');

const routeView = (result: PipelineResult): string[] => {
  const out: string[] = [];
  result.graph.forEachNode((node) => {
    if (node.label !== 'Route') return;
    const handler = result.graph.getNode(String(node.properties.handlerSymbolId));
    out.push(
      `${String(node.properties.method)} ${String(node.properties.name)} -> ${String(
        handler?.properties.name,
      )}`,
    );
  });
  return out.sort();
};

describe('wrapper-package gin route ingestion', () => {
  let configured: PipelineResult;
  let unconfigured: PipelineResult;

  beforeAll(async () => {
    [configured, unconfigured] = await Promise.all([
      runPipelineFromRepo(FIXTURE, () => {}, {
        routeHookConfig: {
          routeFrameworkAliases: [
            { importPath: 'example.com/infra/pkg', type: 'Engine', framework: 'gin' },
          ],
          routeHandlerWrappers: ['common.Wrapper', 'common.WrapperWithSuccessCode'],
        },
      }),
      runPipelineFromRepo(FIXTURE, () => {}, {}),
    ]);
  }, 300_000);

  it('emits prefixed routes and resolves wrapped handlers when configured', () => {
    expect(routeView(configured)).toEqual([
      'GET /console/v1/jobs/status -> JobStatus',
      'GET /console/v1/jobs/userinfo -> UserInfo',
      'POST /console/v1/jobs/create -> CreateJob',
    ]);
  });

  it('draws HANDLES_ROUTE from the wrapped method with gin provenance', () => {
    let edge: { handler: unknown; reason: unknown } | undefined;
    configured.graph.forEachRelationship((rel) => {
      if (rel.type === 'HANDLES_ROUTE' && rel.targetId === 'Route:POST /console/v1/jobs/create') {
        edge = {
          handler: configured.graph.getNode(rel.sourceId)?.properties.name,
          reason: rel.reason,
        };
      }
    });
    expect(edge).toEqual({ handler: 'CreateJob', reason: 'gin-route' });
  });

  it('emits no route without the alias configuration', () => {
    expect(routeView(unconfigured)).toEqual([]);
  });

  it('preserves the configured route winner when a direct route declares the same URL', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'go-route-collision-'));
    try {
      await fs.writeFile(path.join(repo, 'go.mod'), 'module example.com/collision\n\ngo 1.22\n');
      await fs.writeFile(
        path.join(repo, 'routes.go'),
        `package routes
import "github.com/gin-gonic/gin"
import core "example.com/infra/pkg"
func Direct(c *gin.Context) {}
func Aliased(c *gin.Context) {}
func R(r *gin.Engine, s *core.Engine) {
  r.GET("/same", Direct)
  s.GET("/same", Aliased)
}`,
      );
      const result = await runPipelineFromRepo(repo, () => {}, {
        routeHookConfig: {
          routeFrameworkAliases: [
            { importPath: 'example.com/infra/pkg', type: 'Engine', framework: 'gin' },
          ],
        },
      });
      expect(routeView(result)).toEqual(['GET /same -> Aliased']);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  }, 300_000);

  it('applies alias and wrapper changes to persisted worker facts without reparsing', async () => {
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'go-route-facts-cache-'));
    try {
      const identity = await runtimeParseIdentity();
      const cache = await loadParseCache(storage, identity, storage);
      const cold = await runPipelineFromRepo(FIXTURE, () => {}, {
        parseCache: cache,
        workerPoolSize: 1,
      });
      expect(routeView(cold)).toEqual([]);
      expect(cold.reparsedFileCount).toBeGreaterThan(0);
      const keys = await saveParseCache(storage, cache);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storage),
        identity.base,
        new Set(keys),
      );
      await clearParsedFileStore(storage);

      const aliases = [{ importPath: 'example.com/infra/pkg', type: 'Engine', framework: 'gin' }];
      const replay = async (wrappers: string[], includeAlias = true) => {
        const result = await runPipelineFromRepo(FIXTURE, () => {}, {
          parseCache: await loadParseCache(storage, identity, storage),
          workerPoolSize: 1,
          routeHookConfig: {
            routeFrameworkAliases: includeAlias ? aliases : [],
            routeHandlerWrappers: wrappers,
          },
        });
        expect(result.reparsedFileCount).toBe(0);
        expect(result.parseCacheHitFileCount).toBe(cold.reparsedFileCount);
        expect(result.scopeExtractionFailures).toEqual([]);
        return routeView(result);
      };
      expect(await replay(['common.Wrapper', 'common.WrapperWithSuccessCode'])).toEqual(
        routeView(configured),
      );
      expect(await replay([])).toEqual([
        'GET /console/v1/jobs/status -> undefined',
        'GET /console/v1/jobs/userinfo -> UserInfo',
        'POST /console/v1/jobs/create -> undefined',
      ]);
      expect(await replay([], false)).toEqual([]);
    } finally {
      await fs.rm(storage, { recursive: true, force: true });
    }
  }, 300_000);
});
