import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  analysisMayEmbed,
  resolveHostAnalysisResources,
} from '../../src/core/analysis-host-resources.js';

const mocks = vi.hoisted(() => ({ loadMeta: vi.fn(), placement: vi.fn() }));
vi.mock('../../src/core/ingestion/utils/effective-ram.js', () => ({
  effectiveRamBytes: () => 32768 * 1024 ** 2,
}));
vi.mock('node:os', () => ({ default: { availableParallelism: () => 16 } }));
vi.mock('../../src/storage/repo-manager.js', () => ({
  loadMeta: mocks.loadMeta,
  getStoragePaths: (repo: string, branch: string | null) => ({
    metaPath: `${repo}/index/${branch ?? 'workspace'}/gitnexus.json`,
  }),
}));
vi.mock('../../src/storage/branch-index.js', () => ({ resolveBranchPlacement: mocks.placement }));

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of [
    'GITNEXUS_EMBEDDING_URL',
    'GITNEXUS_EMBEDDING_MODEL',
    'GITNEXUS_WORKER_POOL_SIZE',
    'GITNEXUS_WORKER_HEAP_MB',
    'GITNEXUS_EMBEDDING_THREADS',
    'GITNEXUS_LBUG_BUFFER_POOL_SIZE',
  ])
    vi.stubEnv(key, undefined);
  mocks.loadMeta.mockResolvedValue(null);
  mocks.placement.mockResolvedValue({ branch: 'release' });
});
afterEach(() => vi.unstubAllEnvs());

it('reserves local model capacity only for invocations that may embed', () => {
  expect(resolveHostAnalysisResources({ includeEmbeddings: false }).embedding.modelBytes).toBe(0);
  expect(resolveHostAnalysisResources({ includeEmbeddings: true }).embedding.modelBytes).toBe(
    2048 * 1024 ** 2,
  );
  vi.stubEnv('GITNEXUS_EMBEDDING_URL', 'http://localhost:1234/v1');
  vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', 'remote');
  expect(resolveHostAnalysisResources({ includeEmbeddings: true }).embedding.modelBytes).toBe(0);
});

it('divides the host allowance across concurrent analyses', () => {
  const one = resolveHostAnalysisResources({ includeEmbeddings: false });
  const four = resolveHostAnalysisResources({ includeEmbeddings: false, concurrency: 4 });
  expect(four.totalBytes * 4).toBe(one.totalBytes);
  expect(four.parse.nativeThreads * 4).toBe(one.parse.nativeThreads);
  expect(four.parse.workers).toBeLessThanOrEqual(3);
});

it('honors bounded worker, pool, and embedding-thread overrides', () => {
  vi.stubEnv('GITNEXUS_WORKER_POOL_SIZE', '8');
  vi.stubEnv('GITNEXUS_WORKER_HEAP_MB', '512');
  vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', String(256 * 1024 ** 2));
  vi.stubEnv('GITNEXUS_EMBEDDING_THREADS', '8');
  const budget = resolveHostAnalysisResources({ includeEmbeddings: true });
  expect(budget.parse.workers).toBe(8);
  expect(budget.parse.workerHeapMb).toBe(512);
  expect(budget.parse.graphPoolBytes).toBe(256 * 1024 ** 2);
  expect(budget.embedding.nativeThreads).toBe(8);
});

it.each(['0', ' 0 ', '0.0'])(
  'explains why the native default pool %s cannot be reserved',
  (value) => {
    vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', value);
    expect(() => resolveHostAnalysisResources({ includeEmbeddings: false })).toThrow(
      'bounded analysis cannot reserve',
    );
    expect(() => resolveHostAnalysisResources({ includeEmbeddings: false })).toThrow(
      'Unset GITNEXUS_LBUG_BUFFER_POOL_SIZE',
    );
  },
);

it.each(['-1', '1.5', 'NaN'])(
  'rejects an unbounded or malformed native pool override %s',
  (value) => {
    vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', value);
    expect(() => resolveHostAnalysisResources({ includeEmbeddings: false })).toThrow(
      'positive safe integer',
    );
  },
);

it('honors explicit heap-only overcommit but rejects a conflicting family ceiling', () => {
  expect(
    resolveHostAnalysisResources({ includeEmbeddings: false, mainHeapMb: 40000 }).mainHeapMb,
  ).toBe(40000);
  expect(() =>
    resolveHostAnalysisResources({ includeEmbeddings: false, mainHeapMb: 40000, totalMb: 24576 }),
  ).toThrow('cannot admit');
});

it.each([
  ['pending job', { embeddingJob: {} }],
  ['pending checkpoint', { embeddingCheckpoint: {} }],
  ['preserved vectors', { stats: { embeddings: 1 } }],
])(
  'reserves retry/forced model work for %s from the exact branch metadata',
  async (_case, metadata) => {
    mocks.loadMeta.mockResolvedValue(metadata);
    expect(await analysisMayEmbed('/repo', { force: true, branch: 'release' })).toBe(true);
    expect(mocks.placement).toHaveBeenCalledWith('/repo', 'release');
    expect(mocks.loadMeta).toHaveBeenCalledWith('/repo/index/release');
  },
);

it('keeps plain preservation free of model work and lets explicit drop abandon retries', async () => {
  mocks.loadMeta.mockResolvedValue({ stats: { embeddings: 100 } });
  expect(await analysisMayEmbed('/repo', {})).toBe(false);
  mocks.loadMeta.mockResolvedValue({ embeddingJob: {} });
  expect(await analysisMayEmbed('/repo', { dropEmbeddings: true })).toBe(false);
  expect(await analysisMayEmbed('/repo', { dropEmbeddings: true, embeddings: true })).toBe(true);
});
