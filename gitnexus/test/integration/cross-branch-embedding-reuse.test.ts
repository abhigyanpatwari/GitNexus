import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';
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
