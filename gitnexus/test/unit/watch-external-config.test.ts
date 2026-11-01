/**
 * Watch mode and the external `GITNEXUS_RC` file: edits, atomic replacement
 * and removal reload configuration before the next refresh, and an invalid or
 * missing explicit file blocks analysis instead of reusing stale settings.
 *
 * Drives the real filesystem watcher through `watchCommandWithRunnerIdentity`;
 * only the analysis itself is stubbed, so the assertion is on the options each
 * refresh would analyze with.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  calls: [] as unknown[],
  afterConfigLoad: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('../../src/cli/analyze-config.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/cli/analyze-config.js')>();
  return {
    ...actual,
    loadAnalyzeConfigStrict: async (repo: string) => {
      const options = await actual.loadAnalyzeConfigStrict(repo);
      const afterLoad = H.afterConfigLoad;
      H.afterConfigLoad = undefined;
      await afterLoad?.();
      return options;
    },
  };
});

vi.mock('../../src/core/run-analyze.js', () => ({
  analyzeFailureMayHaveMutatedLiveIndex: () => false,
  runFullAnalysis: vi.fn(async (_repo: string, options: { routeHookConfig?: unknown }) => {
    H.calls.push(options.routeHookConfig);
    return { alreadyUpToDate: true };
  }),
}));
vi.mock('../../src/cli/analyze.js', () => ({ ensureHeap: async () => false }));
vi.mock('../../src/storage/storage-resolver.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/storage/storage-resolver.js')>()),
  requireStoragePath: async () => undefined,
}));

import { watchCommandWithRunnerIdentity } from '../../src/cli/analyze-watch.js';
import type { AnalyzerRunnerIdentity } from '../../src/storage/repo-manager.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  H.calls.length = 0;
  H.afterConfigLoad = undefined;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const aliases = (importPath: string) => ({
  goRouterAliases: [{ importPath, type: 'Engine', framework: 'gin' }],
});

describe('watch mode with an external GITNEXUS_RC file', () => {
  it('rereads configuration changed between validation and watcher startup', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-watch-rc-start-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-watch-rc-'));
    dirs.push(repo, outside);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const rc = path.join(outside, 'service.json');
    await fs.writeFile(rc, JSON.stringify(aliases('example.com/old')));
    vi.stubEnv('GITNEXUS_RC', rc);
    H.afterConfigLoad = () => fs.writeFile(rc, JSON.stringify(aliases('example.com/new')));

    const command = watchCommandWithRunnerIdentity({} as AnalyzerRunnerIdentity, repo, {
      debounce: '25',
    });
    try {
      await waitFor(() => H.calls.length > 0);
      expect(H.calls[0]).toEqual({
        routeFrameworkAliases: aliases('example.com/new').goRouterAliases,
        routeHandlerWrappers: undefined,
      });
    } finally {
      process.emit('SIGINT');
      await command;
    }
  });

  it('reloads symlink targets after edits, replacement, removal, restoration and retargeting', async ({
    skip,
  }) => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-watch-rc-link-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-watch-rc-'));
    dirs.push(repo, outside);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await fs.mkdir(path.join(outside, 'targets'));
    const target = path.join(outside, 'targets', 'service.json');
    const rc = path.join(outside, 'config.json');
    await fs.writeFile(target, JSON.stringify(aliases('example.com/one')));
    try {
      await fs.symlink(target, rc, 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        skip('Creating file symlinks requires Windows Developer Mode or elevation.');
      }
      throw error;
    }
    vi.stubEnv('GITNEXUS_RC', rc);
    const command = watchCommandWithRunnerIdentity({} as AnalyzerRunnerIdentity, repo, {
      debounce: '25',
    });
    const latestConfig = () => H.calls.at(-1);
    const config = (name: string) => ({
      routeFrameworkAliases: aliases(`example.com/${name}`).goRouterAliases,
      routeHandlerWrappers: undefined,
    });
    try {
      await waitFor(() => H.calls.length > 0);
      expect(latestConfig()).toEqual(config('one'));
      await fs.writeFile(target, JSON.stringify(aliases('example.com/two')));
      await vi.waitFor(() => expect(latestConfig()).toEqual(config('two')), { timeout: 8_000 });
      await fs.writeFile(`${target}.tmp`, JSON.stringify(aliases('example.com/three')));
      await fs.rename(`${target}.tmp`, target);
      await vi.waitFor(() => expect(latestConfig()).toEqual(config('three')), { timeout: 8_000 });

      await fs.rm(target);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const settled = H.calls.length;
      await fs.writeFile(path.join(repo, 'main.go'), 'package main\n');
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(H.calls).toHaveLength(settled);
      await fs.writeFile(target, JSON.stringify(aliases('example.com/four')));
      await vi.waitFor(() => expect(latestConfig()).toEqual(config('four')), { timeout: 8_000 });

      const nextTarget = path.join(outside, 'targets', 'next.json');
      await fs.writeFile(nextTarget, JSON.stringify(aliases('example.com/five')));
      await fs.rm(rc);
      await fs.symlink(nextTarget, rc, 'file');
      await vi.waitFor(() => expect(latestConfig()).toEqual(config('five')), { timeout: 8_000 });
      await fs.writeFile(nextTarget, JSON.stringify(aliases('example.com/six')));
      await vi.waitFor(() => expect(latestConfig()).toEqual(config('six')), { timeout: 8_000 });
    } finally {
      process.emit('SIGINT');
      await command;
    }
  }, 45_000);

  it('reloads edits and replacements, and blocks refreshes while the file is invalid or gone', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-watch-rc-repo-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-watch-rc-'));
    dirs.push(repo, outside);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const rc = path.join(outside, 'service.json');
    await fs.writeFile(rc, JSON.stringify(aliases('example.com/one')), 'utf8');
    vi.stubEnv('GITNEXUS_RC', rc);

    const command = watchCommandWithRunnerIdentity({} as AnalyzerRunnerIdentity, repo, {
      debounce: '25',
    });
    const importPaths = () =>
      H.calls.map(
        (config) =>
          (config as { routeFrameworkAliases?: { importPath: string }[] } | undefined)
            ?.routeFrameworkAliases?.[0]?.importPath,
      );
    try {
      await waitFor(() => H.calls.length === 1);
      expect(importPaths()).toEqual(['example.com/one']);

      await fs.writeFile(rc, JSON.stringify(aliases('example.com/two')), 'utf8');
      await waitFor(() => importPaths().includes('example.com/two'));

      // Editor-style save: a sibling renamed over the original replaces the inode.
      const staged = `${rc}.tmp`;
      await fs.writeFile(staged, JSON.stringify(aliases('example.com/three')), 'utf8');
      await fs.rename(staged, rc);
      await waitFor(() => importPaths().includes('example.com/three'));

      const settled = H.calls.length;
      await fs.writeFile(rc, JSON.stringify({ goRouterAliases: 'gin' }), 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 400));
      // A source change while the config is invalid must not analyze with stale settings.
      await fs.writeFile(path.join(repo, 'main.go'), 'package main\n', 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(H.calls).toHaveLength(settled);

      await fs.rm(rc);
      await fs.writeFile(path.join(repo, 'main.go'), 'package main\n\nfunc main() {}\n', 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(H.calls).toHaveLength(settled);

      await fs.writeFile(rc, JSON.stringify(aliases('example.com/four')), 'utf8');
      await waitFor(() => importPaths().includes('example.com/four'));
    } finally {
      process.emit('SIGINT');
      await command;
    }
  }, 30_000);
});
