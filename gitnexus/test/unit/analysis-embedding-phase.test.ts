import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAnalysisResourceBudget } from '../../src/core/analysis-resource-budget.js';

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), prepared: vi.fn(), run: vi.fn() }));
vi.mock('../../src/storage/repo-manager.js', () => ({
  loadMeta: mocks.load,
  saveMeta: mocks.save,
}));
vi.mock('../../src/core/analysis-publication.js', () => ({
  readPreparedAnalysis: mocks.prepared,
  beginInPlaceAnalysis: vi.fn(),
  prepareAnalysisPublication: vi.fn(),
  publishPreparedAnalysis: vi.fn(),
}));
vi.mock('../../src/core/embeddings/embedding-job.js', () => ({
  runPublishedEmbeddingJob: mocks.run,
}));
vi.mock('../../src/core/embeddings/http-client.js', () => ({ isHttpMode: () => true }));
vi.mock('../../src/core/embeddings/embedding-identity.js', () => ({
  resolveEmbeddingIdentity: () => ({ provider: 'http:test', model: 'fixture', dimensions: 4 }),
}));
import { runAnalysisEmbeddingPhase } from '../../src/core/analysis-embedding-phase.js';

const resources = resolveAnalysisResourceBudget({
  effectiveMemoryBytes: 2048 * 1024 ** 2,
  availableCpus: 2,
  modelMemoryMb: 0,
});
const metadata = {
  repoPath: '/repo',
  lastCommit: 'a'.repeat(40),
  indexedAt: '',
  stats: { nodes: 3, embeddings: 1 },
  graphGeneration: { id: 'b'.repeat(32) },
  embeddingJob: { identity: 'retained' },
};
const options = () => ({
  metadataDirectory: '/repo/.gitnexus',
  graphPath: '/repo/.gitnexus/graph.lbug',
  resources,
  callbacks: { onProgress: vi.fn(), onGraphPublished: vi.fn(async () => {}) },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(metadata);
  mocks.prepared.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({ phase: 'ready', metadata });
});

describe('shared embedding phase publication contract', () => {
  it('awaits reader refresh before admitting provider work', async () => {
    const input = options();
    let visible!: () => void;
    input.callbacks.onGraphPublished.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          visible = resolve;
        }),
    );
    const pending = runAnalysisEmbeddingPhase(input);
    await vi.waitFor(() => expect(input.callbacks.onGraphPublished).toHaveBeenCalledOnce());
    expect(mocks.run).not.toHaveBeenCalled();
    visible();
    await expect(pending).resolves.toBe(metadata);
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it('does not report incomplete vector work as complete or clear its durable metadata', async () => {
    mocks.run.mockResolvedValue({ phase: 'embedding', metadata });
    const input = options();
    await expect(runAnalysisEmbeddingPhase(input)).rejects.toThrow('work remains incomplete');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(input.callbacks.onProgress).toHaveBeenLastCalledWith(
      'embeddings',
      98,
      expect.any(String),
      expect.objectContaining({ graphPhase: 'ready', embeddingProgress: { phase: 'failed' } }),
    );
  });

  it('keeps the last measured count and pending work when provider or final verification fails', async () => {
    mocks.run.mockRejectedValue(new Error('Could not verify persisted embedding count'));
    await expect(runAnalysisEmbeddingPhase(options())).rejects.toThrow(
      'Could not verify persisted embedding count',
    );
    expect(mocks.save).not.toHaveBeenCalled();
    expect(metadata.stats.embeddings).toBe(1);
    expect(metadata.embeddingJob.identity).toBe('retained');
  });

  it('rejects a superseded graph before reader refresh or paid work', async () => {
    const input = options();
    await expect(
      runAnalysisEmbeddingPhase({ ...input, expectedGeneration: 'c'.repeat(32) }),
    ).rejects.toThrow('Graph generation changed');
    expect(mocks.run).not.toHaveBeenCalled();
    expect(input.callbacks.onGraphPublished).not.toHaveBeenCalled();
  });

  it.each(['partial', 'unverified-count'])(
    'rejects a foreign %s checkpoint before provider work',
    async (kind) => {
      mocks.load.mockResolvedValue({
        ...metadata,
        embeddingCheckpoint: {
          provider: 'http:other',
          model: 'other',
          dimensions: 4,
          kind,
          at: '',
          nodesProcessed: 1,
          totalNodes: 3,
          chunksProcessed: 1,
          pendingNodeIds: ['n2'],
        },
      });
      await expect(runAnalysisEmbeddingPhase(options())).rejects.toThrow(
        /different provider|Cannot resume/,
      );
      expect(mocks.run).not.toHaveBeenCalled();
      expect(mocks.save).not.toHaveBeenCalled();
    },
  );

  it('refuses prepared or malformed graph receipts without touching embeddings', async () => {
    mocks.prepared.mockResolvedValue({ id: 'a'.repeat(32) });
    await expect(runAnalysisEmbeddingPhase(options())).rejects.toThrow('awaits publication');
    mocks.prepared.mockRejectedValue(new Error('Malformed publication receipt'));
    await expect(runAnalysisEmbeddingPhase(options())).rejects.toThrow('Malformed');
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
