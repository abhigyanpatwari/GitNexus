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

const H = vi.hoisted(() => ({ calls: [] as unknown[] }));

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
