import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensurePrivateSharedGraph } from '../../src/core/shared-store-analyze.js';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import { resolveSharedStore, type SharedStoreLayout } from '../../src/storage/shared-store.js';
import { createTempDir } from '../helpers/test-db.js';

// These suites exercise sharing; an inherited opt-out would silently disable it.
const savedSharedStoreSwitch = process.env.GITNEXUS_SHARED_STORE;
beforeAll(() => {
  delete process.env.GITNEXUS_SHARED_STORE;
});
afterAll(() => {
  if (savedSharedStoreSwitch === undefined) delete process.env.GITNEXUS_SHARED_STORE;
  else process.env.GITNEXUS_SHARED_STORE = savedSharedStoreSwitch;
});

/**
 * #3352 U4 — a checkout that needs its own graph is seeded from the nearest
 * commit graph and updated incrementally instead of rebuilt from scratch.
 */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();

const commitAll = (cwd: string, message: string): void => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
};

const layoutOf = (checkout: string): SharedStoreLayout => {
  const layout = resolveSharedStore(checkout);
  expect(layout).not.toBeNull();
  return layout as SharedStoreLayout;
};

const queryNames = async (graph: string): Promise<string[]> => {
  const lbug = (await import('@ladybugdb/core')).default;
  const db = new lbug.Database(graph, 0, true, true);
  const conn = new lbug.Connection(db);
  try {
    const rows = (await (
      await conn.query('MATCH (f:Function) RETURN f.name AS n ORDER BY n')
    ).getAll()) as { n: string }[];
    return rows.map((r) => r.n);
  } finally {
    await conn.close();
    await db.close();
  }
};

const graphOf = (checkout: string): string =>
  getStoragePaths(checkout, undefined, layoutOf(checkout).checkoutSlot).lbugPath;

