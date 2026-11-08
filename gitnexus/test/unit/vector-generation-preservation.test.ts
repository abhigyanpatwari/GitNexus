import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginInPlaceAnalysis,
  prepareAnalysisPublication,
  publishPreparedAnalysis,
} from '../../src/core/analysis-publication.js';
import { loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import { selectVectorGeneration } from '../../src/storage/vector-generation.js';
import { readIndexCapabilities } from '../../src/storage/index-capabilities.js';
import { readEmbeddingJobProgress } from '../../src/storage/embedding-job-progress.js';
import { publicOpsProgress } from '../../src/server/ops-snapshot.js';
import type { AnalyzeJobProgress } from '../../src/server/analyze-job.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';

const generation = 'a'.repeat(32);
const identity = 'b'.repeat(64);
const artifactIdentity = 'c'.repeat(64);
const roots: string[] = [];
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-preserved-')));
  roots.push(root);
  const graphPath = `lbug.generation.${generation}`;
  const metadata: RepoMeta = {
    repoPath: '/repo',
    lastCommit: 'old',
    indexedAt: '',
    runnerIdentity: { schemaVersion: 4 } as RepoMeta['runnerIdentity'],
    graphPath,
    graphGeneration: { version: 1, id: generation, coveredContent: 'd'.repeat(64) },
    vectorGeneration: {
      version: 1,
      identity,
      artifactIdentity,
      graphGeneration: generation,
      vectorIdentity: 'e'.repeat(64),
      inputIdentity: 'f'.repeat(64),
      dimensions: 4,
      nodes: 2,
      chunks: 3,
      indexKind: 'exact',
    },
  };
  const graph = path.join(root, graphPath);
  const vectors = path.join(root, 'embeddings', artifactIdentity, 'vectors');
  await fs.mkdir(path.dirname(vectors), { recursive: true });
  await fs.writeFile(vectors, 'untouched vector artifact');
  await fs.writeFile(graph, 'graph');
  await saveMeta(root, metadata);
  const actions = { verify: async () => {}, saveMetadata: (m: RepoMeta) => saveMeta(root, m) };
  const stage = async () => {
    const file = path.join(root, `lbug.staging.${randomUUID()}`);
    await fs.writeFile(file, 'next graph');
    return file;
  };
  return { root, metadata, graph, vectors, actions, stage };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('preserved vector coverage', () => {
  it.each(['../foreign/lbug', '/foreign/lbug', 'lbug.generation.invalid'])(
    'does not report vectors as ready for a rejected graph route: %s',
    async (graphPath) => {
      const f = await fixture();
      const capabilities = await readIndexCapabilities(f.root, { ...f.metadata, graphPath });
      expect(capabilities?.vectorSearch).toMatchObject({ status: 'unavailable' });
    },
  );

  it('does not report vectors as ready through a symlinked graph generation', async () => {
    const f = await fixture();
    await fs.rename(f.graph, f.graph + '.foreign');
    await fs.symlink(f.graph + '.foreign', f.graph);
    expect((await readIndexCapabilities(f.root, f.metadata))?.vectorSearch).toMatchObject({
      status: 'unavailable',
    });
  });

  it('advances two staged graphs with a small historical reference and no vector writes', async () => {
    const f = await fixture();
    const before = await fs.stat(f.vectors);
    for (let i = 0; i < 2; i++) {
      const prior = await loadMeta(f.root);
      if (!prior) throw new Error('Missing metadata');
      const receipt = await prepareAnalysisPublication(
        f.root,
        await f.stage(),
        prior,
        '1'.repeat(64),
      );
      const published = await publishPreparedAnalysis(f.root, f.actions);
      expect(published?.vectorGeneration).toMatchObject({
        identity,
        artifactIdentity,
        graphGeneration: generation,
        preservedForGraph: receipt.id,
      });
      expect(
        selectVectorGeneration(f.root, published, path.join(f.root, receipt.graphFile), 10000),
      ).toMatchObject({ kind: 'ready', path: f.vectors, coverage: 'preserved' });
      expect(await readIndexCapabilities(f.root, published)).toMatchObject({
        vectorSearch: {
          status: 'exact-scan',
          coverage: 'preserved',
          sourceGraphGeneration: generation,
        },
      });
      expect(await readEmbeddingJobProgress(f.root, published)).toEqual({
        phase: 'preserved',
        chunks: 3,
      });
    }
    const after = await fs.stat(f.vectors);
    expect([after.ino, after.size, after.mtimeMs]).toEqual([
      before.ino,
      before.size,
      before.mtimeMs,
    ]);
    expect(await fs.readFile(f.vectors, 'utf8')).toBe('untouched vector artifact');
  });

  it('binds preservation before invalidating an in-place graph and retains its inode', async () => {
    const f = await fixture();
    const inode = (await fs.stat(f.graph)).ino;
    const dirty = await beginInPlaceAnalysis(
      f.root,
      {
        ...f.metadata,
        incrementalInProgress: { startedAt: 1, toWriteCount: 1 },
      },
      f.actions.saveMetadata,
    );
    expect(selectVectorGeneration(f.root, dirty, f.graph, 10000)).toMatchObject({
      kind: 'unavailable',
    });
    const attemptId = dirty.incrementalInProgress?.attemptId;
    if (!attemptId) throw new Error('Missing attempt');
    const receipt = await prepareAnalysisPublication(
      f.root,
      f.graph,
      {
        ...dirty,
        incrementalInProgress: undefined,
      },
      '2'.repeat(64),
      { mode: 'in-place', attemptId },
    );
    const published = await publishPreparedAnalysis(f.root, f.actions);
    expect(published?.vectorGeneration).toMatchObject({
      graphGeneration: generation,
      preservedForGraph: receipt.id,
    });
    expect(selectVectorGeneration(f.root, published, f.graph, 10000)).toMatchObject({
      kind: 'ready',
      coverage: 'preserved',
    });
    expect((await fs.stat(f.graph)).ino).toBe(inode);
  });

  it('does not turn an unrelated generation into preserved coverage', async () => {
    const f = await fixture();
    const vector = f.metadata.vectorGeneration;
    if (!vector) throw new Error('Missing vector fixture');
    const invalid = {
      ...f.metadata,
      vectorGeneration: { ...vector, graphGeneration: 'f'.repeat(32) },
    };
    await saveMeta(f.root, invalid);
    const receipt = await prepareAnalysisPublication(
      f.root,
      await f.stage(),
      invalid,
      '3'.repeat(64),
    );
    const published = await publishPreparedAnalysis(f.root, f.actions);
    expect(
      selectVectorGeneration(f.root, published, path.join(f.root, receipt.graphFile), 10000),
    ).toMatchObject({ kind: 'unavailable', reason: 'vector-generation-mismatch' });
  });

  it('reports a rebased current artifact by artifact identity, not the job directory', async () => {
    const f = await fixture();
    expect(await readIndexCapabilities(f.root, f.metadata)).toMatchObject({
      vectorSearch: {
        status: 'exact-scan',
        coverage: 'current',
        sourceGraphGeneration: generation,
      },
    });
  });

  it('gates preserved coverage while a job is pending and rejects a foreign preservation target', async () => {
    const f = await fixture();
    const receipt = await prepareAnalysisPublication(
      f.root,
      await f.stage(),
      f.metadata,
      '4'.repeat(64),
    );
    const published = await publishPreparedAnalysis(f.root, f.actions);
    if (!published) throw new Error('Missing publication');
    const graph = path.join(f.root, receipt.graphFile);
    expect(
      selectVectorGeneration(
        f.root,
        { ...published, embeddingJob: { version: 1, identity, graphGeneration: receipt.id } },
        graph,
        10000,
      ),
    ).toEqual({ kind: 'unavailable', reason: 'embedding-pending' });
    expect(
      selectVectorGeneration(
        f.root,
        {
          ...published,
          graphGeneration: { version: 1, id: '9'.repeat(32), coveredContent: '4'.repeat(64) },
        },
        graph,
        10000,
      ),
    ).toEqual({ kind: 'unavailable', reason: 'vector-generation-mismatch' });
  });

  it('forwards preserved progress without inventing current selection totals or leaking identifiers', () => {
    const projected = publicOpsProgress({
      phase: 'graph-ready',
      percent: 100,
      message: 'Graph ready',
      embeddingProgress: {
        phase: 'preserved',
        chunks: 3,
        artifactIdentity,
        sourcePath: '/private',
      },
    } as AnalyzeJobProgress);
    expect(projected.embeddingProgress).toEqual({ phase: 'preserved', chunks: 3 });
  });
});

describe('legacy-only metadata publication', () => {
  it('does not hide corrupt canonical metadata behind an older legacy mirror', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'gitnexus.json'), '{broken');
    await expect(
      prepareAnalysisPublication(f.root, await f.stage(), f.metadata, '7'.repeat(64)),
    ).rejects.toThrow();
    await expect(fs.stat(path.join(f.root, 'analysis-publication.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('binds the legacy metadata receipt and rejects a superseding legacy writer', async () => {
    const f = await fixture();
    await fs.unlink(path.join(f.root, 'gitnexus.json'));
    await prepareAnalysisPublication(f.root, await f.stage(), f.metadata, '5'.repeat(64));
    await fs.writeFile(
      path.join(f.root, 'meta.json'),
      JSON.stringify({ ...f.metadata, lastCommit: 'newer' }),
    );
    await expect(publishPreparedAnalysis(f.root, f.actions)).rejects.toThrow('superseded');
    expect((await loadMeta(f.root))?.lastCommit).toBe('newer');
  });
  it('accepts an unchanged legacy receipt without filling in unknown embedding provenance', async () => {
    const f = await fixture();
    const legacy = {
      ...f.metadata,
      graphGeneration: undefined,
      vectorGeneration: undefined,
      embeddingDims: 4,
    };
    await saveMeta(f.root, legacy);
    await fs.unlink(path.join(f.root, 'gitnexus.json'));
    await prepareAnalysisPublication(f.root, await f.stage(), legacy, '6'.repeat(64));
    const published = await publishPreparedAnalysis(f.root, f.actions);
    expect(published?.vectorGeneration).toBeUndefined();
    expect(published?.embeddingDims).toBe(4);
  });
});
