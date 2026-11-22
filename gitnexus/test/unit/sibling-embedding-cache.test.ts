import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  embeddingInputIdentity,
  embeddingJobIdentity,
  embeddingVectorIdentity,
} from '../../src/core/embeddings/embedding-job-identity.js';
import {
  buildSiblingClaims,
  findSiblingSlotDirs,
  findSiblingSlotDirsForSlot,
  materializeSiblingRows,
  siblingUnsafeNodeIds,
} from '../../src/core/embeddings/sibling-embedding-cache.js';
import type { CachedEmbeddingMeta } from '../../src/core/embeddings/embedding-restore-spill.js';
import type { CachedEmbedding } from '../../src/core/embeddings/types.js';
import type { RepoMeta } from '../../src/storage/repo-manager.js';

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
  vectorIndex = 0,
): CachedEmbeddingMeta => ({
  nodeId,
  chunkIndex,
  startLine: 10 + chunkIndex,
  endLine: 12 + chunkIndex,
  contentHash,
  vectorIndex,
});

const BARE = 'a'.repeat(40);
const FULL = `${BARE}:${'b'.repeat(40)}`;

describe('buildSiblingClaims (#3631)', () => {
  it('claims a complete chunk set under its stored hash, sorted by chunk', () => {
    const claims = buildSiblingClaims(
      [meta('node-a', 1, 'hash-1'), meta('node-a', 0, 'hash-1')],
      new Set(),
    );
    const claim = claims.get('hash-1');
    expect(claim).toBeDefined();
    expect(claim!.storedHash).toBe('hash-1');
    expect(claim!.metas.map((m) => m.chunkIndex)).toEqual([0, 1]);
    expect(claim!.metas[0].nodeId).toBe('node-a');
  });

  it('drops hashless rows, gapped sets and mixed-hash sets', () => {
    const claims = buildSiblingClaims(
      [
        meta('legacy', 0, undefined),
        meta('gapped', 0, 'hash-gap'),
        meta('gapped', 2, 'hash-gap'),
        meta('mixed', 0, 'hash-mix'),
        meta('mixed', 1, 'hash-other'),
        meta('whole', 0, 'hash-whole'),
      ],
      new Set(),
    );
    expect(claims.has('hash-gap')).toBe(false);
    expect(claims.has('hash-mix')).toBe(false);
    expect(claims.has('hash-other')).toBe(false);
    expect(claims.get('hash-whole')!.metas).toHaveLength(1);
  });

  it('indexes a full-form claim under its bare prefix too, keeping the stored form', () => {
    const claims = buildSiblingClaims([meta('klass', 0, FULL)], new Set());
    expect(claims.get(FULL)!.storedHash).toBe(FULL);
    expect(claims.get(BARE)).toBe(claims.get(FULL));
  });

  it('judges duplicate hashes per node: one complete set claims, the other is ignored', () => {
    // Two distinct nodes can share a content hash (the hash does not mix
    // in the node id). Grouping by hash alone merged their chunk sets and
    // discarded both as "incomplete" — per-node claims keep the reuse.
    const claims = buildSiblingClaims(
      [meta('util-a', 0, 'hash-x'), meta('util-b', 0, 'hash-x'), meta('util-b', 1, 'hash-x')],
      new Set(),
    );
    const claim = claims.get('hash-x');
    expect(claim).toBeDefined();
    expect(claim!.metas.map((m) => m.nodeId)).toEqual(['util-a']);
  });

  it('excludes unsafe nodes but lets another node claim the same hash', () => {
    const claims = buildSiblingClaims(
      [meta('half-written', 0, 'hash-x'), meta('whole', 0, 'hash-x'), meta('whole', 1, 'hash-x')],
      new Set(['half-written']),
    );
    expect(claims.get('hash-x')!.metas.map((m) => m.nodeId)).toEqual(['whole', 'whole']);
  });
});

