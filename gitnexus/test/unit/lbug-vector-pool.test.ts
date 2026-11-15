import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  fts: vi.fn(),
  vector: vi.fn(),
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
  loadVectorExtension: mocks.vector,
}));
vi.mock('../../src/core/lbug/lbug-config.js', async (original) => ({
  ...(await original<typeof import('../../src/core/lbug/lbug-config.js')>()),
  createLbugDatabase: mocks.create,
}));
import {
  closeLbug,
  initLbug,
  isLbugReady,
  ensureVectorExtension,
} from '../../src/core/lbug/pool-adapter.js';

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
  mocks.vector.mockResolvedValue(false);
  mocks.threads.mockResolvedValue(undefined);
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-vector-pool-'));
});
afterEach(async () => {
  await closeLbug();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('vector pool isolation', () => {
  it('shares one native reservation across hard links until the last reader closes', async () => {
    const first = await file('first');
    const second = path.join(directory, 'second');
    await fs.link(first, second);
    await initLbug('first', first, options);
    await initLbug('second', second, options);
    expect(mocks.create).toHaveBeenCalledOnce();
    await ensureVectorExtension('first');
    await ensureVectorExtension('second');
    expect(mocks.vector).toHaveBeenCalledOnce();
    const database = mocks.create.mock.results[0].value;
    await closeLbug('first');
    expect(database.close).not.toHaveBeenCalled();
    expect(isLbugReady('second')).toBe(true);
    await closeLbug('second');
    expect(database.close).toHaveBeenCalledOnce();
    await initLbug('second', second, options);
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('keeps independent files separate even when their bytes match', async () => {
    await initLbug('first', await file('first'), options);
    await initLbug('second', await file('second'), options);
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('reopens a replaced vector path without closing a sibling on the previous inode', async () => {
    const first = await file('first');
    const second = path.join(directory, 'second');
    await fs.link(first, second);
    await initLbug('first', first, options);
    await initLbug('second', second, options);
    const original = mocks.create.mock.results[0].value;
    await fs.rename(await file('replacement'), second);
    expect(await initLbug('second', second, options)).toBe(true);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(original.close).not.toHaveBeenCalled();
    await closeLbug('first');
    expect(original.close).toHaveBeenCalledOnce();
    expect(isLbugReady('second')).toBe(true);
  });

  it('rejects a different reservation through another link to the same vectors', async () => {
    const first = await file('first');
    const second = path.join(directory, 'second');
    await fs.link(first, second);
    await initLbug('first', first, options);
    await expect(
      initLbug('second', second, { ...options, bufferPoolBytes: options.bufferPoolBytes * 2 }),
    ).rejects.toThrow('different resource reservation');
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('retains a shared native handle when another reader fails to initialize', async () => {
    const first = await file('first');
    const second = path.join(directory, 'second');
    await fs.link(first, second);
    await initLbug('first', first, options);
    const database = mocks.create.mock.results[0].value;
    mocks.threads.mockRejectedValueOnce(new Error('thread configuration failed'));
    await expect(initLbug('second', second, options)).rejects.toThrow(
      'thread configuration failed',
    );
    expect(database.close).not.toHaveBeenCalled();
    expect(isLbugReady('first')).toBe(true);
    await initLbug('second', second, options);
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('validates a new link before reusing an already open native handle', async () => {
    const first = await file('first');
    const second = path.join(directory, 'second');
    await fs.link(first, second);
    await initLbug('first', first, options);
    await fs.writeFile(second + '.wal', 'unfinished');
    await expect(initLbug('second', second, options)).rejects.toThrow('unfinished native writes');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(isLbugReady('first')).toBe(true);
    expect(await fs.readFile(second + '.wal', 'utf8')).toBe('unfinished');
  });

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
