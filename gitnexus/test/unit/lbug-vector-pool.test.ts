import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  fts: vi.fn(),
  threads: vi.fn(),
  connections: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
}));
vi.mock('@ladybugdb/core', () => ({
  default: {
    Connection: class {
      close = vi.fn(async () => {});
      setMaxNumThreadForExec = mocks.threads;
      constructor() {
        mocks.connections.push(this);
      }
      async query() {
        return { getAll: async () => [], close: async () => {} };
      }
    },
  },
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  isReadOnlyDbError: () => false,
  loadFTSExtension: mocks.fts,
  loadVectorExtension: async () => false,
}));
vi.mock('../../src/core/lbug/lbug-config.js', async (original) => ({
  ...(await original<typeof import('../../src/core/lbug/lbug-config.js')>()),
  createLbugDatabase: mocks.create,
}));
import { closeLbug, initLbug, isLbugReady } from '../../src/core/lbug/pool-adapter.js';

let directory: string;
const options = { kind: 'vector' as const, bufferPoolBytes: 64 * 1024 * 1024, threads: 2 };
async function file(name: string) {
  const target = path.join(directory, name);
  await fs.writeFile(target, 'fixture');
  return target;
}
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.connections.length = 0;
  mocks.create.mockImplementation(() => ({
    init: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }));
  mocks.fts.mockResolvedValue(true);
  mocks.threads.mockResolvedValue(undefined);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-vector-pool-'));
});
afterEach(async () => {
  await closeLbug();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('vector pool isolation', () => {
  it('retains the graph-cache capacity while bounding vector residents independently', async () => {
    for (let i = 0; i < 5; i++) await initLbug(`graph-${i}`, await file(`graph-${i}`));
    for (let i = 0; i < 6; i++) await initLbug(`vector-${i}`, await file(`vector-${i}`), options);
    for (let i = 0; i < 5; i++) expect(isLbugReady(`graph-${i}`)).toBe(true);
    expect(isLbugReady('vector-0')).toBe(false);
    for (let i = 1; i < 6; i++) expect(isLbugReady(`vector-${i}`)).toBe(true);
    expect(mocks.fts).toHaveBeenCalledTimes(5);
    expect(mocks.threads).toHaveBeenCalledTimes(6 * 8);
    expect(mocks.create).toHaveBeenLastCalledWith(
      expect.anything(),
      path.join(directory, 'vector-5'),
      { readOnly: true, bufferPoolBytes: options.bufferPoolBytes },
    );
  });
  it('retains the actual reservation when its caller mutates an options object', async () => {
    const target = await file('vectors');
    const reservation = { ...options };
    await initLbug('vectors', target, reservation);
    reservation.bufferPoolBytes *= 2;
    await expect(initLbug('vectors', target, reservation)).rejects.toThrow(
      'different resource reservation',
    );
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('closes an incompletely initialized native handle and permits a clean retry', async () => {
    const target = await file('vectors');
    mocks.threads.mockRejectedValueOnce(new Error('thread configuration failed'));
    await expect(initLbug('vectors', target, options)).rejects.toThrow(
      'thread configuration failed',
    );
    expect(mocks.create.mock.results[0].value.close).toHaveBeenCalledOnce();
    expect(mocks.connections[0].close).toHaveBeenCalledOnce();
    await initLbug('vectors', target, options);
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it('refuses uncheckpointed vector files without quarantining their sidecars', async () => {
    const target = await file('vectors');
    await fs.writeFile(target + '.wal', 'pending writes');
    await expect(initLbug('vectors', target, options)).rejects.toThrow('unfinished native writes');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(await fs.readFile(target + '.wal', 'utf8')).toBe('pending writes');
  });
});
