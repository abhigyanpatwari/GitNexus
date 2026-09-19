/**
 * Regression (review finding on #3182, node-workspace-packages.ts:474) — a
 * rejected, already-INVALIDATED load must not evict the newer load memoized
 * under the same key. Sequence: load A in flight → `invalidate(key)` → load B
 * installed → A rejects. A's handler used to `delete(key)` unconditionally,
 * throwing B away so every later caller started another full scan.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ctx = vi.hoisted(() => ({
  gateRoot: null as string | null,
  reachedResolve: null as (() => void) | null,
  reached: null as Promise<void> | null,
  releaseGate: null as (() => void) | null,
  gate: null as Promise<void> | null,
  failNextIgnoreCheck: false,
  rootReaddirCalls: 0,
  watchedRoot: null as string | null,
}));
ctx.reached = new Promise<void>((resolve) => {
  ctx.reachedResolve = resolve;
});
ctx.gate = new Promise<void>((resolve) => {
  ctx.releaseGate = resolve;
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const d = (actual as unknown as { default: typeof actual }).default ?? actual;
  return {
    default: new Proxy(d, {
      get(target, prop) {
        if (prop === 'readdir') {
          return async (p: string, opts: unknown) => {
            // Park load A on its FIRST readdir of the repo root; everything
            // else — including load B's entire scan — proceeds unmodified.
            if (String(p) === ctx.watchedRoot) ctx.rootReaddirCalls++;
            if (ctx.gateRoot !== null && String(p) === ctx.gateRoot) {
              ctx.gateRoot = null;
              ctx.reachedResolve!();
              await ctx.gate;
            }
            return (target.readdir as (p: string, o: unknown) => Promise<unknown>)(p, opts);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    }),
  };
});

vi.mock('../../src/config/ignore-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/ignore-service.js')>();
  return {
    ...actual,
    // Called from the scan loop OUTSIDE any try/catch — the one place a
    // throw turns into a rejected load promise.
    isHardcodedIgnoredDirectoryAtPath: (repoRoot: string, dir: string) => {
      if (ctx.failNextIgnoreCheck) {
        ctx.failNextIgnoreCheck = false;
        throw new Error('injected scan failure');
      }
      return actual.isHardcodedIgnoredDirectoryAtPath(repoRoot, dir);
    },
  };
});

describe('node-workspace-packages memo: a rejected invalidated load keeps the newer entry', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-memo-reject-'));
  const w = (p: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
    fs.writeFileSync(path.join(repo, p), s);
  };
  w('package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }));
  w('packages/lib/package.json', JSON.stringify({ name: '@m/lib', main: 'src/index.ts' }));
  w('packages/lib/src/index.ts', 'export const x = 1;\n');

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('load B survives load A rejecting after invalidation', async () => {
    const { loadNodeWorkspacePackages, invalidateNodeWorkspacePackages } =
      await import('../../src/core/ingestion/import-resolvers/node-workspace-packages.js');
    const key = path.resolve(repo);

    ctx.gateRoot = key;
    ctx.watchedRoot = key;
    const loadA = loadNodeWorkspacePackages(repo);
    await ctx.reached; // A is parked mid-scan

    invalidateNodeWorkspacePackages(repo);
    const loadB = loadNodeWorkspacePackages(repo);
    expect(loadB).not.toBe(loadA);
    const packagesB = await loadB; // B completes and is memoized
    expect(packagesB?.byName.has('@m/lib') ?? false).toBe(true);

    // Now let A resume and blow up.
    ctx.failNextIgnoreCheck = true;
    ctx.releaseGate!();
    await expect(loadA).rejects.toThrow('injected scan failure');

    // The memo must still serve B, not start a fresh scan. (`async` re-wraps
    // the cached promise, so identity cannot be compared — count scans instead.)
    const scansBefore = ctx.rootReaddirCalls;
    expect(scansBefore).toBeGreaterThan(0);
    const third = await loadNodeWorkspacePackages(repo);
    expect(third).toBe(packagesB);
    expect(ctx.rootReaddirCalls).toBe(scansBefore);
  });
});
