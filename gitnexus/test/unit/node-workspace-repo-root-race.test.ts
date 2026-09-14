/**
 * Regression — entry discovery must not share mutable state across concurrent
 * `loadNodeWorkspacePackages` calls. A module-level repo-root singleton once let
 * a second repo's scan interleave with the first's `stemExists` checks, so a
 * package with two real candidate source entries (which must be REFUSED as
 * ambiguous) was adopted with a single confident, wrong winner. The repo root is
 * now threaded explicitly; both candidates must be refused under interleaving.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const raceCtx = vi.hoisted(() => ({
  reachedResolve: null as (() => void) | null,
  reached: null as Promise<void> | null,
  releaseGate: null as (() => void) | null,
  gate: null as Promise<void> | null,
}));
raceCtx.reached = new Promise<void>((resolve) => {
  raceCtx.reachedResolve = resolve;
});
raceCtx.gate = new Promise<void>((resolve) => {
  raceCtx.releaseGate = resolve;
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const d = (actual as unknown as { default: typeof actual }).default ?? actual;
  return {
    default: new Proxy(d, {
      get(target, prop) {
        if (prop === 'stat') {
          return async (p: string) => {
            // Gate ONLY the stat check for repo A's SECOND package's real
            // source file — everything else (including repo B's entire
            // scan, and repo A's first package) proceeds unmodified.
            if (String(p).includes('pkg2-sentinel')) {
              raceCtx.reachedResolve!();
              await raceCtx.gate;
            }
            return (target as typeof import('fs/promises')).stat(p as unknown as never);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    }),
  };
});

describe('node-workspace-packages: entry discovery is safe under concurrent scans (regression for a former shared-global (race)', () => {
  let repoA: string;
  let repoB: string;
  const w = (root: string, p: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), s);
  };

  beforeAll(() => {
    repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-race-a-'));
    repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-race-b-'));

    // Repo A: two packages needing entry discovery, package1 SHALLOWER than
    // package2 so the BFS visits package1 first (queue is layer-ordered).
    w(repoA, 'package.json', JSON.stringify({ name: 'root-a', private: true, workspaces: ['**'] }));
    w(
      repoA,
      'pkg1/package.json',
      JSON.stringify({ name: '@race/pkg1', main: 'dist/index.js', source: 'src/real1.ts' }),
    );
    w(repoA, 'pkg1/src/real1.ts', 'export const one = 1;\n');
    // pkg2 declares TWO candidate source fields, both real files. Candidate 1
    // (`source`) is checked first — its `stemExists` call is the one whose
    // STAT gets gated, but its `abs` path was already computed (correctly,
    // against repo A) before the gate blocks the underlying `fs.stat`, so it
    // still resolves correctly once released. Candidate 2 (`publishConfig.
    // source`) is checked SECOND, in a separate `stemExists` call whose
    // `abs` is computed fresh AFTER repo B's scan has already clobbered the
    // shared global — that is the call the race corrupts.
    w(
      repoA,
      'pkg1/pkg2-sentinel/package.json',
      JSON.stringify({
        name: '@race/pkg2',
        main: 'dist/index.js',
        source: 'src/real2a.ts',
        publishConfig: { source: 'src/real2b.ts' },
      }),
    );
    w(repoA, 'pkg1/pkg2-sentinel/src/real2a.ts', 'export const twoA = 1;\n');
    w(repoA, 'pkg1/pkg2-sentinel/src/real2b.ts', 'export const twoB = 2;\n');

    // Repo B: a single trivial package needing NO discovery at all — its
    // scan completes purely on the strength of a declared source `main`,
    // (the former shared repo-root global would have been clobbered here).
    w(repoB, 'package.json', JSON.stringify({ name: 'root-b', private: true, workspaces: ['*'] }));
    w(repoB, 'lib/package.json', JSON.stringify({ name: '@other/lib', main: 'src/index.ts' }));
    w(repoB, 'lib/src/index.ts', 'export const b = 1;\n');
  });

  afterAll(() => {
    fs.rmSync(repoA, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(repoB, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("repo B finishing mid-scan does not corrupt repo A's in-flight source-entry discovery", async () => {
    const { loadNodeWorkspacePackages } =
      await import('../../src/core/ingestion/import-resolvers/node-workspace-packages.js');

    const pA = loadNodeWorkspacePackages(repoA);
    // Wait until A is blocked right before checking pkg2's real source file.
    await raceCtx.reached;
    // Run B to completion WHILE A is gated — this is the clobber.
    await loadNodeWorkspacePackages(repoB);
    raceCtx.releaseGate!();
    const pkgsA = await pA;

    // pkg1 (checked before the clobber) is unaffected.
    expect(pkgsA!.byName.get('@race/pkg1')!.entries).toContain('pkg1/src/real1');

    // pkg2 declares TWO real, DIFFERENT source candidates — the correct
    // behavior is REFUSAL (both exist, genuinely ambiguous, per the same
    // "ambiguous when >1 exists" rule the C4 fixture in
    // node-workspace-nested-roots.test.ts pins), so NEITHER should be
    // adopted.
    //
    // With the root threaded per call, candidate 2's existence check uses ITS repo root,
    // both candidates are found, and the package is refused as ambiguous.
    const pkg2Entries = pkgsA!.byName.get('@race/pkg2')!.entries;
    expect(pkg2Entries).not.toContain('pkg1/pkg2-sentinel/src/real2a');
    expect(pkg2Entries).not.toContain('pkg1/pkg2-sentinel/src/real2b');
  });
});
