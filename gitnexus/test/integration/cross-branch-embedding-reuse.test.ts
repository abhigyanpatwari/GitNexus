import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import lbug from '@ladybugdb/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { resolveAnalysisResourceBudget } from '../../src/core/analysis-resource-budget.js';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import * as sidecar from '../../src/core/embeddings/embedding-sidecar-client.js';
import * as runtimeSupport from '../../src/core/embeddings/runtime-support.js';

/**
 * #3631 Phase 1: analyzing a second branch of the same repository copies
 * embedding rows from the first branch's index for unchanged content
 * (keyed by content hash + embedding identity), re-embeds only what
 * changed, and leaves the sibling index untouched. Only inference is
 * faked: analyze, the sibling harvest, hashes and DB writes are real.
 */
describe('cross-branch embedding reuse (#3631)', () => {
  let tmp: TestDBHandle | undefined;
  afterEach(async () => {
    await adapter.closeLbug();
    await tmp?.cleanup();
    tmp = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const setupMocks = () => {
    vi.spyOn(runtimeSupport, 'getLocalEmbeddingRuntimeBlocker').mockReturnValue(null);
    vi.spyOn(sidecar, 'ensureEmbeddingSidecar').mockResolvedValue({ device: 'cpu' });
    vi.spyOn(sidecar, 'reapEmbeddingSidecarAndWait').mockResolvedValue(undefined);
    // Deterministic per-text vectors, so a copied row can be told apart
    // from a freshly embedded one only by WHICH texts reached the embedder.
    return vi.spyOn(sidecar, 'sidecarEmbedBatch').mockImplementation(async (texts) =>
      texts.map((text) => {
        let h = 0;
        for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
        const vector = new Float32Array(EMBEDDING_DIMS);
        vector[0] = h % 997;
        vector[1] = text.length;
        return vector;
      }),
    );
  };

  const setupRepo = async (name: string) => {
    tmp = await createTempDir(name);
    const repo = path.join(tmp.dbPath, 'repo');
    await fs.mkdir(repo);
    vi.stubEnv('GITNEXUS_HOME', path.join(tmp.dbPath, 'home'));
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'never');
    vi.stubEnv('GITNEXUS_EMBEDDING_URL', '');
    vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', '');
    vi.stubEnv('GITNEXUS_EMBEDDING_MODEL_ID', '');
    vi.stubEnv('GITNEXUS_EMBEDDING_DIMS', String(EMBEDDING_DIMS));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    return { repo, git };
  };

  const commitAll = (git: (...args: string[]) => Buffer, message: string) => {
    git('add', '-A');
    git('-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-qm', message);
  };

  const readRows = async (repo: string, branch?: string) => {
    await adapter.initLbug(getStoragePaths(repo, branch).lbugPath, { skipFts: true });
    try {
      return await adapter.executeQuery(
        'MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId, e.contentHash AS hash, e.embedding AS vector ORDER BY nodeId',
      );
    } finally {
      await adapter.closeLbug();
    }
  };

  const options = {
    force: true,
    embeddings: true,
    skipFts: true,
    skipAgentsMd: true,
    skipSkills: true,
  };

  it('reuses unchanged rows from the sibling branch, re-embeds changes, skips deletions', async () => {
    const embed = setupMocks();
    const { repo, git } = await setupRepo('gitnexus-test-cross-branch-reuse-');
    await fs.writeFile(path.join(repo, 'main.ts'), 'export function main() { return 1; }\n');
    await fs.writeFile(path.join(repo, 'util.ts'), 'export function util() { return 2; }\n');
    await fs.writeFile(path.join(repo, 'gone.ts'), 'export function gone() { return 4; }\n');
    commitAll(git, 'fixture');

    // Branch main → flat slot. Everything is embedded fresh.
    await runFullAnalysis(repo, options, { onProgress: () => {} });
    expect(embed.mock.calls.flatMap(([texts]) => texts)).toHaveLength(3);
    const flatRows = await readRows(repo);
    expect(flatRows).toHaveLength(3);
    const flatMeta = await loadMeta(path.dirname(getStoragePaths(repo).metaPath));
    expect(flatMeta?.embeddingIdentity?.vectorIdentity).toBeTypeOf('string');
    expect(flatMeta?.embeddingIdentity?.inputIdentity).toBeTypeOf('string');
    const flatByNode = new Map(flatRows.map((row) => [row.nodeId, row]));

    // Branch feature: util changes, gone is deleted, main is untouched.
    git('checkout', '-qb', 'feature');
    await fs.writeFile(path.join(repo, 'util.ts'), 'export function util() { return 3; }\n');
    git('rm', '-q', 'gone.ts');
    commitAll(git, 'feature changes');

    embed.mockClear();
    const logs: string[] = [];
    await runFullAnalysis(
      repo,
      { ...options, branch: 'feature' },
      { onProgress: () => {}, onLog: (message) => logs.push(message) },
    );

    // Only the changed file reached the embedder; main was copied, gone is
    // not in this branch's graph at all.
    const embeddedTexts = embed.mock.calls.flatMap(([texts]) => texts);
    expect(embeddedTexts).toHaveLength(1);
    expect(embeddedTexts[0]).toContain('return 3');
    expect(logs).toContain(
      'Reused 1 node embeddings (1 chunks) from sibling branch indexes; embedded 1 nodes fresh.',
    );

    const featureRows = await readRows(repo, 'feature');
    expect(featureRows).toHaveLength(2);
    const featureByNode = new Map(featureRows.map((row) => [row.nodeId, row]));
    const nodeIdFor = (symbol: string) =>
      [...flatByNode.keys()].find((id) => id.endsWith(`:${symbol}`))!;
    const mainNodeId = nodeIdFor('main');
    const utilNodeId = nodeIdFor('util');
    const goneNodeId = nodeIdFor('gone');
    // The copied row carries the sibling's hash AND vector, under this
    // branch's (identical, path-derived) node id.
    expect(featureByNode.get(mainNodeId)?.hash).toBe(flatByNode.get(mainNodeId)?.hash);
    expect(featureByNode.get(mainNodeId)?.vector).toEqual(flatByNode.get(mainNodeId)?.vector);
    // The changed node was re-embedded under its new hash.
    expect(featureByNode.get(utilNodeId)?.hash).not.toBe(flatByNode.get(utilNodeId)?.hash);
    // The deleted file has no row in the new branch's index.
    expect(featureByNode.has(goneNodeId)).toBe(false);

    // The sibling index is untouched, and stays intact when the new
    // branch's index is deleted.
    expect(await readRows(repo)).toEqual(flatRows);
    await fs.rm(path.join(getStoragePaths(repo).storagePath, 'branches'), {
      recursive: true,
      force: true,
    });
    expect(await readRows(repo)).toEqual(flatRows);

    // A different embedding model identity must NOT reuse: the flat slot's
    // recorded digests no longer match the run, so everything re-embeds.
    git('checkout', '-q', 'feature');
    vi.stubEnv('GITNEXUS_EMBEDDING_MODEL_ID', 'fixture/model-x');
    embed.mockClear();
    const modelLogs: string[] = [];
    await runFullAnalysis(
      repo,
      { ...options, branch: 'feature' },
      { onProgress: () => {}, onLog: (message) => modelLogs.push(message) },
    );
    expect(embed.mock.calls.flatMap(([texts]) => texts)).toHaveLength(2);
    expect(modelLogs.some((line) => line.startsWith('Reused '))).toBe(false);
  }, 180_000);

  it('keeps single-branch behavior unchanged when no sibling exists', async () => {
    const embed = setupMocks();
    const { repo, git } = await setupRepo('gitnexus-test-single-branch-');
    await fs.writeFile(path.join(repo, 'solo.ts'), 'export function solo() { return 9; }\n');
    commitAll(git, 'fixture');

    const logs: string[] = [];
    const callbacks = {
      onProgress: () => {},
      onLog: (message: string) => logs.push(message),
    };
    await runFullAnalysis(repo, options, callbacks);
    expect(embed.mock.calls.flatMap(([texts]) => texts)).toHaveLength(1);
    expect(logs.some((line) => line.startsWith('Reused '))).toBe(false);

    // A forced re-analyze is served by the slot's own cache, as before.
    embed.mockClear();
    await runFullAnalysis(repo, options, callbacks);
    expect(embed).not.toHaveBeenCalled();
    expect(logs.some((line) => line.startsWith('Reused '))).toBe(false);
    expect(await readRows(repo)).toHaveLength(1);
  }, 120_000);
});

/**
 * Round 2 (#3631 review): the publication-job path every shipped entry
 * point actually takes, hydrated (full-form) hashes, the identity-stamp
 * rule, drop suppression, and interrupted-sibling exclusion. The inline
 * tests fake only the sidecar; the publication/stamp tests fake only the
 * HTTP endpoint — analyze, jobs, hashes and DB writes are real.
 */
describe('cross-branch embedding reuse — round 2 (#3631)', () => {
  let tmp: TestDBHandle | undefined;
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await adapter.closeLbug();
    await tmp?.cleanup();
    tmp = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const setupMocks = () => {
    vi.spyOn(runtimeSupport, 'getLocalEmbeddingRuntimeBlocker').mockReturnValue(null);
    vi.spyOn(sidecar, 'ensureEmbeddingSidecar').mockResolvedValue({ device: 'cpu' });
    vi.spyOn(sidecar, 'reapEmbeddingSidecarAndWait').mockResolvedValue(undefined);
    return vi.spyOn(sidecar, 'sidecarEmbedBatch').mockImplementation(async (texts) =>
      texts.map((text) => {
        let h = 0;
        for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
        const vector = new Float32Array(EMBEDDING_DIMS);
        vector[0] = h % 997;
        vector[1] = text.length;
        return vector;
      }),
    );
  };

  const setupRepo = async (name: string) => {
    tmp = await createTempDir(name);
    const repo = path.join(tmp.dbPath, 'repo');
    await fs.mkdir(repo);
    vi.stubEnv('GITNEXUS_HOME', path.join(tmp.dbPath, 'home'));
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'never');
    vi.stubEnv('GITNEXUS_EMBEDDING_URL', '');
    vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', '');
    vi.stubEnv('GITNEXUS_EMBEDDING_MODEL_ID', '');
    vi.stubEnv('GITNEXUS_EMBEDDING_DIMS', String(EMBEDDING_DIMS));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    return { repo, git };
  };

  const commitAll = (git: (...args: string[]) => Buffer, message: string) => {
    git('add', '-A');
    git('-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-qm', message);
  };

  const startEmbeddingServer = async (dimensions: number, submitted: string[]) => {
    server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const { input } = JSON.parse(body) as { input: string[] };
      submitted.push(...input);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          data: input.map((text, index) => {
            let h = 0;
            for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
            const embedding = new Array<number>(dimensions).fill(0);
            embedding[0] = (h % 997) / 997;
            embedding[1] = (text.length % 89) / 89;
            return { index, embedding };
          }),
        }),
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    return `http://127.0.0.1:${address.port}/v1`;
  };

  const readGraphRows = async (repo: string, branch?: string) => {
    await adapter.initLbug(getStoragePaths(repo, branch).lbugPath, { skipFts: true });
    try {
      return await adapter.executeQuery(
        'MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId, e.contentHash AS hash ORDER BY nodeId',
      );
    } finally {
      await adapter.closeLbug();
    }
  };

  const readArtifactRows = async (metaDir: string) => {
    const meta = await loadMeta(metaDir);
    const artifactIdentity =
      meta?.vectorGeneration?.artifactIdentity ?? meta?.vectorGeneration?.identity;
    if (!artifactIdentity) throw new Error('No published vector generation');
    const db = new lbug.Database(
      path.join(metaDir, 'embeddings', artifactIdentity, 'vectors'),
      256 * 1024 * 1024,
      true,
      true,
    );
    const conn = new lbug.Connection(db);
    try {
      const result = await conn.query(
        'MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId, e.contentHash AS hash ORDER BY nodeId',
      );
      if (Array.isArray(result)) throw new Error('Expected one result');
      try {
        return (await result.getAll()) as Array<{ nodeId: string; hash: string }>;
      } finally {
        await result.close();
      }
    } finally {
      await conn.close();
      await db.close();
    }
  };

  const inlineOptions = {
    force: true,
    embeddings: true,
    skipFts: true,
    skipAgentsMd: true,
    skipSkills: true,
  };

  const CLASS_SOURCE = [
    'export class Widget {',
    "  render() { return 'widget-render-marker'; }",
    "  update() { return 'widget-update-marker'; }",
    '}',
    '',
  ].join('\n');
  const LONG_SOURCE = `export function longFn() { const s = "${'x'.repeat(1400)}"; return s.length; }\n`;

  it('reuses sibling rows through the staged publication job (graphPublication: auto)', async () => {
    const { repo, git } = await setupRepo('gitnexus-test-cross-branch-auto-');
    const submitted: string[] = [];
    const url = await startEmbeddingServer(4, submitted);
    vi.stubEnv('GITNEXUS_EMBEDDING_URL', url);
    vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', 'auto-fixture');
    vi.stubEnv('GITNEXUS_EMBEDDING_DIMS', '4');
    vi.stubEnv('GITNEXUS_EMBEDDING_MAX_ATTEMPTS', '1');
    await fs.writeFile(
      path.join(repo, 'main.ts'),
      "export function main() { return 'main-v1'; }\n",
    );
    await fs.writeFile(
      path.join(repo, 'util.ts'),
      "export function util() { return 'util-marker'; }\n",
    );
    await fs.writeFile(path.join(repo, 'klass.ts'), CLASS_SOURCE);
    await fs.writeFile(path.join(repo, 'long.ts'), LONG_SOURCE);
    commitAll(git, 'fixture');

    const resources = resolveAnalysisResourceBudget({
      effectiveMemoryBytes: 4 * 1024 ** 3,
      availableCpus: 2,
      totalMb: 2048,
      workers: 1,
      graphPoolBytes: 256 * 1024 ** 2,
      modelMemoryMb: 0,
    });
    // The exact option shape every shipped entry point produces: 'auto'
    // publication plus an admitted resource budget.
    const options = {
      graphPublication: 'auto' as const,
      resources,
      embeddings: true,
      embeddingsNodeLimit: 0,
      skipFts: true,
      skipAgentsMd: true,
      skipSkills: true,
    };

    await runFullAnalysis(repo, options, { onProgress: () => {} });
    expect(submitted.length).toBeGreaterThan(0);
    const flatMetaDir = path.dirname(getStoragePaths(repo).metaPath);
    const flatArtifact = await readArtifactRows(flatMetaDir);
    expect(flatArtifact.length).toBeGreaterThan(0);
    // The fixture really exercises hydrated rows: the Class node's stored
    // hash is the full `hash:inputsDigest` form.
    const flatByNode = new Map(flatArtifact.map((row) => [row.nodeId, row.hash]));
    const klassNodeId = [...flatByNode.keys()].find((id) => id.endsWith(':Widget'))!;
    expect(flatByNode.get(klassNodeId)).toContain(':');

    git('checkout', '-qb', 'feature');
    await fs.writeFile(
      path.join(repo, 'main.ts'),
      "export function main() { return 'main-v2'; }\n",
    );
    commitAll(git, 'feature changes');

    submitted.length = 0;
    const logs: string[] = [];
    await runFullAnalysis(
      repo,
      { ...options, branch: 'feature' },
      { onProgress: () => {}, onLog: (message) => logs.push(message) },
    );

    // Only the changed file's texts reached the provider; everything else
    // was served by the sibling (flat) slot's sealed artifact.
    expect(submitted.length).toBeGreaterThan(0);
    expect(submitted.every((text) => text.includes('main-v2'))).toBe(true);
    expect(
      logs.some((line) =>
        /^Reused [1-9]\d* node embeddings \(\d+ chunks\) from sibling branch indexes; embedded \d+ nodes fresh\./.test(
          line,
        ),
      ),
    ).toBe(true);

    // The feature slot's published artifact holds every node, and the
    // reused rows carry the sibling's hashes verbatim.
    const featureMetaDir = path.dirname(getStoragePaths(repo, 'feature').metaPath);
    const featureArtifact = await readArtifactRows(featureMetaDir);
    const featureByNode = new Map(featureArtifact.map((row) => [row.nodeId, row.hash]));
    expect(featureByNode.size).toBe(flatByNode.size);
    for (const [nodeId, hash] of flatByNode) {
      if (nodeId.endsWith(':main')) continue;
      expect(featureByNode.get(nodeId)).toBe(hash);
    }
  }, 300_000);

  it('re-embeds retained rows on a same-width model switch instead of certifying them', async () => {
    const { repo, git } = await setupRepo('gitnexus-test-cross-branch-stamp-');
    const submitted: string[] = [];
    const url = await startEmbeddingServer(EMBEDDING_DIMS, submitted);
    vi.stubEnv('GITNEXUS_EMBEDDING_URL', url);
    vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', 'model-a');
    vi.stubEnv('GITNEXUS_EMBEDDING_DIMS', String(EMBEDDING_DIMS));
    vi.stubEnv('GITNEXUS_EMBEDDING_MAX_ATTEMPTS', '1');
    await fs.writeFile(path.join(repo, 'main.ts'), 'export function main() { return 1; }\n');
    await fs.writeFile(path.join(repo, 'util.ts'), 'export function util() { return 2; }\n');
    commitAll(git, 'fixture');

    await runFullAnalysis(repo, inlineOptions, { onProgress: () => {} });
    expect(submitted).toHaveLength(2);
    const metaDir = path.dirname(getStoragePaths(repo).metaPath);
    const stampA = (await loadMeta(metaDir))?.embeddingIdentity?.vectorIdentity;
    expect(stampA).toBeTypeOf('string');

    // Same endpoint, same width, different model: the content hashes
    // cannot see the switch (HTTP mode), so without the stamp rule the
    // retained model-a rows would be re-stamped as model-b.
    vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', 'model-b');
    submitted.length = 0;
    const switchLogs: string[] = [];
    await runFullAnalysis(repo, inlineOptions, {
      onProgress: () => {},
      onLog: (message) => switchLogs.push(message),
    });
    expect(submitted).toHaveLength(2);
    expect(switchLogs.some((line) => line.includes('vector identity changed'))).toBe(true);
    const stampB = (await loadMeta(metaDir))?.embeddingIdentity?.vectorIdentity;
    expect(stampB).toBeTypeOf('string');
    expect(stampB).not.toBe(stampA);

    // The re-stamped rows are genuinely model-b now, so a sibling branch
    // may copy them under the model-b identity.
    git('checkout', '-qb', 'feature');
    await fs.writeFile(path.join(repo, 'util.ts'), 'export function util() { return 3; }\n');
    commitAll(git, 'feature changes');
    submitted.length = 0;
    const logs: string[] = [];
    await runFullAnalysis(
      repo,
      { ...inlineOptions, branch: 'feature' },
      { onProgress: () => {}, onLog: (message) => logs.push(message) },
    );
    expect(submitted).toHaveLength(1);
    expect(logs).toContain(
      'Reused 1 node embeddings (1 chunks) from sibling branch indexes; embedded 1 nodes fresh.',
    );
  }, 300_000);

  it('copies hydrated Class and long-function rows from a sibling (full-form hashes)', async () => {
    const embed = setupMocks();
    const { repo, git } = await setupRepo('gitnexus-test-cross-branch-hydrated-');
    await fs.writeFile(path.join(repo, 'main.ts'), 'export function main() { return 1; }\n');
    await fs.writeFile(path.join(repo, 'klass.ts'), CLASS_SOURCE);
    await fs.writeFile(path.join(repo, 'long.ts'), LONG_SOURCE);
    commitAll(git, 'fixture');

    await runFullAnalysis(repo, inlineOptions, { onProgress: () => {} });
    const flatRows = await readGraphRows(repo);
    const flatByNode = new Map(flatRows.map((row) => [row.nodeId, row.hash]));
    const klassNodeId = [...flatByNode.keys()].find((id) => id.endsWith(':Widget'))!;
    // Guard: the fixture really produced a full-form stored hash, or this
    // test would silently pass through the bare-hash path.
    expect(flatByNode.get(klassNodeId)).toContain(':');

    git('checkout', '-qb', 'feature');
    await fs.writeFile(path.join(repo, 'main.ts'), 'export function main() { return 2; }\n');
    commitAll(git, 'feature changes');

    embed.mockClear();
    const logs: string[] = [];
    await runFullAnalysis(
      repo,
      { ...inlineOptions, branch: 'feature' },
      { onProgress: () => {}, onLog: (message) => logs.push(message) },
    );
    const embeddedTexts = embed.mock.calls.flatMap(([texts]) => texts);
    expect(embeddedTexts).toHaveLength(1);
    expect(embeddedTexts[0]).toContain('return 2');
    expect(logs.some((line) => /^Reused [2-9]\d* node embeddings/.test(line))).toBe(true);

    const featureRows = await readGraphRows(repo, 'feature');
    const featureByNode = new Map(featureRows.map((row) => [row.nodeId, row.hash]));
    for (const [nodeId, hash] of flatByNode) {
      if (nodeId.endsWith(':main')) continue;
      expect(featureByNode.get(nodeId)).toBe(hash);
    }
  }, 300_000);

  it('suppresses sibling reuse when embeddings are dropped', async () => {
    const embed = setupMocks();
    const { repo, git } = await setupRepo('gitnexus-test-cross-branch-drop-');
    await fs.writeFile(path.join(repo, 'main.ts'), 'export function main() { return 1; }\n');
    await fs.writeFile(path.join(repo, 'util.ts'), 'export function util() { return 2; }\n');
    commitAll(git, 'fixture');
    await runFullAnalysis(repo, inlineOptions, { onProgress: () => {} });

    git('checkout', '-qb', 'feature');
    embed.mockClear();
    await runFullAnalysis(repo, { ...inlineOptions, branch: 'feature' }, { onProgress: () => {} });
    expect(embed).not.toHaveBeenCalled();

    // --drop-embeddings regenerates: sibling rows must NOT be re-imported.
    embed.mockClear();
    const logs: string[] = [];
    await runFullAnalysis(
      repo,
      { ...inlineOptions, branch: 'feature', dropEmbeddings: true },
      { onProgress: () => {}, onLog: (message) => logs.push(message) },
    );
    expect(embed.mock.calls.flatMap(([texts]) => texts)).toHaveLength(2);
    expect(logs.some((line) => line.startsWith('Reused '))).toBe(false);
  }, 300_000);

  it('never copies from an interrupted sibling’s half-persisted nodes', async () => {
    const embed = setupMocks();
    const { repo, git } = await setupRepo('gitnexus-test-cross-branch-interrupted-');
    await fs.writeFile(path.join(repo, 'main.ts'), 'export function main() { return 1; }\n');
    await fs.writeFile(path.join(repo, 'util.ts'), 'export function util() { return 2; }\n');
    commitAll(git, 'fixture');
    await runFullAnalysis(repo, inlineOptions, { onProgress: () => {} });

    const flatMetaDir = path.dirname(getStoragePaths(repo).metaPath);
    const flatRows = await readGraphRows(repo);
    const utilNodeId = flatRows.map((row) => row.nodeId).find((id) => id.endsWith(':util'))!;

    // Mark the flat slot as interrupted mid-embedding, with util's node
    // among the half-persisted pending set.
    const flatMeta = await loadMeta(flatMetaDir);
    await saveMeta(flatMetaDir, {
      ...flatMeta!,
      embeddingCheckpoint: {
        kind: 'interrupted',
        pendingNodeIds: [utilNodeId],
      } as NonNullable<typeof flatMeta>['embeddingCheckpoint'],
    });

    git('checkout', '-qb', 'feature');
    embed.mockClear();
    const logs: string[] = [];
    await runFullAnalysis(
      repo,
      { ...inlineOptions, branch: 'feature' },
      { onProgress: () => {}, onLog: (message) => logs.push(message) },
    );
    // main is still copied; util — the half-persisted node — is embedded.
    const embeddedTexts = embed.mock.calls.flatMap(([texts]) => texts);
    expect(embeddedTexts).toHaveLength(1);
    expect(embeddedTexts[0]).toContain('util');
    expect(logs).toContain(
      'Reused 1 node embeddings (1 chunks) from sibling branch indexes; embedded 1 nodes fresh.',
    );

    // A sibling mid-write is not read at all. Remove the branch slots so
    // the tainted flat slot is the only sibling left to consider.
    await saveMeta(flatMetaDir, {
      ...(await loadMeta(flatMetaDir))!,
      embeddingCheckpoint: undefined,
      incrementalInProgress: { startedAt: Date.now(), toWriteCount: 0 },
    });
    await fs.rm(path.join(getStoragePaths(repo).storagePath, 'branches'), {
      recursive: true,
      force: true,
    });
    git('checkout', '-qb', 'feature2');
    embed.mockClear();
    const logs2: string[] = [];
    await runFullAnalysis(
      repo,
      { ...inlineOptions, branch: 'feature2' },
      { onProgress: () => {}, onLog: (message) => logs2.push(message) },
    );
    expect(embed.mock.calls.flatMap(([texts]) => texts)).toHaveLength(2);
    expect(logs2.some((line) => line.startsWith('Reused '))).toBe(false);
  }, 300_000);
});
