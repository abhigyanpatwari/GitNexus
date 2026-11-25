import { compareCodeUnits } from '../../src/lib/utils.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  createWorkerPool,
  buildDispatchMessage,
} from '../../src/core/ingestion/workers/worker-pool.js';
import { dispatchChunkParseRound } from '../../src/core/ingestion/parsing-processor.js';
import { mergeResult } from '../../src/core/ingestion/workers/result-merge.js';
import { decodeFileResultSection } from '../../src/storage/file-result-codec.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';
const worker = pathToFileURL(path.resolve('dist/core/ingestion/workers/parse-worker.js'));
export function withCacheKeys(files: { path: string; content: string }[]) {
  return files.map((f) => ({
    ...f,
    cacheKey: createHash('sha256').update(f.path).update(f.content).digest('hex'),
  }));
}
const empty = (): ParseWorkerResult => ({
  nodes: [],
  relationships: [],
  symbols: [],
  calls: [],
  assignments: [],
  routes: [],
  fetchCalls: [],
  fetchWrapperDefs: [],
  decoratorRoutes: [],
  routerIncludes: [],
  routerImports: [],
  toolDefs: [],
  ormQueries: [],
  constructorBindings: [],
  fileScopeBindings: [],
  parsedFiles: [],
  skippedLanguages: {},
  fileCount: 0,
});
const canonical = (value: unknown): unknown => {
  if (value instanceof Map) return canonical([...value]);
  if (value instanceof Set) return canonical([...value]);
  if (Array.isArray(value))
    return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .filter(([k]) => k !== 'routePosition')
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
};
export function assertDispatchFrame(files: ReturnType<typeof withCacheKeys>) {
  const frame = buildDispatchMessage(files);
  assert.deepEqual(
    frame.message.files.map((f) => f.cacheKey),
    files.map((f) => f.cacheKey),
  );
  assert.equal(frame.transferList.length, files.length);
}
export async function assertBatchedFileResults(
  files: ReturnType<typeof withCacheKeys>,
  pdg: boolean,
) {
  const ordinary = createWorkerPool(worker, 2, { pdg, subBatchMaxBytes: 1024 * 1024 });
  const packed = createWorkerPool(worker, 2, {
    pdg,
    fileResults: true,
    subBatchMaxBytes: 1024 * 1024,
  });
  try {
    const [normal] = await dispatchChunkParseRound([{ items: files }], ordinary);
    const [encoded] = await dispatchChunkParseRound([{ items: files }], packed);
    assert.ok(encoded.length < files.length);
    const expected = empty(),
      actual = empty();
    for (const result of normal) mergeResult(expected, result);
    const records = encoded.flatMap((r) => r.fileResults ?? []);
    assert.equal(records.length, files.length);
    for (const input of files) {
      const entry = records.find((r) => r.path === input.path)!;
      assert.equal(entry.key, input.cacheKey);
      assert.equal('encoded' in entry, true);
      if (!('encoded' in entry)) throw new Error('Expected encoded file');
      assert.equal(entry.encoded.cacheable, true);
      const result = decodeFileResultSection(entry.encoded.facts, entry.key, entry.path, 'facts')!
        .value as ParseWorkerResult;
      result.parsedFiles = decodeFileResultSection(
        entry.encoded.scopes,
        entry.key,
        entry.path,
        'scopes',
      )!.value as ParseWorkerResult['parsedFiles'];
      mergeResult(actual, result);
    }
    assert.deepEqual(canonical(actual), canonical(expected));
    assert.equal(actual.routeFacts?.length, expected.routeFacts?.length);
    assert.equal(
      encoded.reduce((n, r) => n + r.fileCount, 0),
      expected.fileCount,
    );
    const emptyRecord = records.find((record) => record.path === 'empty.ts')!;
    if (!('encoded' in emptyRecord)) throw new Error('Expected encoded empty file');
    assert.deepEqual(
      decodeFileResultSection(
        emptyRecord.encoded.scopes,
        emptyRecord.key,
        emptyRecord.path,
        'scopes',
      )!.value,
      [],
    );
  } finally {
    await ordinary.terminate();
    await packed.terminate();
  }
}