describe('shared store seeding (#3352)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;
  let root: string;
  let main: string;

  const analyze = async (checkout: string, logs?: string[]) => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    return runFullAnalysis(checkout, {}, { onProgress: () => {}, onLog: (m) => logs?.push(m) });
  };

  const addWorktree = (name: string, base = 'main'): string => {
    const wt = path.join(root, name);
    git(main, 'worktree', 'add', '-q', '-b', name, wt, base);
    return wt;
  };

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-test-seed-home-');
    tmpRepo = await createTempDir('gitnexus-test-seed-repo-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    root = await fs.realpath(tmpRepo.dbPath);
    main = path.join(root, 'main');
    await fs.mkdir(main);
    git(main, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(main, 'a.ts'), 'export function alpha() { return 1; }\n');
    await fs.writeFile(path.join(main, 'b.ts'), 'export function beta() { return 2; }\n');
    commitAll(main, 'init');
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpRepo.cleanup();
    await tmpHome.cleanup();
  });

  it('Covers AE2: an edited worktree gets a private incremental graph; siblings are unchanged', async () => {
    const wtA = addWorktree('wt-a');
    const wtB = addWorktree('wt-b');
    await analyze(main);
    await analyze(wtA);
    await analyze(wtB);
    const shared = graphOf(wtB);
    expect(graphOf(wtA)).toBe(shared);

    await fs.writeFile(path.join(wtA, 'a.ts'), 'export function alphaEdited() { return 1; }\n');
    const logs: string[] = [];
    await analyze(wtA, logs);

    expect(graphOf(wtA)).toBe(path.join(layoutOf(wtA).checkoutSlot, 'lbug'));
    expect(logs.some((m) => m.startsWith('Incremental:'))).toBe(true);
    expect(await queryNames(graphOf(wtA))).toEqual(['alphaEdited', 'beta']);
    expect(graphOf(wtB)).toBe(shared);
    expect(await queryNames(shared)).toEqual(['alpha', 'beta']);
  }, 240_000);

  it('Covers AE3: committing the edits publishes a commit graph and drops the private one', async () => {
    const wtA = addWorktree('wt-a');
    await analyze(wtA);
    await fs.writeFile(path.join(wtA, 'c.ts'), 'export function gamma() { return 3; }\n');
    await analyze(wtA);
    const slot = layoutOf(wtA).checkoutSlot;
    expect(existsSync(path.join(slot, 'lbug'))).toBe(true);

    commitAll(wtA, 'gamma');
    await analyze(wtA);

    expect(existsSync(path.join(slot, 'lbug'))).toBe(false);
    expect(path.dirname(path.dirname(graphOf(wtA)))).toBe(layoutOf(wtA).commitsDir);
    expect(await queryNames(graphOf(wtA))).toEqual(['alpha', 'beta', 'gamma']);
  }, 240_000);

  it('seeds a new worktree at a descendant commit from its indexed ancestor', async () => {
    await analyze(main);
    git(main, 'checkout', '-q', '-b', 'next');
    await fs.writeFile(path.join(main, 'c.ts'), 'export function gamma() { return 3; }\n');
    commitAll(main, 'gamma');
    git(main, 'checkout', '-q', 'main');
    const wt = addWorktree('wt-next', 'next');

    const logs: string[] = [];
    await analyze(wt, logs);

    // `main` was indexed before any worktree existed, so its index is
    // repository-local; the first worktree seeds from that copy.
    expect(logs).toContain(
      `Shared store: seeded from the local index at ${path.join(main, '.gitnexus')}.`,
    );
    expect(logs.some((m) => m.startsWith('Incremental:'))).toBe(true);
    expect(await queryNames(graphOf(wt))).toEqual(['alpha', 'beta', 'gamma']);
    // The source index is left in place.
    expect(existsSync(path.join(main, '.gitnexus', 'lbug'))).toBe(true);
  }, 240_000);

  it('seeds a descendant worktree from the store commit graph once one exists', async () => {
    const wtA = addWorktree('wt-a');
    await analyze(wtA);
    git(main, 'checkout', '-q', '-b', 'next');
    await fs.writeFile(path.join(main, 'c.ts'), 'export function gamma() { return 3; }\n');
    commitAll(main, 'gamma');
    git(main, 'checkout', '-q', 'main');
    const wt = addWorktree('wt-next', 'next');

    const logs: string[] = [];
    await analyze(wt, logs);

    const base = git(main, 'rev-parse', 'main');
    expect(logs).toContain(`Shared store: seeded from commit graph ${base.slice(0, 12)}.`);
    expect(logs.some((m) => m.startsWith('Incremental:'))).toBe(true);
    expect(await queryNames(graphOf(wt))).toEqual(['alpha', 'beta', 'gamma']);
  }, 240_000);

  it('runs a full build for a worktree with no indexed ancestor', async () => {
    await analyze(main);
    const orphan = path.join(root, 'orphan');
    git(main, 'worktree', 'add', '-q', '--detach', orphan);
    git(orphan, 'checkout', '-q', '--orphan', 'unrelated');
    git(orphan, 'rm', '-q', '-rf', '.');
    await fs.writeFile(path.join(orphan, 'z.ts'), 'export function zeta() { return 0; }\n');
    commitAll(orphan, 'unrelated root');

    const logs: string[] = [];
    await analyze(orphan, logs);

    expect(logs.some((m) => m.startsWith('Shared store: seeded'))).toBe(false);
    expect(logs.some((m) => m.startsWith('Incremental:'))).toBe(false);
    expect(await queryNames(graphOf(orphan))).toEqual(['zeta']);
  }, 240_000);

  it('a forced rebuild of a pointer slot builds without copying the shared graph', async () => {
    const wt = addWorktree('wt-a');
    await analyze(main);
    await analyze(wt);
    const shared = graphOf(wt);
    expect(path.dirname(path.dirname(shared))).toBe(layoutOf(wt).commitsDir);

    const logs: string[] = [];
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    await runFullAnalysis(
      wt,
      { force: true },
      { onProgress: () => {}, onLog: (m) => logs.push(m) },
    );

    expect(logs.some((m) => m.startsWith('Shared store: copied the shared graph'))).toBe(false);
    expect(await queryNames(graphOf(wt))).toEqual(['alpha', 'beta']);
    expect(existsSync(shared)).toBe(true);
  }, 240_000);

  it('matches a from-scratch build after seeding and updating (R9)', async () => {
    const wt = addWorktree('wt-a');
    await analyze(main);
    await fs.writeFile(path.join(wt, 'b.ts'), 'export function betaTwo() { return 22; }\n');
    await fs.writeFile(path.join(wt, 'c.ts'), 'export function gamma() { return 3; }\n');
    await analyze(wt);
    const seeded = await queryNames(graphOf(wt));

    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    await runFullAnalysis(wt, { force: true }, { onProgress: () => {} });
    expect(await queryNames(graphOf(wt))).toEqual(seeded);
    expect(seeded).toEqual(['alpha', 'betaTwo', 'gamma']);
  }, 240_000);
});

