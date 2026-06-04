import { describe, expect, it, vi } from 'vitest';
import {
  ReindexWatcherScheduler,
  isIgnoredReindexWatcherPath,
  readReindexWatcherConfigFromEnv,
  type ReindexWatcherRequest,
} from '../../src/server/reindex-watcher.js';

const targets = [
  {
    repoKey: 'deepwiki-open',
    repoName: 'deepwiki-open',
    repoPath: '/workspace/deepwiki-open',
  },
];

describe('reindex watcher scheduler', () => {
  it('starts disabled and dry-run by default from env config', () => {
    expect(readReindexWatcherConfigFromEnv({})).toMatchObject({
      enabled: false,
      dryRun: true,
      debounceMs: 2000,
      sweepMs: 60000,
      embeddings: true,
    });
  });

  it('parses explicit watcher env overrides conservatively', () => {
    expect(
      readReindexWatcherConfigFromEnv({
        GITNEXUS_REINDEX_WATCHER: 'true',
        GITNEXUS_REINDEX_WATCHER_DRY_RUN: 'false',
        GITNEXUS_REINDEX_WATCHER_DEBOUNCE_MS: '1500',
        GITNEXUS_REINDEX_WATCHER_SWEEP_MS: '30000',
        GITNEXUS_REINDEX_WATCHER_EMBEDDINGS: '0',
      }),
    ).toEqual({
      enabled: true,
      dryRun: false,
      debounceMs: 1500,
      sweepMs: 30000,
      embeddings: false,
    });
  });

  it('ignores index, dependency, build, and transient paths', () => {
    expect(isIgnoredReindexWatcherPath('/workspace/repo/.gitnexus/meta.json')).toBe(true);
    expect(isIgnoredReindexWatcherPath('/workspace/repo/.git/index')).toBe(true);
    expect(isIgnoredReindexWatcherPath('/workspace/repo/node_modules/pkg/index.js')).toBe(true);
    expect(isIgnoredReindexWatcherPath('/workspace/repo/dist/app.js')).toBe(true);
    expect(isIgnoredReindexWatcherPath('/workspace/repo/src/file.ts.tmp')).toBe(true);
    expect(isIgnoredReindexWatcherPath('/workspace/repo/src/file.ts')).toBe(false);
  });

  it('dry-run reports the intended constrained reindex request without calling the API boundary', async () => {
    const requested = vi.fn();
    const dryRuns: ReindexWatcherRequest[] = [];
    const scheduler = new ReindexWatcherScheduler({
      targets,
      debounceMs: 10,
      requestReindex: requested,
      onDryRun: (request) => dryRuns.push(request),
    });

    expect(scheduler.recordChange('deepwiki-open', 'src/index.ts')).toBe(true);
    const flushed = await scheduler.flushRepo('deepwiki-open');

    expect(requested).not.toHaveBeenCalled();
    expect(dryRuns).toHaveLength(1);
    expect(flushed).toMatchObject({
      repoKey: 'deepwiki-open',
      repoName: 'deepwiki-open',
      dryRun: true,
      reason: 'watch',
      force: true,
      embeddings: true,
    });
    expect(flushed?.changedPaths).toEqual(['src/index.ts']);
  });

  it('debounces rapid changes into one scheduled reindex request', async () => {
    let now = 1_000;
    const requests: ReindexWatcherRequest[] = [];
    const timers: Array<() => void> = [];
    const scheduler = new ReindexWatcherScheduler({
      targets,
      dryRun: false,
      debounceMs: 100,
      now: () => now,
      setTimeout: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimeout: vi.fn(),
      requestReindex: (request) => requests.push(request),
    });

    scheduler.recordChange('deepwiki-open', 'src/a.ts');
    now += 20;
    scheduler.recordChange('deepwiki-open', 'src/b.ts');
    expect(scheduler.pendingRepoKeys()).toEqual(['deepwiki-open']);

    await timers.at(-1)?.();

    expect(requests).toHaveLength(1);
    expect(requests[0].changedPaths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(requests[0].dryRun).toBe(false);
  });

  it('sweep/manual recovery can schedule dirty repos without relying on native events', async () => {
    const requests: ReindexWatcherRequest[] = [];
    const scheduler = new ReindexWatcherScheduler({
      targets,
      dryRun: false,
      requestReindex: (request) => requests.push(request),
    });

    expect(scheduler.markAllDirty('sweep')).toBe(1);
    await scheduler.flushRepo('deepwiki-open');

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      repoKey: 'deepwiki-open',
      reason: 'sweep',
      force: true,
    });
  });

  it('does not schedule unknown repos or ignored changes', () => {
    const requested = vi.fn();
    const scheduler = new ReindexWatcherScheduler({
      targets,
      requestReindex: requested,
    });

    expect(scheduler.recordChange('unknown', 'src/index.ts')).toBe(false);
    expect(scheduler.recordChange('deepwiki-open', '.gitnexus/meta.json')).toBe(false);
    expect(scheduler.pendingRepoKeys()).toEqual([]);
    expect(requested).not.toHaveBeenCalled();
  });
});
