import { createTestEnvironment } from '../support/environment.js';
import { registerCases } from '../support/cases.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, afterEach, beforeEach, it, mock } from 'node:test';
import { expect } from 'expect';

import { ensurePrivateSharedGraph } from '../../../../dist/core/shared-store-analyze.js';
import { EmbeddingGraphSource } from '../../../../dist/core/lbug/embedding-source.js';
import * as nativeResources from '../../../../dist/core/lbug/lbug-adapter.js';
import * as modelResources from '../../../../dist/core/embeddings/embedding-sidecar-client.js';
import { resolveAnalysisResourceBudget } from '../../../../dist/core/analysis-resource-budget.js';
import { acquireIndexLock } from '../../../../dist/storage/index-lock.js';
import { getStoragePaths, loadMeta, saveMeta } from '../../../../dist/storage/repo-manager.js';
import { resolveSharedStore } from '../../../../dist/storage/shared-store.js';
import type { RepoMeta } from '../../../../src/storage/repo-meta.js';

let onDrain: ((resource: string) => void) | undefined;
const nativeMock = mock.module(
  new URL('../../../../dist/core/lbug/lbug-adapter.js', import.meta.url).href,
  {
    namedExports: {
      ...nativeResources,
      drainAnalysisNativeResources: async () =>
        onDrain ? onDrain('native') : nativeResources.drainAnalysisNativeResources(),
    },
  },
);
const modelMock = mock.module(
  new URL('../../../../dist/core/embeddings/embedding-sidecar-client.js', import.meta.url).href,
  {
    namedExports: {
      ...modelResources,
      drainEmbeddingSidecarForAnalysis: async () =>
        onDrain ? onDrain('model') : modelResources.drainEmbeddingSidecarForAnalysis(),
    },
  },
);
after(() => {
  modelMock.restore();
  nativeMock.restore();
});
const { runFullAnalysis } = await import('../../../../dist/core/run-analyze.js');
const environment = createTestEnvironment();
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
  environment.set('GITNEXUS_HOME', path.join(root, 'home'));
  environment.set('GITNEXUS_SHARED_STORE', 'off');
  git('init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'a.ts'), 'export function alpha() { return 1; }\n');
  git('add', 'a.ts');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture');
});
afterEach(async () => {
  environment.restore();
  onDrain = undefined;
  await fs.rm(root, { recursive: true, force: true });
});

for (const shared of [false, true])
  it(
    `retains the owned graph filename on a tiny edit (shared=${shared})`,
    { timeout: 120_000 },
    async (t) => {
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
      const copy = t.mock.method(fs, 'copyFile');
      const result = await runFullAnalysis(repo, options, { onProgress: () => {} });
      expect(result.alreadyUpToDate).not.toBe(true);
      expect((await loadMeta(slot))?.graphPath).toBe(generation);
      expect(getStoragePaths(repo, undefined, slot).lbugPath).toBe(owned);
      expect((await fs.stat(owned)).ino).toBe(inode);
      await expect(fs.stat(path.join(slot, 'lbug'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        copy.mock.calls.filter(({ arguments: args }) =>
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
  );

registerCases(
  it,
  ['pending', 'prepared', 'branch-pending'] as const,
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

it(
  'leaves model resources alone on a no-op, then drains them before actual graph work',
  { timeout: 120_000 },
  async () => {
    await runFullAnalysis(repo, options, { onProgress: () => {} });
    const events: string[] = [];
    onDrain = (resource) => events.push(resource);
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
    expect(events).toEqual([]);
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
  },
);
