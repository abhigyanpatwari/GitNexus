/**
 * Warm parse-cache guard for the decorator-route handler edge (#2865).
 *
 * `handlerName` is minted in the parse WORKER and travels inside
 * `ParseWorkerResult.decoratorRoutes`, which the parse cache persists verbatim.
 * A warm all-hit run replays that payload instead of re-parsing, so the field
 * has to survive the save/load round-trip on its own: if it did not,
 * `resolveRouteHandlerSymbols` would resolve no handler, the Route node would
 * lose `handlerSymbolId`, and the definition-level HANDLES_ROUTE edge would
 * vanish on every incremental analyze while every cold-run test stayed green.
 *
 * That is the half `SCHEMA_BUMP` cannot cover — the bump (88 -> 90) only
 * rejects caches written before the feature existed; this pins that caches
 * written *after* it still carry the field.
 *
 * Fixture: `test/fixtures/fastapi-composed-app/` (Python decorator routes whose
 * handlers are ordinary same-file definitions).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'fastapi-composed-app');

/** Every HANDLES_ROUTE edge, projected as `<source label>:<source name> -> <url>`. */
const handlerEdges = (pipeline: PipelineResult): string[] => {
  const out: string[] = [];
  pipeline.graph.forEachRelationship((rel) => {
    if (rel.type !== 'HANDLES_ROUTE') return;
    const source = pipeline.graph.getNode(rel.sourceId);
    const target = pipeline.graph.getNode(rel.targetId);
    if (source === undefined || target === undefined) return;
    out.push(
      `${source.label}:${String(source.properties.name)} -> ${String(target.properties.name)}`,
    );
  });
  return out.sort();
};

/** Route url → `handlerSymbolId`, for the routes that resolved a handler. */
const handlerSymbols = (pipeline: PipelineResult): Map<string, string> => {
  const out = new Map<string, string>();
  pipeline.graph.forEachNode((node) => {
    if (node.label !== 'Route') return;
    const handlerSymbolId = node.properties.handlerSymbolId;
    if (typeof handlerSymbolId === 'string' && handlerSymbolId.length > 0) {
      out.set(String(node.properties.name), handlerSymbolId);
    }
  });
  return out;
};

describe('decorator-route handler edge — warm parse cache (#2865 SCHEMA_BUMP)', () => {
  it('replays handlerName from a serialized cache so the definition-level edge survives', async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-decorator-handler-warm-'));
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

      // The decorated handler resolves to its own definition, not just its file.
      const coldSymbols = handlerSymbols(coldResult);
      expect(coldSymbols.get('/api/v1/widgets/get')).toMatch(/create_widget/);
      expect(handlerEdges(coldResult)).toContain('Function:create_widget -> /api/v1/widgets/get');

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
      // No worker ran: every decorator route below came out of the cache.
      expect(replay.usedWorkerPool).toBe(false);

      expect(handlerSymbols(replay)).toEqual(coldSymbols);
      expect(handlerEdges(replay)).toEqual(handlerEdges(coldResult));
    } finally {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  }, 120_000);
});
