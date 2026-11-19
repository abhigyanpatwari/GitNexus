import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  embeddingInputIdentity,
  embeddingJobIdentity,
  embeddingVectorIdentity,
} from '../../src/core/embeddings/embedding-job-identity.js';
import {
  buildSiblingEmbeddingCache,
  findSiblingSlotDirs,
  materializeSiblingRows,
  type SiblingEmbeddingSource,
} from '../../src/core/embeddings/sibling-embedding-cache.js';
import type {
  CachedEmbeddingMeta,
  CachedEmbeddingsSnapshot,
} from '../../src/core/embeddings/embedding-restore-spill.js';

describe('sibling embedding identity helpers (#3631)', () => {
  const graph = {
    generation: 'generation',
    coveredContent: 'dirty-coverage',
    revision: 'revision',
    analyzer: 'analyzer',
    parser: 'parser',
    schema: 'schema',
    vectorSchema: 'vectors-v2',
  };
  const vector = { provider: 'local', model: 'model', dimensions: 384 };
  const config = {
    chunkSize: 2000,
    overlap: 100,
    maxSnippetLength: 2000,
    maxDescriptionLength: 500,
    maxInputChars: 8192,
  };

  it('match the digests embeddingJobIdentity persists in vectorGeneration', () => {
    const job = embeddingJobIdentity(graph, vector, 'v7', config);
    expect(embeddingVectorIdentity(vector)).toBe(job.vectorIdentity);
    expect(embeddingInputIdentity('v7', config)).toBe(job.inputIdentity);
    expect(embeddingInputIdentity('v7', config, 'symbol')).toBe(
      embeddingJobIdentity(graph, vector, 'v7', config, 'symbol').inputIdentity,
    );
  });

  it('separate models, dimensions and text versions', () => {
    expect(embeddingVectorIdentity({ ...vector, model: 'other' })).not.toBe(
      embeddingVectorIdentity(vector),
    );
    expect(embeddingVectorIdentity({ ...vector, dimensions: 768 })).not.toBe(
      embeddingVectorIdentity(vector),
    );
    expect(embeddingInputIdentity('v8', config)).not.toBe(embeddingInputIdentity('v7', config));
  });
});

const meta = (
  nodeId: string,
  chunkIndex: number,
  contentHash: string | undefined,
  vectorIndex: number,
): CachedEmbeddingMeta => ({
  nodeId,
  chunkIndex,
  startLine: 10 + chunkIndex,
  endLine: 12 + chunkIndex,
  contentHash,
  vectorIndex,
});

const snapshotOf = (metas: CachedEmbeddingMeta[]): CachedEmbeddingsSnapshot => ({
  embeddingNodeIds: new Set(metas.map((m) => m.nodeId)),
  embeddings: metas.map((m) => ({
    nodeId: m.nodeId,
    chunkIndex: m.chunkIndex,
    startLine: m.startLine,
    endLine: m.endLine,
    contentHash: m.contentHash,
    embedding: [m.chunkIndex + 0.5, 0.25],
  })),
  rows: metas,
});

const sourceOf = (slotDir: string, metas: CachedEmbeddingMeta[]): SiblingEmbeddingSource => ({
  slotDir,
  snapshot: snapshotOf(metas),
});

