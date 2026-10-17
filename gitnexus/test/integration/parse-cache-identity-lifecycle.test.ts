import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { setupMiniRepo } from '../helpers/mini-repo.js';
import { createTempDir } from '../helpers/test-db.js';
import { analyzeRuntime, copyAnalysisRuntime } from '../helpers/parse-identity-runtime.js';

async function fixture() {
  const artifacts = await createTempDir();
  const repo = await setupMiniRepo();
  const runtime = await copyAnalysisRuntime(artifacts.dbPath);
  await writeFile(
    path.join(repo.dbPath, 'src/probe.ts'),
    'export function parserProbe(value: number) { return value + 1; }\n',
  );
  execFileSync('git', ['add', '-A'], { cwd: repo.dbPath });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'probe',
    ],
    { cwd: repo.dbPath },
  );
  return {
    runtime,
    repoPath: repo.dbPath,
    home: path.join(artifacts.dbPath, 'home'),
    sibling: path.join(artifacts.dbPath, 'sibling'),
    run: (request: Parameters<typeof analyzeRuntime>[3] = {}) =>
      analyzeRuntime(runtime, repo.dbPath, path.join(artifacts.dbPath, 'home'), {
        source: true,
        ...request,
      }),
    cleanup: async () => {
      await repo.cleanup();
      await artifacts.cleanup();
    },
  };
}

interface ParseBarrier {
  storagePath: string;
  cacheRoot: string;
  stagingPaths: string[];
}

async function waitForBarrier(barrier: string): Promise<ParseBarrier> {
  await expect.poll(() => existsSync(`${barrier}.ready`), { timeout: 90_000 }).toBe(true);
  return JSON.parse(await readFile(`${barrier}.ready`, 'utf8'));
}

async function releaseBarrier(barrier: string): Promise<void> {
  await writeFile(`${barrier}.release`, 'continue');
}

async function cacheKeys(cacheRoot: string, directory: string): Promise<string[]> {
  const index = JSON.parse(await readFile(path.join(cacheRoot, directory, 'index.json'), 'utf8'));
  return directory === 'parse-cache' ? index.keys : Object.keys(index.entries);
}

