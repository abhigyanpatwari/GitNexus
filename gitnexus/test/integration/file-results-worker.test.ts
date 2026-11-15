import { describe, expect, it } from 'vitest';
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
const files = [
  {
    path: 'a.ts',
    content:
      'export class A { method() { return 1; } } export function call() { return new A().method(); }',
  },
  {
    path: 'b.ts',
    content: 'export const n = 2; export function other(value: number) { return value + n; }',
  },
  { path: 'view.tsx', content: 'export function View() { return <div>hello</div>; }' },
  {
    path: 'api.py',
    content:
      'from fastapi import APIRouter\nrouter = APIRouter()\n@router.get("/items")\ndef items():\n    return []\n',
  },
  {
    path: 'Main.java',
    content: 'class Main { int first() { return second(); } int second() { return 2; } }',
  },
  {
    path: 'main.go',
    content: 'package main\nfunc first() int { return second() }\nfunc second() int { return 2 }\n',
  },
  { path: 'empty.ts', content: '' },
].map((f) => ({
  ...f,
  cacheKey: createHash('sha256').update(f.path).update(f.content).digest('hex'),
}));
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
        .sort()
        .filter(([k]) => k !== 'routePosition')
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
};
describe('file-local output within batched worker jobs', () => {
  it('retains per-file keys in zero-copy dispatch messages', () => {
    const frame = buildDispatchMessage(files);
    expect(frame.message.files.map((f) => f.cacheKey)).toEqual(files.map((f) => f.cacheKey));
    expect(frame.transferList).toHaveLength(files.length);
  });
  it.each([false, true])(
    'matches ordinary worker output with PDG=%s and multiple workers',
    async (pdg) => {
      const ordinary = createWorkerPool(worker, 2, { pdg, subBatchMaxBytes: 1024 * 1024 });
      const packed = createWorkerPool(worker, 2, {
        pdg,
        fileResults: true,
        subBatchMaxBytes: 1024 * 1024,
      });
      try {
        const [normal] = await dispatchChunkParseRound([{ items: files }], ordinary);
        const [encoded] = await dispatchChunkParseRound([{ items: files }], packed);
        expect(encoded.length).toBeLessThan(files.length);
        const expected = empty(),
          actual = empty();
        for (const result of normal) mergeResult(expected, result);
        const records = encoded.flatMap((r) => r.fileResults ?? []);
        expect(records).toHaveLength(files.length);
        for (const input of files) {
          const entry = records.find((r) => r.path === input.path)!;
          expect(entry.key).toBe(input.cacheKey);
          expect('encoded' in entry).toBe(true);
          if (!('encoded' in entry)) throw Error('Expected encoded file');
          expect(entry.encoded.cacheable).toBe(true);
          const result = decodeFileResultSection(
            entry.encoded.facts,
            entry.key,
            entry.path,
            'facts',
          )!.value as ParseWorkerResult;
          result.parsedFiles = decodeFileResultSection(
            entry.encoded.scopes,
            entry.key,
            entry.path,
            'scopes',
          )!.value as ParseWorkerResult['parsedFiles'];
          mergeResult(actual, result);
        }
        expect(canonical(actual)).toEqual(canonical(expected));
        expect(actual.routeFacts?.length).toBe(expected.routeFacts?.length);
        expect(encoded.reduce((n, r) => n + r.fileCount, 0)).toBe(expected.fileCount);
        const emptyRecord = records.find((record) => record.path === 'empty.ts')!;
        if (!('encoded' in emptyRecord)) throw Error('Expected encoded empty file');
        expect(
          decodeFileResultSection(
            emptyRecord.encoded.scopes,
            emptyRecord.key,
            emptyRecord.path,
            'scopes',
          )!.value,
        ).toEqual([]);
      } finally {
        await ordinary.terminate();
        await packed.terminate();
      }
    },
    60000,
  );
});
