/**
 * M7 — `findWorkspaceRoots`'s workspace-ROOT scan (nested `pnpm-workspace.yaml`
 * / `lerna.json` / `package.json#workspaces` discovery inside
 * `node-workspace-packages.ts`): sorted `readdir` (deterministic) and a
 * 50,000-directory cap that warns instead of silently truncating.
 *
 * Real disk I/O can't cheaply exercise a 50,000-directory tree, so `readdir` /
 * `readFile` are intercepted for one virtual root and everything else falls
 * through to the real `fs/promises` (same Proxy-over-`importOriginal` shape as
 * `node-workspace-repo-root-race.test.ts`), so unrelated code (the logger's
 * own init, etc.) is unaffected.
 *
 * Two things are proven, deliberately kept SEPARATE because they can't both be
 * observed through the same signal: a package admitted through a NESTED
 * root's declaration sits one directory level BELOW the declaring directory,
 * and the wide level needed to trip the 50k root-scan cap already exceeds the
 * SEPARATE 20k-directory package-scan cap — so a package nested under the
 * wide, capped subtree is not a reachable signal for either scan.
 *
 *  1. The cap trips and warns (`logger.warn`, captured via `_captureLogger`)
 *     rather than hanging or throwing, however the synthetic `readdir` order
 *     is shuffled.
 *  2. A package admitted through a path that does NOT depend on the wide,
 *     capped subtree (`members/only`, admitted directly by the repo root's
 *     OWN declared `workspaces: ['members/*']`) still resolves correctly and
 *     IDENTICALLY no matter how the wide subtree's `readdir` order is
 *     shuffled — the capped/warned branch does not corrupt or drop unrelated,
 *     already-resolvable results.
 */
import { describe, it, expect, vi } from 'vitest';
import { _captureLogger } from '../../src/core/logger.js';

const ROOT = '/virtual-gn-m7-repo';
const FILLER_COUNT = 50_010; // > WORKSPACE_ROOT_SCAN_MAX_DIRS (50_000)
// The wide subtree is named to sort AFTER `members`: both scans now read directories in
// sorted order (deterministic), so a capped scan drops whatever sorts last — the
// fixture must not rely on unsorted readdir order to reach `members/only` first.

interface FakeDirent {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}
const dirEnt = (name: string): FakeDirent => ({
  name,
  isDirectory: () => true,
  isFile: () => false,
});
const fileEnt = (name: string): FakeDirent => ({
  name,
  isDirectory: () => false,
  isFile: () => true,
});

/** Fisher-Yates, seeded by a simple LCG so each "shuffle" is reproducible. */
function shuffled<T>(arr: readonly T[], seed: number): T[] {
  const out = [...arr];
  let s = seed;
  const rand = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const fillerNames = Array.from(
  { length: FILLER_COUNT },
  (_, i) => `d${String(i).padStart(6, '0')}`,
);

// A mutable box the mock factory closes over — flipped per shuffle from
// inside the test, so `vi.mock` (hoisted, registered once) can still serve a
// different `filler` order on each call without `vi.resetModules()`.
const box = vi.hoisted(() => ({ fillerOrder: [] as string[] }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const d = (actual as unknown as { default: typeof actual }).default ?? actual;

  const relOf = (p: string): string | null =>
    p === ROOT ? '' : p.startsWith(`${ROOT}/`) ? p.slice(ROOT.length + 1) : null;

  const fakeReaddir = async (dir: string) => {
    const rel = relOf(dir);
    if (rel === null)
      return (d as typeof import('fs/promises')).readdir(
        dir as never,
        {
          withFileTypes: true,
        } as never,
      );
    if (rel === '') return [dirEnt('members'), dirEnt('zzz-filler')];
    if (rel === 'members') return [dirEnt('only')];
    if (rel === 'members/only') return [fileEnt('package.json')];
    if (rel === 'zzz-filler') return box.fillerOrder.map(dirEnt);
    // Every filler child (and anything deeper, unreached in practice) is empty.
    return [];
  };
  const fakeReadFile = async (file: string) => {
    const rel = relOf(file);
    if (rel === null) return (d as typeof import('fs/promises')).readFile(file as never, 'utf-8');
    if (rel === 'package.json') {
      return JSON.stringify({ name: 'root', private: true, workspaces: ['members/*'] });
    }
    if (rel === 'members/only/package.json') {
      return JSON.stringify({ name: '@repo/only', exports: { '.': './index.ts' } });
    }
    const err = Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    throw err;
  };

  return {
    default: new Proxy(d, {
      get(target, prop) {
        if (prop === 'readdir') return fakeReaddir;
        if (prop === 'readFile') return fakeReadFile;
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    }),
  };
});

describe('M7 — workspace-root scan: sorted readdir + a cap that warns (50,010-directory synthetic tree)', () => {
  it('trips the cap and warns, and the run still completes deterministically for a result outside the capped subtree', async () => {
    const { loadNodeWorkspacePackages, invalidateNodeWorkspacePackages } =
      await import('../../src/core/ingestion/import-resolvers/node-workspace-packages.js');

    const results: {
      warned: boolean;
      onlyDir: string | undefined;
      onlyEntries: readonly string[] | undefined;
    }[] = [];

    for (const seed of [1, 2]) {
      box.fillerOrder = shuffled(fillerNames, seed);
      invalidateNodeWorkspacePackages(ROOT);

      const cap = _captureLogger();
      let pkgs;
      try {
        pkgs = await loadNodeWorkspacePackages(ROOT);
      } finally {
        cap.restore();
      }

      const text = cap.text();
      const warned =
        text.includes('workspace-root scan') &&
        text.includes('50000-directory cap') &&
        text.includes(ROOT);
      const only = pkgs?.byName.get('@repo/only');
      results.push({ warned, onlyDir: only?.dir, onlyEntries: only?.entries });
    }

    // Both shuffles hit the cap and warned about it.
    expect(results[0]!.warned).toBe(true);
    expect(results[1]!.warned).toBe(true);

    // Both shuffles still admit the package reachable independently of the
    // wide/capped `filler` subtree, identically.
    expect(results[0]!.onlyDir).toBe('members/only');
    expect(results[1]!.onlyDir).toBe('members/only');
    expect(results[0]!.onlyEntries).toEqual(['members/only/index']);
    expect(results[1]!.onlyEntries).toEqual(results[0]!.onlyEntries);
  }, 60_000);
});
