import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensurePrivateSharedGraph,
  publishSharedGraph,
} from '../../src/core/shared-store-analyze.js';
import { loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import { reclaimSharedStore } from '../../src/storage/shared-store-lifecycle.js';
import {
  resolveGraphPath,
  resolveGraphWritePath,
  sharedStoreLayout,
} from '../../src/storage/shared-store.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';

describe('shared-store logical generations', () => {
  let root: string;
  let repo: string;
  let head: string;
  let slot: string;
  let layout: ReturnType<typeof sharedStoreLayout>;
  const generation = `lbug.generation.${'a'.repeat(32)}`;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  const metadata = (extra: Partial<RepoMeta> = {}): RepoMeta => ({
    repoPath: repo,
    storagePath: slot,
    lastCommit: head,
    indexedAt: '2026-11-04T00:00:00Z',
    parseCacheIdentity: { base: 'fixture-parser' },
    ...extra,
  });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-shared-generations-')));
    vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
    repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'fixture');
    head = git('rev-parse', 'HEAD');
    layout = sharedStoreLayout('fixture-0123456789ab', repo);
    slot = layout.checkoutSlot;
    await fs.mkdir(slot, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([true, false])(
    'keeps an owned generation in place without copying or dropping its pointer (copy=%s)',
    async (copy) => {
      const file = path.join(slot, generation);
      await fs.writeFile(file, 'private graph');
      await saveMeta(slot, metadata({ graphPath: generation }));
      const before = await fs.stat(file);
      const copyFile = vi.spyOn(fs, 'copyFile');
      const log = vi.fn();
      expect(await ensurePrivateSharedGraph(slot, log, { copy })).toBe(true);
      expect(resolveGraphPath(slot)).toBe(file);
      expect((await fs.stat(file)).ino).toBe(before.ino);
      await expect(fs.stat(path.join(slot, 'lbug'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(copyFile).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    },
  );

  it('routes only immutable shared graphs to a new private write target', async () => {
    const commitGraph = path.join(layout.commitsDir, `${head}-deadbeef`, 'lbug');
    await saveMeta(slot, metadata({ graphPath: commitGraph }));
    expect(resolveGraphWritePath(slot)).toBe(path.join(slot, 'lbug'));
    await fs.writeFile(path.join(slot, generation), 'private graph');
    await saveMeta(slot, metadata({ graphPath: generation }));
    expect(resolveGraphWritePath(slot)).toBe(path.join(slot, generation));
    const branch = path.join(slot, 'branches', 'feature');
    await fs.mkdir(branch, { recursive: true });
    await fs.writeFile(path.join(branch, generation), 'branch graph');
    await saveMeta(branch, metadata({ graphPath: generation }));
    expect(resolveGraphWritePath(branch)).toBe(path.join(branch, generation));
  });

  it('publishes a completed private generation by moving its file, preserving the inode', async () => {
    const file = path.join(slot, generation);
    await fs.writeFile(file, 'completed graph');
    const before = await fs.stat(file);
    await saveMeta(slot, metadata({ graphPath: generation }));
    await publishSharedGraph(layout, repo, head, () => {});
    const published = resolveGraphPath(slot);
    expect(path.dirname(path.dirname(published))).toBe(layout.commitsDir);
    expect((await fs.stat(published)).ino).toBe(before.ino);
    expect(await fs.readFile(published, 'utf8')).toBe('completed graph');
  });

  it('keeps an unshareable private generation pointer intact', async () => {
    await fs.writeFile(path.join(slot, generation), 'dirty graph');
    await fs.writeFile(path.join(slot, 'lbug'), 'obsolete canonical graph');
    await fs.writeFile(path.join(repo, 'untracked.ts'), 'export const changed = true;');
    await saveMeta(slot, metadata({ graphPath: generation }));
    await publishSharedGraph(layout, repo, head, () => {});
    expect((await loadMeta(slot))?.graphPath).toBe(generation);
    expect(resolveGraphPath(slot)).toBe(path.join(slot, generation));
  });

  it.each(['prepared', 'pending', 'branch-prepared', 'branch-pending'])(
    'retains an orphan slot with %s analysis work',
    async (kind) => {
      const missingRepo = path.join(root, 'removed-checkout');
      await saveMeta(slot, metadata({ repoPath: missingRepo }));
      const work = kind.startsWith('branch-') ? path.join(slot, 'branches', 'feature') : slot;
      await fs.mkdir(work, { recursive: true });
      if (kind.endsWith('prepared')) {
        // Even an unreadable/incomplete publication receipt is retained evidence.
        await fs.writeFile(path.join(work, 'analysis-publication.json'), '{}');
      } else {
        await saveMeta(
          work,
          metadata({
            repoPath: missingRepo,
            embeddingJob: {
              version: 1,
              identity: 'b'.repeat(64),
              graphGeneration: 'a'.repeat(32),
            },
          }),
        );
      }
      await fs.writeFile(path.join(work, 'paid-work'), 'retained');
      const result = await reclaimSharedStore(layout.root, { gc: true });
      expect(result.droppedMembers).toEqual([]);
      expect(await fs.readFile(path.join(work, 'paid-work'), 'utf8')).toBe('retained');
      await fs.rm(path.join(work, 'analysis-publication.json'), { force: true });
      await saveMeta(work, metadata({ repoPath: missingRepo }));
      expect((await reclaimSharedStore(layout.root, { gc: true })).droppedMembers).toEqual([slot]);
      await expect(fs.stat(slot)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('counts retained branch references before collecting shared graphs', async () => {
    const graph = path.join(layout.commitsDir, `${head}-deadbeef`, 'lbug');
    await fs.mkdir(path.dirname(graph), { recursive: true });
    await fs.writeFile(graph, 'retained graph');
    await saveMeta(slot, metadata());
    const branch = path.join(slot, 'branches', 'feature');
    await fs.mkdir(branch, { recursive: true });
    await saveMeta(branch, metadata({ graphPath: graph }));
    expect((await reclaimSharedStore(layout.root)).removed).toEqual([]);
    expect(await fs.readFile(graph, 'utf8')).toBe('retained graph');
  });

  it('aborts collection when branch ownership cannot be inspected', async () => {
    await saveMeta(slot, metadata({ repoPath: path.join(root, 'removed-checkout') }));
    await fs.writeFile(path.join(slot, 'branches'), 'unverified branch state');
    await expect(reclaimSharedStore(layout.root, { gc: true })).rejects.toThrow(
      'unverified branches directory',
    );
    expect(await fs.readFile(path.join(slot, 'branches'), 'utf8')).toBe('unverified branch state');
  });
});