describe('buildSiblingEmbeddingCache (#3631)', () => {
  it('keys complete chunk sets by content hash, not node id', () => {
    const cache = buildSiblingEmbeddingCache([
      sourceOf('/slots/a', [meta('node-a', 0, 'hash-1', 0), meta('node-a', 1, 'hash-1', 1)]),
    ]);
    expect(cache).toBeDefined();
    expect(cache!.rowCount).toBe(2);
    const refs = cache!.byContentHash.get('hash-1');
    expect(refs).toHaveLength(2);
    expect(refs!.map((r) => r.meta.chunkIndex)).toEqual([0, 1]);
  });

  it('drops hashless rows and partial chunk sets', () => {
    const cache = buildSiblingEmbeddingCache([
      sourceOf('/slots/a', [
        meta('legacy', 0, undefined, 0),
        meta('partial', 1, 'hash-partial', 1),
        meta('whole', 0, 'hash-whole', 2),
      ]),
    ]);
    expect(cache).toBeDefined();
    expect(cache!.byContentHash.has('hash-partial')).toBe(false);
    expect(cache!.byContentHash.get('hash-whole')).toHaveLength(1);
    expect(cache!.rowCount).toBe(1);
  });

  it('lets the first source with a complete set claim a hash', () => {
    const first = sourceOf('/slots/first', [meta('n1', 0, 'hash-x', 0)]);
    const second = sourceOf('/slots/second', [meta('n2', 0, 'hash-x', 0)]);
    const cache = buildSiblingEmbeddingCache([first, second]);
    expect(cache!.byContentHash.get('hash-x')![0].source).toBe(first);
    expect(cache!.rowCount).toBe(1);
  });

  it('falls through to a later source when the first set is partial', () => {
    const partial = sourceOf('/slots/partial', [meta('n1', 1, 'hash-x', 0)]);
    const whole = sourceOf('/slots/whole', [
      meta('n2', 0, 'hash-x', 0),
      meta('n2', 1, 'hash-x', 1),
    ]);
    const cache = buildSiblingEmbeddingCache([partial, whole]);
    expect(cache!.byContentHash.get('hash-x')).toHaveLength(2);
    expect(cache!.byContentHash.get('hash-x')![0].source).toBe(whole);
  });

  it('returns undefined when nothing is reusable', () => {
    expect(buildSiblingEmbeddingCache([sourceOf('/slots/a', [meta('n', 0, undefined, 0)])])).toBe(
      undefined,
    );
    expect(buildSiblingEmbeddingCache([])).toBe(undefined);
  });
});

describe('materializeSiblingRows (#3631)', () => {
  it('rewrites rows to the target node id, sorted by chunk', () => {
    const source = sourceOf('/slots/a', [
      meta('sibling-node', 1, 'hash-1', 0),
      meta('sibling-node', 0, 'hash-1', 1),
    ]);
    const cache = buildSiblingEmbeddingCache([source]);
    const rows = materializeSiblingRows(cache!.byContentHash.get('hash-1')!, 'target-node');
    expect(rows.map((r) => r.nodeId)).toEqual(['target-node', 'target-node']);
    expect(rows.map((r) => r.chunkIndex)).toEqual([0, 1]);
    expect(rows[0].embedding).toEqual([0.5, 0.25]);
    expect(rows[1].embedding).toEqual([1.5, 0.25]);
  });
});

describe('findSiblingSlotDirs (#3631)', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  const makeStorage = async (): Promise<string> => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-test-sibling-slots-'));
    const storage = path.join(root, '.gitnexus');
    await fs.mkdir(path.join(storage, 'branches', 'feat-a'), { recursive: true });
    await fs.mkdir(path.join(storage, 'branches', 'feat-b'), { recursive: true });
    await fs.writeFile(path.join(storage, 'branches', 'not-a-dir'), 'x');
    return storage;
  };

  it('lists the flat slot and branch slots except the target', async () => {
    const storage = await makeStorage();
    const flat = path.resolve(storage);
    const a = path.join(storage, 'branches', 'feat-a');
    const b = path.join(storage, 'branches', 'feat-b');
    await expect(
      findSiblingSlotDirs({ targetMetaDir: flat, storagePath: storage }),
    ).resolves.toEqual(expect.arrayContaining([a, b]));
    await expect(
      findSiblingSlotDirs({ targetMetaDir: flat, storagePath: storage }),
    ).resolves.toHaveLength(2);
    await expect(findSiblingSlotDirs({ targetMetaDir: a, storagePath: storage })).resolves.toEqual(
      expect.arrayContaining([flat, b]),
    );
  });

  it('lists shared-store checkout slots except the target', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-test-sibling-store-'));
    const checkoutsDir = path.join(root, 'store', 'checkouts');
    const mine = path.join(checkoutsDir, 'mine');
    const theirs = path.join(checkoutsDir, 'theirs');
    await fs.mkdir(mine, { recursive: true });
    await fs.mkdir(theirs, { recursive: true });
    const dirs = await findSiblingSlotDirs({
      targetMetaDir: mine,
      storagePath: mine,
      sharedStore: {
        key: 'k',
        root: path.join(root, 'store'),
        cachesDir: path.join(root, 'store', 'caches'),
        commitsDir: path.join(root, 'store', 'commits'),
        checkoutsDir,
        checkoutSlot: mine,
        canonicalCheckout: null,
      },
    });
    expect(dirs).toEqual([theirs]);
  });

  it('returns an empty list when no branches directory exists', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-test-sibling-none-'));
    const storage = path.join(root, '.gitnexus');
    await fs.mkdir(storage, { recursive: true });
    await expect(
      findSiblingSlotDirs({ targetMetaDir: storage, storagePath: storage }),
    ).resolves.toEqual([]);
  });
});
