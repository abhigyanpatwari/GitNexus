import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensurePrivateSharedGraph } from '../../src/core/shared-store-analyze.js';
import { loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
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