describe('parser identity across real analysis processes', () => {
  it('keeps unverifiable rebuilt parser facts private at an unchanged shared commit', async () => {
    const f = await fixture();
    try {
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'sibling', f.sibling], {
        cwd: f.repoPath,
      });
      await rm(path.join(f.runtime, 'dist/core/analyzer-identity.js'));
      const a = await f.run({ sharedStore: true });
      expect(a.error).toBeUndefined();
      expect(a.meta?.parseCacheIdentity).toBeUndefined();
      expect(a.facts).toContainEqual({ kind: 'Function', name: 'parserProbe' });
      const query = path.join(f.runtime, 'dist/core/ingestion/tree-sitter-queries.js');
      const original = await readFile(query, 'utf8');
      const modified = original.replace(
        '(function_declaration\n  name: (identifier) @name) @definition.function',
        '(function_declaration\n  name: (identifier) @name) @definition.class',
      );
      expect(modified).not.toBe(original);
      await writeFile(query, modified);
      const b = await analyzeRuntime(f.runtime, f.sibling, f.home, {
        source: true,
        sharedStore: true,
      });
      expect(b.error).toBeUndefined();
      expect(b.meta?.lastCommit).toBe(a.meta?.lastCommit);
      expect(b.meta?.runnerIdentity?.build.digest).toBe(a.meta?.runnerIdentity?.build.digest);
      expect(b.meta?.parseCacheIdentity).toBeUndefined();
      expect(b.facts).toContainEqual({ kind: 'Class', name: 'parserProbe' });
      expect(b.facts).not.toContainEqual({ kind: 'Function', name: 'parserProbe' });
      expect(a.meta?.graphPath).toBeUndefined();
      expect(b.meta?.graphPath).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  }, 180_000);

  it('retains compatible keys published by a sibling after a regular run loaded its cache', async () => {
    const f = await fixture();
    const barrier = path.join(f.home, 'regular-publication');
    let pending: ReturnType<typeof f.run> | undefined;
    try {
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'sibling', f.sibling], {
        cwd: f.repoPath,
      });
      const initial = await f.run({ sharedStore: true });
      expect(initial.error).toBeUndefined();
      pending = f.run({ sharedStore: true, options: { force: true }, barrier });
      const paused = await waitForBarrier(barrier);
      await writeFile(
        path.join(f.sibling, 'src/sibling.ts'),
        'export function siblingOnly() { return 42; }\n',
      );
      const b = await analyzeRuntime(f.runtime, f.sibling, f.home, {
        source: true,
        sharedStore: true,
      });
      expect(b.error).toBeUndefined();
      const newKeys = (b.meta?.cacheKeys ?? []).filter(
        (key) => !initial.meta?.cacheKeys?.includes(key),
      );
      expect(newKeys.length).toBeGreaterThan(0);
      await releaseBarrier(barrier);
      const a = await pending;
      expect(a.error).toBeUndefined();
      for (const directory of ['parse-cache', 'parsedfile-cache']) {
        const saved = await cacheKeys(paused.cacheRoot, directory);
        for (const key of newKeys) expect(saved).toContain(key);
      }
      const warm = await analyzeRuntime(f.runtime, f.sibling, f.home, {
        source: true,
        sharedStore: true,
        options: { force: true },
      });
      expect(warm.error).toBeUndefined();
      expect(warm.reparsed).toBe(0);
      expect(warm.hits).toBe((b.hits ?? 0) + (b.reparsed ?? 0));
    } finally {
      await releaseBarrier(barrier);
      await pending;
      await f.cleanup();
    }
  }, 240_000);

  it('reclaims interrupted parser staging while preserving an active sibling run', async () => {
    const f = await fixture();
    const interruptedBarrier = path.join(f.home, 'interrupted');
    const activeBarrier = path.join(f.home, 'active-sibling');
    let pending: ReturnType<typeof f.run> | undefined;
    try {
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'sibling', f.sibling], {
        cwd: f.repoPath,
      });
      const interrupted = await f.run({
        sharedStore: true,
        barrier: interruptedBarrier,
        interruptAfterParse: true,
      });
      expect(interrupted.interrupted).toBe(true);
      const orphan = await waitForBarrier(interruptedBarrier);
      expect(orphan.stagingPaths).toHaveLength(1);
      expect((await readdir(orphan.stagingPaths[0])).length).toBeGreaterThan(0);
      pending = analyzeRuntime(f.runtime, f.sibling, f.home, {
        source: true,
        sharedStore: true,
        barrier: activeBarrier,
      });
      const active = await waitForBarrier(activeBarrier);
      const siblingStages = active.stagingPaths.filter(
        (stage) => !orphan.stagingPaths.includes(stage),
      );
      expect(siblingStages).toHaveLength(1);
      const before = await readdir(siblingStages[0]);
      const recovered = await f.run({ sharedStore: true });
      expect(recovered.error).toBeUndefined();
      for (const stage of orphan.stagingPaths) expect(existsSync(stage)).toBe(false);
      expect(await readdir(siblingStages[0])).toEqual(before);
      await releaseBarrier(activeBarrier);
      const sibling = await pending;
      expect(sibling.error).toBeUndefined();
      expect(sibling.facts).toEqual(recovered.facts);
      for (const stage of siblingStages) expect(existsSync(stage)).toBe(false);
    } finally {
      await releaseBarrier(activeBarrier);
      await pending;
      await f.cleanup();
    }
  }, 240_000);

  it('keeps two parser identities isolated while their shared-store runs overlap', async () => {
    const f = await fixture();
    const barrier = path.join(f.home, 'identity-overlap');
    let pending: ReturnType<typeof f.run> | undefined;
    try {
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'sibling', f.sibling], {
        cwd: f.repoPath,
      });
      const runtimeB = await copyAnalysisRuntime(path.join(path.dirname(f.runtime), 'runtime-b'));
      const query = path.join(runtimeB, 'dist/core/ingestion/tree-sitter-queries.js');
      const original = await readFile(query, 'utf8');
      const modified = original.replace(
        '(function_declaration\n  name: (identifier) @name) @definition.function',
        '(function_declaration\n  name: (identifier) @name) @definition.class',
      );
      expect(modified).not.toBe(original);
      await writeFile(query, modified);
      pending = f.run({ sharedStore: true, barrier });
      const paused = await waitForBarrier(barrier);
      const b = await analyzeRuntime(runtimeB, f.sibling, f.home, {
        source: true,
        sharedStore: true,
      });
      expect(b.error).toBeUndefined();
      await releaseBarrier(barrier);
      const a = await pending;
      expect(a.error).toBeUndefined();
      expect(a.meta?.parseCacheIdentity).not.toEqual(b.meta?.parseCacheIdentity);
      expect(a.meta?.graphPath).not.toBe(b.meta?.graphPath);
      expect(a.facts).toEqual([{ kind: 'Function', name: 'parserProbe' }]);
      expect(b.facts).toEqual([{ kind: 'Class', name: 'parserProbe' }]);
      const aWarm = await f.run({ sharedStore: true, options: { force: true } });
      expect(aWarm.error).toBeUndefined();
      expect(aWarm.reparsed).toBe(0);
      expect(aWarm.facts).toEqual(a.facts);
      const bCold = await analyzeRuntime(runtimeB, f.sibling, f.home, {
        source: true,
        sharedStore: true,
        options: { force: true },
      });
      expect(bCold.error).toBeUndefined();
      expect(bCold.hits).toBe(0);
      expect(bCold.reparsed).toBeGreaterThan(0);
      expect(bCold.facts).toEqual(b.facts);
      for (const directory of ['parse-cache', 'parsedfile-cache']) {
        expect((await cacheKeys(paused.cacheRoot, directory)).sort()).toEqual(
          [...bCold.meta!.cacheKeys!].sort(),
        );
      }
    } finally {
      await releaseBarrier(barrier);
      await pending;
      await f.cleanup();
    }
  }, 240_000);

  it('invalidates source edits before rebuild, rebuilt worker facts, and compiled shared inputs', async () => {
    const f = await fixture();
    try {
      const cold = await f.run();
      expect(cold.error).toBeUndefined();
      expect(cold.reparsed).toBeGreaterThan(0);
      expect(cold.facts).toContainEqual({ kind: 'Function', name: 'parserProbe' });
      const warm = await f.run({ options: { force: true } });
      expect(warm.error).toBeUndefined();
      expect(warm.reparsed).toBe(0);
      expect(warm.hits).toBe(cold.reparsed);
      expect(warm.facts).toEqual(cold.facts);
      expect((await f.run()).alreadyUpToDate).toBe(true);

      const query = path.join(f.runtime, 'src/core/ingestion/tree-sitter-queries.ts');
      const original = await readFile(query, 'utf8');
      const modified = original.replace(
        '(function_declaration\n  name: (identifier) @name) @definition.function',
        '(function_declaration\n  name: (identifier) @name) @definition.class',
      );
      expect(modified).not.toBe(original);
      await writeFile(query, modified);
      const oldWorker = await f.run();
      expect(oldWorker.error).toBeUndefined();
      expect(oldWorker.alreadyUpToDate).toBe(false);
      expect(oldWorker.rebuildReasons).toContain('parser-identity');
      expect(oldWorker.hits).toBe(0);
      expect(oldWorker.meta?.parseCacheIdentity?.base).not.toBe(
        cold.meta?.parseCacheIdentity?.base,
      );
      // Source edits invalidate immediately; they do not compile the worker.
      expect(oldWorker.facts).toEqual(cold.facts);

      const rebuild = () =>
        execFileSync(process.execPath, ['scripts/build.js'], {
          cwd: f.runtime,
          stdio: 'pipe',
          timeout: 120_000,
        });
      rebuild();
      const rebuilt = await f.run();
      expect(rebuilt.error).toBeUndefined();
      expect(rebuilt.hits).toBe(0);
      expect(rebuilt.meta?.parseCacheIdentity?.base).not.toBe(
        oldWorker.meta?.parseCacheIdentity?.base,
      );
      expect(rebuilt.facts).toContainEqual({ kind: 'Class', name: 'parserProbe' });
      expect(rebuilt.facts).not.toContainEqual({ kind: 'Function', name: 'parserProbe' });

      // A -> B -> A shares a physical cache root, but cannot admit B's facts as A.
      await writeFile(query, original);
      rebuild();
      const restored = await f.run();
      expect(restored.error).toBeUndefined();
      expect(restored.hits).toBe(0);
      expect(restored.meta?.parseCacheIdentity).toEqual(cold.meta?.parseCacheIdentity);
      expect(restored.facts).toEqual(cold.facts);

      const shared = path.join(f.runtime, 'dist/_shared/index.js');
      await writeFile(shared, `${await readFile(shared, 'utf8')}\n// rebuilt shared helper\n`);
      const changedShared = await f.run();
      expect(changedShared.error).toBeUndefined();
      expect(changedShared.hits).toBe(0);
      expect(changedShared.meta?.parseCacheIdentity).not.toEqual(restored.meta?.parseCacheIdentity);
      expect(changedShared.facts).toEqual(cold.facts);
    } finally {
      await f.cleanup();
    }
  }, 300_000);

  it('isolates two real processes sharing worktree storage at the same commit', async () => {
    const f = await fixture();
    try {
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'sibling', f.sibling], {
        cwd: f.repoPath,
      });
      const a = await f.run({ sharedStore: true });
      expect(a.error).toBeUndefined();
      expect(a.meta?.graphPath).toBeTruthy();
      const query = path.join(f.runtime, 'dist/core/ingestion/tree-sitter-queries.js');
      const original = await readFile(query, 'utf8');
      await writeFile(
        query,
        original.replace(
          '(function_declaration\n  name: (identifier) @name) @definition.function',
          '(function_declaration\n  name: (identifier) @name) @definition.class',
        ),
      );
      const b = await analyzeRuntime(f.runtime, f.sibling, f.home, {
        source: true,
        sharedStore: true,
      });
      expect(b.error).toBeUndefined();
      expect(b.alreadyUpToDate).toBe(false);
      expect(b.hits).toBe(0);
      expect(b.meta?.runnerIdentity?.build.digest).toBe(a.meta?.runnerIdentity?.build.digest);
      expect(b.meta?.parseCacheIdentity).not.toEqual(a.meta?.parseCacheIdentity);
      expect(b.meta?.graphPath).not.toBe(a.meta?.graphPath);
      expect(b.facts).toContainEqual({ kind: 'Class', name: 'parserProbe' });
      expect(b.facts).not.toContainEqual({ kind: 'Function', name: 'parserProbe' });
      await writeFile(query, original);
      const returned = await f.run({ sharedStore: true, options: { force: true } });
      expect(returned.error).toBeUndefined();
      expect(returned.hits).toBe(0);
      expect(returned.meta?.parseCacheIdentity).toEqual(a.meta?.parseCacheIdentity);
      expect(returned.facts).toEqual(a.facts);
    } finally {
      await f.cleanup();
    }
  }, 180_000);

  it('rejects a compiled-worker mutation before graph/cache publication', async () => {
    const f = await fixture();
    try {
      const initial = await f.run();
      expect(initial.error).toBeUndefined();
      const indexes = ['parse-cache/index.json', 'parsedfile-cache/index.json'];
      const before = await Promise.all(
        indexes.map((file) => readFile(path.join(initial.storagePath, file), 'utf8')),
      );
      const failed = await f.run({
        options: { force: true, useParseCache: false },
        mutate: path.join(f.runtime, 'dist/core/ingestion/tree-sitter-queries.js'),
      });
      expect(failed.error).toMatch(/Parser build changed during analysis/i);
      expect(failed.meta?.indexedAt).toBe(initial.meta?.indexedAt);
      expect(
        await Promise.all(
          indexes.map((file) => readFile(path.join(initial.storagePath, file), 'utf8')),
        ),
      ).toEqual(before);
      expect(
        (await readdir(initial.storagePath)).filter((name) => name.startsWith('parse-rebuild')),
      ).toEqual([]);
      const recovered = await f.run();
      expect(recovered.error).toBeUndefined();
      expect(recovered.reparsed).toBeGreaterThan(0);
      expect(recovered.facts).toEqual(initial.facts);
    } finally {
      await f.cleanup();
    }
  }, 180_000);

  it('runs uncached when identity is unverifiable and recovers from a later cache-save failure', async () => {
    const f = await fixture();
    try {
      const initial = await f.run();
      expect(initial.error).toBeUndefined();
      const index = path.join(initial.storagePath, 'parse-cache/index.json');
      const previousIndex = await readFile(index, 'utf8');
      // Source analysis does not execute this compiled coordinator, but it is
      // required evidence for the worker artifact tree. Parsing still works.
      const absent = path.join(f.runtime, 'dist/core/analyzer-identity.js');
      const original = await readFile(absent);
      await rm(absent);
      const uncached = await f.run({ options: { force: true } });
      expect(uncached.error).toBeUndefined();
      expect(uncached.hits).toBe(0);
      expect(uncached.reparsed).toBe(initial.reparsed);
      expect(uncached.meta?.parseCacheIdentity).toBeUndefined();
      expect(uncached.facts).toEqual(initial.facts);
      expect(await readFile(index, 'utf8')).toBe(previousIndex);
      await writeFile(absent, original);

      const failedSave = await f.run({
        options: { force: true, useParseCache: false },
        failCacheSave: true,
      });
      expect(failedSave.error).toBeUndefined();
      expect(failedSave.facts).toEqual(initial.facts);
      expect(failedSave.logs.join('\n')).toMatch(/could not save parse cache/i);
      expect(failedSave.meta?.parseCacheIdentity).toEqual(initial.meta?.parseCacheIdentity);
      await rm(path.join(initial.storagePath, 'parsedfile-cache/index.json'), { recursive: true });
      const retry = await f.run({ options: { force: true } });
      expect(retry.error).toBeUndefined();
      expect(retry.hits).toBe(0);
      expect(retry.reparsed).toBe(initial.reparsed);
      expect(retry.facts).toEqual(initial.facts);
    } finally {
      await f.cleanup();
    }
  }, 180_000);
});