describe('ensurePrivateSharedGraph', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-test-private-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpHome.cleanup();
  });

  const pointerSlot = async (): Promise<{ slot: string; graph: string }> => {
    const storeRoot = path.join(tmpHome.dbPath, 'stores', 'repo-0123456789ab');
    const slot = path.join(storeRoot, 'checkouts', 'wt-0123456789ab');
    const graph = path.join(storeRoot, 'commits', 'abc1234-deadbeefdeadbeef', 'lbug');
    await fs.mkdir(path.dirname(graph), { recursive: true });
    await fs.mkdir(slot, { recursive: true });
    await saveMeta(slot, {
      repoPath: '/tmp/wt',
      storagePath: slot,
      lastCommit: 'abc1234',
      indexedAt: new Date().toISOString(),
      graphPath: graph,
    });
    return { slot, graph };
  };

  it('copies the shared graph and clears the pointer', async () => {
    const { slot, graph } = await pointerSlot();
    await fs.writeFile(graph, 'shared graph bytes');
    expect(await ensurePrivateSharedGraph(slot, () => {})).toBe(true);
    expect(await fs.readFile(path.join(slot, 'lbug'), 'utf-8')).toBe('shared graph bytes');
    expect((await loadMeta(slot))?.graphPath).toBeUndefined();
    expect(await fs.readFile(graph, 'utf-8')).toBe('shared graph bytes');
  });

  it('reports an unusable baseline when the shared graph is gone', async () => {
    const { slot } = await pointerSlot();
    const logs: string[] = [];
    expect(await ensurePrivateSharedGraph(slot, (m) => logs.push(m))).toBe(false);
    expect(existsSync(path.join(slot, 'lbug'))).toBe(false);
    expect(logs.join('\n')).toMatch(/shared graph unavailable \(ENOENT\)/);
    expect((await fs.readdir(slot)).filter((n) => n.startsWith('lbug'))).toEqual([]);
  });

  it('with copy: false drops the pointer without copying', async () => {
    const { slot, graph } = await pointerSlot();
    await fs.writeFile(graph, 'shared graph bytes');
    expect(await ensurePrivateSharedGraph(slot, () => {}, { copy: false })).toBe(true);
    expect(existsSync(path.join(slot, 'lbug'))).toBe(false);
    expect((await loadMeta(slot))?.graphPath).toBeUndefined();
  });

  it('is a no-op for a slot that already owns its graph', async () => {
    const { slot } = await pointerSlot();
    const meta = await loadMeta(slot);
    delete meta?.graphPath;
    await saveMeta(slot, meta as NonNullable<typeof meta>);
    await fs.writeFile(path.join(slot, 'lbug'), 'private graph bytes');
    expect(await ensurePrivateSharedGraph(slot, () => {})).toBe(true);
    expect(await fs.readFile(path.join(slot, 'lbug'), 'utf-8')).toBe('private graph bytes');
  });
});
