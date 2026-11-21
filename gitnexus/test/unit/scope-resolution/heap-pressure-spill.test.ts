import { existsSync } from 'node:fs';
import v8 from 'node:v8';
import { afterEach, expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { typescriptProvider } from '../../../src/core/ingestion/languages/typescript.js';
import { typescriptScopeResolver } from '../../../src/core/ingestion/languages/typescript/scope-resolver.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { runScopeResolution } from '../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { getScopeIndexStoreDir } from '../../../src/storage/scope-index-store.js';
import { createTempDirPool } from '../../helpers/temp-dir-pool.js';

const stores = createTempDirPool('scope-pressure-');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  { scenario: 'PDG under pressure', pressure: true, seal: true },
  { scenario: 'PDG with headroom', pressure: false, seal: false },
  { scenario: 'resident override', pressure: true, setting: '0', seal: false },
  { scenario: 'disk override with headroom', pressure: false, setting: '1', seal: true },
  { scenario: 'ordinary indexing', pressure: true, pdg: false, seal: false },
  { scenario: 'provider without disk parity', pressure: true, unregistered: true, seal: false },
  { scenario: 'scope enumeration', pressure: true, enumerate: true, seal: false },
  { scenario: 'resolved-file observer', pressure: true, observe: true, seal: false },
  { scenario: 'no backing store', pressure: true, noStore: true, seal: false },
])(
  '$scenario',
  ({ pressure, setting, pdg = true, unregistered, enumerate, observe, noStore, seal }) => {
    vi.stubEnv('GITNEXUS_DISK_SCOPE_INDEX', setting);
    vi.stubEnv('INGESTION_EMIT_SCOPES', enumerate ? '1' : undefined);
    const heap = v8.getHeapStatistics();
    vi.spyOn(v8, 'getHeapStatistics').mockReturnValue({
      ...heap,
      used_heap_size: heap.heap_size_limit * (pressure ? 0.8 : 0.4),
    });
    const content = 'export function twice(x: number) { return x + x; }';
    const file = extractParsedFile(typescriptProvider, content, 'a.ts');
    if (!file) throw new Error('Fixture scope extraction failed');
    const pending = new Map([
      [file.filePath, file],
      ['later.ts', { ...file, filePath: 'later.ts' }],
    ]);
    const store = stores.dir();
    const stats = runScopeResolution(
      {
        graph: createKnowledgeGraph(),
        model: createSemanticModel(),
        files: [{ path: file.filePath, content }],
        pdg,
        preExtractedParsedFiles: pending,
        scopeIndexStorePath: noStore ? undefined : store,
        onResolved: observe ? ({ parsedFiles }) => expect(parsedFiles).toHaveLength(1) : undefined,
      },
      unregistered ? { ...typescriptScopeResolver } : typescriptScopeResolver,
    );

    expect(existsSync(getScopeIndexStoreDir(store))).toBe(seal);
    expect(stats.filesProcessed).toBe(1);
    expect(pending.has(file.filePath)).toBe(!seal);
    expect(pending.has('later.ts')).toBe(true);
  },
);
