import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertOwnedVectorGeneration,
  embeddingGenerationDirectory,
  selectVectorGeneration,
} from '../../src/storage/vector-generation.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';

const generation = 'a'.repeat(32);
const identity = 'b'.repeat(64);
const meta = {
  repoPath: '/repo',
  lastCommit: 'abc',
  indexedAt: 'now',
  graphPath: `lbug.generation.${generation}`,
  graphGeneration: { version: 1, id: generation, coveredContent: 'c'.repeat(64) },
  vectorGeneration: {
    version: 1,
    identity,
    graphGeneration: generation,
    vectorIdentity: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64),
    dimensions: 4,
    nodes: 1,
    chunks: 2,
    indexKind: 'exact',
  },
} satisfies RepoMeta;
const select = (metadata: RepoMeta = meta, graphPath = path.join('/slot', meta.graphPath)) =>
  selectVectorGeneration('/slot', metadata, graphPath, 10000);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

describe('vector generation routing', () => {
  it('preserves the legacy reader and routes a complete matching artifact', () => {
    expect(select({ repoPath: '/repo', lastCommit: '', indexedAt: '' })).toEqual({
      kind: 'legacy',
    });
    expect(select()).toEqual({
      kind: 'ready',
      path: path.join('/slot', 'embeddings', identity, 'vectors'),
      generation: meta.vectorGeneration,
    });
  });
  it('gates pending, foreign, missing and oversized exact artifacts', () => {
    expect(
      select({
        ...meta,
        vectorGeneration: undefined,
        embeddingJob: { version: 1, identity, graphGeneration: generation },
      }),
    ).toMatchObject({ kind: 'unavailable', reason: 'embedding-pending' });
    expect(select({ ...meta, graphGeneration: undefined })).toMatchObject({ kind: 'unavailable' });
    expect(select(meta, '/slot/lbug')).toMatchObject({ kind: 'unavailable' });
    expect(
      select({
        ...meta,
        vectorGeneration: { ...meta.vectorGeneration, graphGeneration: 'f'.repeat(32) },
      }),
    ).toMatchObject({ kind: 'unavailable' });
    expect(
      select({ ...meta, vectorGeneration: { ...meta.vectorGeneration, chunks: 10001 } }),
    ).toMatchObject({ kind: 'unavailable', reason: 'vector-index-pending' });
    expect(
      select({
        ...meta,
        embeddingJob: { version: 1, identity: 'f'.repeat(64), graphGeneration: generation },
      }),
    ).toMatchObject({ kind: 'unavailable' });
  });
  it.each([NaN, -1, 0.5, Infinity])('rejects invalid coverage %s', (chunks) => {
    expect(
      select({ ...meta, vectorGeneration: { ...meta.vectorGeneration, chunks } }),
    ).toMatchObject({ kind: 'unavailable' });
  });
  it('rejects traversal and every symlink boundary', async () => {
    expect(() => embeddingGenerationDirectory('/slot', '../foreign')).toThrow('identity');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-vector-path-'));
    directories.push(root);
    const job = embeddingGenerationDirectory(root, identity);
    await fs.mkdir(job, { recursive: true });
    const file = path.join(job, 'vectors');
    await fs.writeFile(file, 'artifact');
    expect(await assertOwnedVectorGeneration(root, identity)).toBe(file);
    await fs.rename(file, file + '.old');
    await fs.symlink(file + '.old', file);
    await expect(assertOwnedVectorGeneration(root, identity)).rejects.toThrow('regular file');
    await fs.unlink(file);
    await fs.rename(job, job + '.old');
    await fs.symlink(job + '.old', job, 'dir');
    await expect(assertOwnedVectorGeneration(root, identity)).rejects.toThrow('directory');
  });
});