describe('siblingUnsafeNodeIds (#3631)', () => {
  const asMeta = (partial: Partial<RepoMeta>): RepoMeta => partial as RepoMeta;

  it('collects pending nodes from interrupted checkpoints, kind absent or explicit', () => {
    expect([
      ...siblingUnsafeNodeIds(asMeta({ embeddingCheckpoint: { pendingNodeIds: ['n1'] } as never })),
    ]).toEqual(['n1']);
    expect([
      ...siblingUnsafeNodeIds(
        asMeta({
          embeddingCheckpoint: { kind: 'interrupted', pendingNodeIds: ['n2'] } as never,
        }),
      ),
    ]).toEqual(['n2']);
  });

  it('ignores partial checkpoints (their pending nodes hold no rows)', () => {
    expect(
      siblingUnsafeNodeIds(
        asMeta({ embeddingCheckpoint: { kind: 'partial', pendingNodeIds: ['n1'] } as never }),
      ).size,
    ).toBe(0);
  });

  it('collects staged-recovery unsafe nodes', () => {
    expect([
      ...siblingUnsafeNodeIds(
        asMeta({ embeddingCheckpoint: { recovery: { unsafeNodeIds: ['n3'] } } as never }),
      ),
    ]).toEqual(['n3']);
  });

  it('is empty for a clean meta', () => {
    expect(siblingUnsafeNodeIds(undefined).size).toBe(0);
    expect(siblingUnsafeNodeIds(asMeta({})).size).toBe(0);
  });
});

describe('materializeSiblingRows (#3631)', () => {
  it('rewrites rows to the target node id, sorted by chunk, keeping hash and lines', () => {
    const rows: CachedEmbedding[] = [
      {
        nodeId: 'sibling-node',
        chunkIndex: 1,
        startLine: 11,
        endLine: 13,
        contentHash: FULL,
        embedding: [1.5, 0.25],
      },
      {
        nodeId: 'sibling-node',
        chunkIndex: 0,
        startLine: 10,
        endLine: 12,
        contentHash: FULL,
        embedding: [0.5, 0.25],
      },
    ];
    const materialized = materializeSiblingRows(rows, 'target-node');
    expect(materialized.map((r) => r.nodeId)).toEqual(['target-node', 'target-node']);
    expect(materialized.map((r) => r.chunkIndex)).toEqual([0, 1]);
    expect(materialized[0].embedding).toEqual([0.5, 0.25]);
    expect(materialized[0].contentHash).toBe(FULL);
    expect(materialized[0].startLine).toBe(10);
  });
});

describe('findSiblingSlotDirs (#3631)', () => {
  let root: string | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
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

  it('lists shared-store checkout slots and their branch slots except the target', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-test-sibling-store-'));
    const checkoutsDir = path.join(root, 'store', 'checkouts');
    const mine = path.join(checkoutsDir, 'mine');
    const theirs = path.join(checkoutsDir, 'theirs');
    const theirsBranch = path.join(theirs, 'branches', 'feat-x');
    await fs.mkdir(mine, { recursive: true });
    await fs.mkdir(theirsBranch, { recursive: true });
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
    expect(dirs).toEqual([theirs, theirsBranch]);
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

describe('findSiblingSlotDirsForSlot (#3631)', () => {
  let root: string | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('derives siblings for flat and branch slots from the slot path alone', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-test-sibling-forslot-'));
    const storage = path.join(root, '.gitnexus');
    const a = path.join(storage, 'branches', 'feat-a');
    const b = path.join(storage, 'branches', 'feat-b');
    await fs.mkdir(a, { recursive: true });
    await fs.mkdir(b, { recursive: true });
    await expect(findSiblingSlotDirsForSlot(storage)).resolves.toEqual([a, b]);
    await expect(findSiblingSlotDirsForSlot(a)).resolves.toEqual(
      expect.arrayContaining([path.resolve(storage), b]),
    );
    await expect(findSiblingSlotDirsForSlot(a)).resolves.toHaveLength(2);
  });

  it('derives the checkout family for a shared-store checkout slot', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-test-sibling-home-'));
    vi.stubEnv('GITNEXUS_HOME', root);
    const checkoutsDir = path.join(root, 'stores', 'key1', 'checkouts');
    const mine = path.join(checkoutsDir, 'mine');
    const theirs = path.join(checkoutsDir, 'theirs');
    const theirsBranch = path.join(theirs, 'branches', 'feat-x');
    const myBranch = path.join(mine, 'branches', 'feat-y');
    await fs.mkdir(myBranch, { recursive: true });
    await fs.mkdir(theirsBranch, { recursive: true });
    await expect(findSiblingSlotDirsForSlot(mine)).resolves.toEqual(
      expect.arrayContaining([myBranch, theirs, theirsBranch]),
    );
    await expect(findSiblingSlotDirsForSlot(mine)).resolves.toHaveLength(3);
    await expect(findSiblingSlotDirsForSlot(myBranch)).resolves.toEqual(
      expect.arrayContaining([mine, theirs, theirsBranch]),
    );
  });
});
