import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { ensurePrivateSharedGraph } from '../../src/core/shared-store-analyze.js';
import { EmbeddingGraphSource } from '../../src/core/lbug/embedding-source.js';
import * as nativeResources from '../../src/core/lbug/lbug-adapter.js';
import * as modelResources from '../../src/core/embeddings/embedding-sidecar-client.js';
import { resolveAnalysisResourceBudget } from '../../src/core/analysis-resource-budget.js';
import { acquireIndexLock } from '../../src/storage/index-lock.js';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import { resolveSharedStore } from '../../src/storage/shared-store.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';

let root: string;
let repo: string;
const generation = `lbug.generation.${'a'.repeat(32)}`;
const options = { skipFts: true, skipAgentsMd: true, skipSkills: true };
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
const metadata = (extra: Partial<RepoMeta> = {}): RepoMeta => ({
  repoPath: repo,
  lastCommit: git('rev-parse', 'HEAD'),
  indexedAt: '2026-11-04T00:00:00Z',
  branch: 'main',
  ...extra,
});

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-generation-routing-')));
  repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
  vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
  git('init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'a.ts'), 'export function alpha() { return 1; }\n');
  git('add', 'a.ts');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it.each([false, true])(
  'retains the owned graph filename on a tiny edit (shared=%s)',
  async (shared) => {
    if (shared) {
      git('worktree', 'add', '-q', '-b', 'sibling', path.join(root, 'sibling'));
      delete process.env.GITNEXUS_SHARED_STORE;
    }
    const first = await runFullAnalysis(repo, options, { onProgress: () => {} });
    const slot = first.storagePath;
    if (shared) expect(await ensurePrivateSharedGraph(slot, () => {})).toBe(true);
    const prior = await loadMeta(slot);
    if (!prior) throw new Error('Fixture index is missing');
    const owned = path.join(slot, generation);
    await fs.rename(path.join(slot, 'lbug'), owned);
    await saveMeta(slot, { ...prior, graphPath: generation });
    const inode = (await fs.stat(owned)).ino;
    await fs.writeFile(path.join(repo, 'a.ts'), 'export function alpha() { return 2; }\n');
    const copy = vi.spyOn(fs, 'copyFile');
    const result = await runFullAnalysis(repo, options, { onProgress: () => {} });
    expect(result.alreadyUpToDate).not.toBe(true);
    expect((await loadMeta(slot))?.graphPath).toBe(generation);
    expect(getStoragePaths(repo, undefined, slot).lbugPath).toBe(owned);
    expect((await fs.stat(owned)).ino).toBe(inode);
    await expect(fs.stat(path.join(slot, 'lbug'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      copy.mock.calls.filter((args) =>
        args.some((file) => path.basename(String(file)).startsWith('lbug')),
      ),
    ).toHaveLength(0);
    const source = await EmbeddingGraphSource.open(owned, 256 * 1024 * 1024, 1);
    try {
      const ids: string[] = [];
      for await (const key of source.scan('Function')) ids.push(key.id);
      expect(ids).toHaveLength(1);
      expect((await source.fetch('Function', ids))[0].content).toContain('return 2');
    } finally {
      await source.close();
    }
  },
  120_000,
);

it.each(['pending', 'prepared', 'branch-pending'] as const)(
  'takes the original slot lock before shared adoption with %s work',
  async (kind) => {
    const local = path.join(repo, '.gitnexus');
    await saveMeta(local, metadata());
    let lockedSlot = local;
    if (kind === 'prepared') {
      // Even unreadable publication evidence must not be stranded by routing.
      await fs.writeFile(path.join(local, 'analysis-publication.json'), '{');
    } else {
      if (kind === 'branch-pending') {
        git('checkout', '-q', '-b', 'feature');
        lockedSlot = path.dirname(getStoragePaths(repo, 'feature', local).metaPath);
      }
      await saveMeta(
        lockedSlot,
        metadata({
          branch: kind === 'branch-pending' ? 'feature' : 'main',
          embeddingJob: { version: 1, identity: 'b'.repeat(64), graphGeneration: 'a'.repeat(32) },
        }),
      );
    }
    git('worktree', 'add', '-q', '-b', 'sibling', path.join(root, 'sibling'));
    delete process.env.GITNEXUS_SHARED_STORE;
    const shared = resolveSharedStore(repo);
    if (!shared) throw new Error('Fixture store is missing');
    const lock = await acquireIndexLock(lockedSlot, { sweep: false });
    const waitedForOwner = new Error('Observed the original owner lock');
    try {
      await expect(
        runFullAnalysis(
          repo,
          {
            ...options,
            ...(kind === 'branch-pending' ? { branch: 'feature' } : {}),
          },
          {
            onProgress: (phase) => {
              if (phase === 'lock') throw waitedForOwner;
              throw new Error(`Analysis bypassed its retained work: ${phase}`);
            },
          },
        ),
      ).rejects.toBe(waitedForOwner);
      expect(await loadMeta(shared.checkoutSlot)).toBeNull();
      if (kind !== 'prepared') expect((await loadMeta(lockedSlot))?.embeddingJob).toBeDefined();
    } finally {
      lock.release();
    }
  },
  30_000,
);

it('leaves model resources alone on a no-op, then drains them before actual graph work', async () => {
  await runFullAnalysis(repo, options, { onProgress: () => {} });
  const events: string[] = [];
  const native = vi
    .spyOn(nativeResources, 'drainAnalysisNativeResources')
    .mockImplementation(async () => {
      events.push('native');
    });
  const model = vi
    .spyOn(modelResources, 'drainEmbeddingSidecarForAnalysis')
    .mockImplementation(async () => {
      events.push('model');
    });
  const resources = resolveAnalysisResourceBudget({
    effectiveMemoryBytes: 4 * 1024 ** 3,
    availableCpus: 2,
    totalMb: 2048,
    workers: 1,
    graphPoolBytes: 256 * 1024 ** 2,
    modelMemoryMb: 0,
  });
  const noop = await runFullAnalysis(repo, { ...options, resources }, { onProgress: () => {} });
  expect(noop.alreadyUpToDate).toBe(true);
  expect(native).not.toHaveBeenCalled();
  expect(model).not.toHaveBeenCalled();
  await fs.writeFile(path.join(repo, 'a.ts'), 'export function alpha() { return 3; }\n');
  await runFullAnalysis(
    repo,
    { ...options, resources },
    {
      onProgress: (phase) => {
        if (phase === 'extracting') {
          expect(events.slice(0, 2)).toEqual(['model', 'native']);
          events.push('parse');
        }
      },
    },
  );
  expect(events).toContain('parse');
}, 120_000);
