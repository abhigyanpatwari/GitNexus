import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkerPool } from '../../../src/core/ingestion/workers/worker-pool.js';
import type { ParseWorkerResult } from '../../../src/core/ingestion/workers/parse-worker.js';
import {
  loadParseCache,
  loadParseCacheChunk,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../../src/storage/parse-cache.js';
import {
  clearParsedFileStore,
  getDurableParsedFileDir,
  loadDurableParsedFileIndex,
  pruneAndSaveDurableParsedFileStore,
} from '../../../src/storage/parsedfile-store.js';
import { runtimeParseIdentity } from '../../helpers/runtime-parse-identity.js';
import { runPipelineFromRepo, writeFixtureRepo, type PipelineResult } from './helpers.js';

const realWorker = new URL('../../../dist/core/ingestion/workers/parse-worker.js', import.meta.url);
const providerModule = new URL(
  '../../../dist/core/ingestion/languages/typescript.js',
  import.meta.url,
);
const temporary: string[] = [];
const tempDirectory = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-wrapper-persistence-'));
  temporary.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporary.splice(0))
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fetchEdges(result: PipelineResult): string[] {
  return [...result.graph.iterRelationships()]
    .filter((edge) => edge.type === 'FETCHES')
    .map(
      (edge) => `${result.graph.getNode(edge.sourceId)?.properties.filePath} -> ${edge.targetId}`,
    )
    .sort();
}

describe('fetch-wrapper facts across workers and persistent caches', () => {
  it('reuses raw identity facts on warm runs and re-resolves changed project aliases', async () => {
    const identity = await runtimeParseIdentity();
    const directory = tempDirectory();
    const repo = path.join(directory, 'repo');
    const storage = path.join(directory, 'storage');
    const marker = path.join(directory, 'worker.jsonl');
    const workerPath = path.join(directory, 'observed-worker.mjs');
    fs.writeFileSync(
      workerPath,
      `
import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
const send = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message, ...rest) => {
  if (message.type === 'result') fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
    definitions: message.data.fetchWrapperDefs,
    calls: message.data.fetchWrapperCalls,
  }) + '\\n');
  return send(message, ...rest);
};
await import(${JSON.stringify(realWorker.href)});
`,
    );
    const config = (target: string) =>
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@http': [target] } },
      });
    const files = {
      'tsconfig.json': config('./lib/http.ts'),
      'lib/http.ts':
        'export function request(url, fetch = globalThis.fetch) { return fetch(url); }',
      'lib/plain.ts': 'export function request(url) { return url; }',
      'lib/forward.ts':
        "import { request as send } from '@http'; export function forward(url) { return send(url); }",
      'pages/client.ts':
        "import { forward as send } from '../lib/forward'; send('/api/items'); export function blocked(send) { return send('/api/blocked'); }",
      'app/api/items/route.ts': 'export function GET() { return new Response(); }',
      'app/api/blocked/route.ts': 'export function GET() { return new Response(); }',
    };
    writeFixtureRepo(repo, files);
    const parsedCount = Object.keys(files).length - 1;
    const run = (parseCache: ParseCache) =>
      runPipelineFromRepo(repo, () => {}, {
        workerPoolSize: 1,
        skipGraphPhases: true,
        workerUrlForTest: pathToFileURL(workerPath),
        parseCache,
      });
    const persist = async (cache: ParseCache) => {
      pruneCache(cache, cache.usedKeys);
      const keys = await saveParseCache(storage, cache);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storage),
        identity.base,
        new Set(keys),
      );
      await clearParsedFileStore(storage);
    };
    const coldCache = await loadParseCache(storage, identity, storage);
    const cold = await run(coldCache);
    expect(cold.usedWorkerPool).toBe(true);
    expect(cold.reparsedFileCount).toBe(parsedCount);
    expect(fetchEdges(cold)).toEqual(['pages/client.ts -> Route:/api/items']);
    const observed = fs
      .readFileSync(marker, 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            definitions: ParseWorkerResult['fetchWrapperDefs'];
            calls: ParseWorkerResult['fetchWrapperCalls'];
          },
      );
    expect(observed.flatMap((part) => part.definitions)).toContainEqual(
      expect.objectContaining({
        filePath: 'lib/plain.ts',
        functionName: 'request',
        seed: false,
        definitionId: expect.any(String),
        bindingId: expect.any(String),
      }),
    );
    expect(observed.flatMap((part) => part.calls)).toContainEqual(
      expect.objectContaining({
        filePath: 'pages/client.ts',
        target: { kind: 'import', specifier: '../lib/forward', importedName: 'forward' },
      }),
    );
    await persist(coldCache);
    const durable = await loadDurableParsedFileIndex(
      getDurableParsedFileDir(storage),
      identity.base,
    );
    expect([...durable.values()].flatMap((paths) => [...paths])).toHaveLength(parsedCount);

    const warmCache = await loadParseCache(storage, identity, storage);
    expect(warmCache.entries.size).toBe(0);
    const chunks = await Promise.all(
      [...warmCache.onDiskKeys!].map((key) => loadParseCacheChunk(warmCache, key)),
    );
    const parts = chunks.flatMap((chunk) => chunk ?? []);
    expect(parts.flatMap((part) => part.parsedFiles ?? [])).toEqual([]);
    expect(parts.flatMap((part) => part.fetchWrapperDefs ?? [])).toContainEqual(
      expect.objectContaining({
        filePath: 'lib/forward.ts',
        forwardsTo: expect.arrayContaining([
          expect.objectContaining({
            target: { kind: 'import', specifier: '@http', importedName: 'request' },
          }),
        ]),
      }),
    );
    fs.rmSync(marker);
    const warm = await run(warmCache);
    expect(warm.usedWorkerPool).toBe(false);
    expect(warm.reparsedFileCount).toBe(0);
    expect(warm.parseCacheHitFileCount).toBe(parsedCount);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fetchEdges(warm)).toEqual(fetchEdges(cold));
    await persist(warmCache);

    writeFixtureRepo(repo, { 'tsconfig.json': config('./lib/plain.ts') });
    const changed = await run(await loadParseCache(storage, identity, storage));
    expect(fetchEdges(changed)).toEqual([]);
  }, 180000);

  it('omits scope-dependent HTTP facts when extraction fails but retains definitions and the failure receipt', async () => {
    const directory = tempDirectory();
    const workerPath = path.join(directory, 'failed-scope-worker.mjs');
    fs.writeFileSync(
      workerPath,
      `
const { typescriptProvider } = await import(${JSON.stringify(providerModule.href)});
typescriptProvider.emitScopeCaptures = () => { throw new Error('deliberate scope extraction failure'); };
await import(${JSON.stringify(realWorker.href)});
`,
    );
    const pool = createWorkerPool(pathToFileURL(workerPath), 1);
    try {
      const results = await pool.dispatch<{ path: string; content: string }, ParseWorkerResult>([
        {
          path: 'failed.ts',
          content: "export function request(url) { return fetch(url); } request('/api/items');",
        },
      ]);
      expect(results.flatMap((result) => result.scopeExtractionFailures ?? [])).toEqual([
        'failed.ts',
      ]);
      expect(results.flatMap((result) => result.nodes)).toContainEqual(
        expect.objectContaining({
          label: 'Function',
          properties: expect.objectContaining({ name: 'request' }),
        }),
      );
      expect(results.flatMap((result) => result.fetchWrapperDefs)).toEqual([]);
      expect(results.flatMap((result) => result.fetchWrapperCalls ?? [])).toEqual([]);
    } finally {
      await pool.terminate();
    }
  }, 180000);
});
