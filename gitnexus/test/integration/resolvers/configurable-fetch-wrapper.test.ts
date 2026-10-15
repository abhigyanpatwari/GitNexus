/**
 * Integration test: configurable fetch wrappers (#1589/#1852 residual)
 *
 * The parse-phase auto-detector only flags functions that call the bare global
 * `fetch()`. A wrapper built on axios / a custom client — like `doRequest` in
 * this fixture — is invisible to it, so `route_map` silently reports
 * `consumers: []` (exactly the "named outside convention" hole #1858 calls out).
 *
 * Declaring the wrapper name in `.gitnexusrc` `fetchWrappers` (threaded here via
 * PipelineOptions) lets the routes-phase consumer scan trace it, producing the
 * FETCHES edge. The control run (no config) proves the gap; the configured run
 * proves the fix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  loadParseCache,
  saveParseCache,
  PARSE_CACHE_VERSION,
} from '../../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../src/storage/parsedfile-store.js';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

const FIXTURE = path.join(FIXTURES, 'configurable-fetch-wrapper');

describe('Configurable fetch wrapper consumer extraction', () => {
  let withConfig: PipelineResult;
  let withoutConfig: PipelineResult;
  let warmConfig: PipelineResult;
  let cacheDir: string;

  beforeAll(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'fetch-wrapper-cache-'));
    const parseCache = await loadParseCache(cacheDir);
    withoutConfig = await runPipelineFromRepo(FIXTURE, () => {}, { parseCache });
    await saveParseCache(cacheDir, parseCache);
    await pruneAndSaveDurableParsedFileStore(
      getDurableParsedFileDir(cacheDir),
      PARSE_CACHE_VERSION,
      parseCache.usedKeys,
    );
    warmConfig = await runPipelineFromRepo(FIXTURE, () => {}, {
      parseCache: await loadParseCache(cacheDir),
      fetchWrappers: ['doRequest', 'client.doRequest', 'this.doRequest', 'super.doRequest'],
    });
    withConfig = await runPipelineFromRepo(FIXTURE, () => {}, {
      fetchWrappers: ['doRequest', 'client.doRequest', 'this.doRequest', 'super.doRequest'],
    });
  }, 60000);

  afterAll(async () => {
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
  });

  it('reuses cached candidates when wrapper configuration changes', () => {
    expect(warmConfig.usedWorkerPool).toBe(false);
    expect(warmConfig.reparsedFileCount).toBe(0);
    expect(warmConfig.parseCacheHitFileCount).toBeGreaterThan(0);
    const consumers = (result: PipelineResult) =>
      getRelationships(result, 'FETCHES')
        .map((edge) => `${edge.sourceFilePath}:${edge.target}`)
        .sort();
    expect(consumers(warmConfig)).toEqual(consumers(withConfig));
    expect(consumers(warmConfig).length).toBeGreaterThan(0);
  });

  it('does NOT trace an axios-based wrapper without configuration (the gap)', () => {
    const edges = getRelationships(withoutConfig, 'FETCHES');
    const thingsEdge = edges.find((e) => e.target === '/api/things');
    expect(thingsEdge).toBeUndefined();
  });

  it('traces the configured wrapper as a route consumer', () => {
    const edges = getRelationships(withConfig, 'FETCHES');
    const thingsEdge = edges.find(
      (e) => e.sourceFilePath.includes('ThingsList') && e.target === '/api/things',
    );
    expect(thingsEdge).toBeDefined();
  });

  it('traces a configured wrapper called with type arguments', () => {
    const edges = getRelationships(withConfig, 'FETCHES');
    const thingsEdge = edges.find(
      (e) => e.sourceFilePath.includes('TypedThings') && e.target === '/api/things',
    );
    expect(thingsEdge).toBeDefined();
  });

  it.each([
    'NestedTypes.ts',
    'ObjectTypes.ts',
    'FunctionTypes.ts',
    'LiteralTypes.ts',
    'CommentedCall.ts',
    'InstanceWrapper.ts',
    'SuperWrapper.ts',
  ])('traces supported type arguments in %s', (fileName) => {
    const edges = getRelationships(withConfig, 'FETCHES');
    expect(
      edges.some((e) => e.sourceFilePath.endsWith(fileName) && e.target === '/api/things'),
    ).toBe(true);
  });

  it.each([
    'TypeOnlyReference.ts',
    'StoredReference.ts',
    'CommentOnly.ts',
    'StringOnly.ts',
    'ConcatenatedUrl.ts',
    'OtherReceiver.ts',
  ])('does not trace a wrapper consumer in %s', (fileName) => {
    const edges = getRelationships(withConfig, 'FETCHES');
    expect(edges.filter((e) => e.sourceFilePath.endsWith(fileName))).toEqual([]);
  });

  it('does NOT match a configured bare name inside a longer non-ASCII identifier (#1852 review F10)', () => {
    // Accented.tsx calls `cafédoRequest('/api/things')` — `doRequest` preceded by
    // the non-ASCII letter `é`. The exact callee name must reject it.
    const edges = getRelationships(withConfig, 'FETCHES');
    const spurious = edges.find(
      (e) => e.sourceFilePath.includes('Accented') && e.target === '/api/things',
    );
    expect(spurious).toBeUndefined();
  });
});
