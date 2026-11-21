import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { _captureLogger } from '../../../src/core/logger.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { typescriptProvider } from '../../../src/core/ingestion/languages/typescript.js';
import { typescriptScopeResolver } from '../../../src/core/ingestion/languages/typescript/scope-resolver.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { runScopeResolution } from '../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import {
  getScopeIndexStoreDir,
  TransitionalScopeTree,
} from '../../../src/storage/scope-index-store.js';
import { createTempDirPool } from '../../helpers/temp-dir-pool.js';

const stores = createTempDirPool('scope-pressure-');

function mockHeapRatio(ratio: number) {
  const heap = v8.getHeapStatistics();
  vi.spyOn(v8, 'getHeapStatistics').mockReturnValue({
    ...heap,
    used_heap_size: heap.heap_size_limit * ratio,
  });
}

function parseFixture(content: string) {
  const file = extractParsedFile(typescriptProvider, content, 'a.ts');
  if (!file) throw new Error('Fixture scope extraction failed');
  return file;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  { scenario: 'PDG at the cutoff', ratio: 0.7, seal: true },
  { scenario: 'PDG below the cutoff', ratio: 0.69, seal: false },
  { scenario: 'blank override', ratio: 0.8, setting: '', seal: true },
  { scenario: 'whitespace override', ratio: 0.8, setting: '  ', seal: true },
  { scenario: 'PDG with headroom', ratio: 0.4, seal: false },
  { scenario: 'resident override', ratio: 0.8, setting: '0', seal: false },
  { scenario: 'disk override with headroom', ratio: 0.4, setting: '1', seal: true },
  { scenario: 'ordinary indexing', ratio: 0.8, pdg: false, seal: false },
  { scenario: 'provider without CFG support', ratio: 0.8, noCfg: true, seal: false },
  { scenario: 'scope enumeration', ratio: 0.8, enumerate: true, seal: false },
  { scenario: 'resolved-file observer', ratio: 0.8, observe: true, seal: false },
  {
    scenario: 'resolved-file observer with disk override',
    ratio: 0.4,
    setting: '1',
    observe: true,
    seal: true,
  },
  { scenario: 'empty backing path', ratio: 0.8, emptyStore: true, seal: false },
  { scenario: 'no backing store', ratio: 0.8, noStore: true, seal: false },
])(
  '$scenario',
  ({ ratio, setting, pdg = true, noCfg, enumerate, observe, noStore, emptyStore, seal }) => {
    vi.stubEnv('GITNEXUS_DISK_SCOPE_INDEX', setting);
    vi.stubEnv('INGESTION_EMIT_SCOPES', enumerate ? '1' : undefined);
    mockHeapRatio(ratio);
    const content = 'export function twice(x: number) { return x + x; }';
    const file = parseFixture(content);
    const pending = new Map([
      [file.filePath, file],
      ['later.ts', { ...file, filePath: 'later.ts' }],
    ]);
    const store = stores.dir();
    const sealCall = vi.spyOn(TransitionalScopeTree.prototype, 'seal');
    const stats = runScopeResolution(
      {
        graph: createKnowledgeGraph(),
        model: createSemanticModel(),
        files: [{ path: file.filePath, content }],
        pdg,
        preExtractedParsedFiles: pending,
        scopeIndexStorePath: noStore ? undefined : emptyStore ? '' : store,
        onResolved: observe
          ? ({ parsedFiles }) => {
              expect(parsedFiles.map((parsed) => parsed.filePath)).toEqual([file.filePath]);
              expect(parsedFiles[0].scopes.map((scope) => scope.id)).toEqual(
                file.scopes.map((scope) => scope.id),
              );
            }
          : undefined,
      },
      noCfg
        ? {
            ...typescriptScopeResolver,
            languageProvider: { ...typescriptProvider, cfgVisitor: undefined },
          }
        : typescriptScopeResolver,
    );

    expect(sealCall).toHaveBeenCalledTimes(seal ? 1 : 0);
    expect(existsSync(getScopeIndexStoreDir(store))).toBe(setting === '1');
    if (seal && setting !== '1') expect(readdirSync(store)).toEqual([]);
    expect(stats.filesProcessed).toBe(1);
    expect(pending.has(file.filePath)).toBe(!seal);
    expect(pending.has('later.ts')).toBe(true);
  },
);

it.each(['automatic', 'forced'] as const)('handles a partial %s seal', (mode) => {
  vi.stubEnv('GITNEXUS_DISK_SCOPE_INDEX', mode === 'forced' ? '1' : undefined);
  vi.stubEnv('INGESTION_EMIT_SCOPES', undefined);
  mockHeapRatio(0.8);
  const root = stores.dir();
  const content = 'export const count = 1;';
  const file = parseFixture(content);
  const pending = new Map([[file.filePath, file]]);
  const failure = new Error('simulated full disk');
  const logs = _captureLogger();
  onTestFinished(logs.restore);
  vi.spyOn(TransitionalScopeTree.prototype, 'seal').mockImplementation((storagePath) => {
    const dir = getScopeIndexStoreDir(storagePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 's0.json'), 'partial');
    throw failure;
  });
  const resolve = () =>
    runScopeResolution(
      {
        graph: createKnowledgeGraph(),
        model: createSemanticModel(),
        files: [{ path: file.filePath, content }],
        preExtractedParsedFiles: pending,
        pdg: true,
        scopeIndexStorePath: root,
      },
      typescriptScopeResolver,
    );
  if (mode === 'forced') {
    expect(resolve).toThrow(failure);
  } else {
    expect(resolve().filesProcessed).toBe(1);
    expect(logs.text()).toContain('continuing with resident scopes');
    expect(logs.text()).toContain(failure.message);
    expect(readdirSync(root)).toEqual([]);
  }
  expect(pending.get(file.filePath)).toBe(file);
});

it('cleans a temporary seal when emit throws and preserves previously retained indexes', () => {
  vi.stubEnv('INGESTION_EMIT_SCOPES', undefined);
  mockHeapRatio(0.8);
  const root = stores.dir();
  const content = 'export function f() {}';
  const file = parseFixture(content);
  const input = {
    graph: createKnowledgeGraph(),
    model: createSemanticModel(),
    files: [{ path: file.filePath, content }],
    pdg: true,
    scopeIndexStorePath: root,
  };
  let lookup: (() => string | undefined) | undefined;
  vi.stubEnv('GITNEXUS_DISK_SCOPE_INDEX', '1');
  runScopeResolution(
    {
      ...input,
      onResolved: ({ indexes }) => {
        lookup = () => indexes.scopeTree.getScope(file.moduleScope)?.filePath;
      },
    },
    typescriptScopeResolver,
  );
  const originalDirs = readdirSync(root);
  vi.stubEnv('GITNEXUS_DISK_SCOPE_INDEX', undefined);
  const failure = new Error('emit failed');
  const seal = vi.spyOn(TransitionalScopeTree.prototype, 'seal');
  expect(() =>
    runScopeResolution(
      {
        ...input,
        graph: createKnowledgeGraph(),
        model: createSemanticModel(),
        files: [{ path: 'other.ts', content }],
        onProgress: (phase) => {
          if (phase === 'linking symbols') throw failure;
        },
      },
      typescriptScopeResolver,
    ),
  ).toThrow(failure);
  expect(seal).toHaveBeenCalledOnce();
  expect(existsSync(seal.mock.calls[0][0])).toBe(false);
  expect(readdirSync(root)).toEqual(originalDirs);
  expect(lookup?.()).toBe(file.filePath);
});
