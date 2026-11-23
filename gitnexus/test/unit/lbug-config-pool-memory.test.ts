import os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLbugDatabase,
  defaultReadPoolBytes,
  estimateBufferPool,
  getEffectiveBufferPoolSize,
  readBufferPoolExhaustionRemedy,
  setBufferPoolSizeHint,
  _setOsPageSizeForTests,
} from '../../src/core/lbug/lbug-config.js';
import { effectiveRamBytes } from '../../src/core/ingestion/utils/effective-ram.js';
import {
  QUERY_MAX_RSS_ENV,
  resolveQueryRssBudgetBytes,
} from '../../src/core/lbug/query-memory-guard.js';
import { _captureLogger } from '../../src/core/logger.js';

// The default LadybugDB buffer pool is sized from effective memory (a real
// cgroup limit when it is smaller than physical RAM), so a process in a small
// container on a large node does not get a pool sized for the node. Read-only
// opens are further kept under the read query memory budget; writable opens
// (bridge writes, FTS repair, WAL replay) are outside that guard and are not.

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const HOST = 64 * GiB;
/** cgroup v1 reports "no limit" as LONG_MAX rounded down to the page size. */
const CGROUP_V1_UNLIMITED = 2 ** 63 - 4096;

const setConstrainedMemory = (value: number | undefined): (() => void) => {
  const desc = Object.getOwnPropertyDescriptor(process, 'constrainedMemory');
  if (value === undefined) delete (process as { constrainedMemory?: unknown }).constrainedMemory;
  else
    Object.defineProperty(process, 'constrainedMemory', { configurable: true, value: () => value });
  return () => {
    if (desc) Object.defineProperty(process, 'constrainedMemory', desc);
    else delete (process as { constrainedMemory?: unknown }).constrainedMemory;
  };
};

const defaultBudget = (ram: number): number => resolveQueryRssBudgetBytes(undefined, ram) ?? 0;

describe('default buffer pool under container memory limits', () => {
  let restoreConstrained: (() => void) | undefined;

  const hintlessPool = (readOnly: boolean): number => {
    const Database = vi.fn(function (this: unknown) {});
    createLbugDatabase(
      { Database } as unknown as Parameters<typeof createLbugDatabase>[0],
      '/tmp/lbug-pool-memory',
      { readOnly },
    );
    return (Database.mock.calls[0] as unknown[])[1] as number;
  };
  const readerPool = (): number => hintlessPool(true);
  const writerPool = (): number => hintlessPool(false);

  const runOn = (totalmem: number, constrained: number | undefined): void => {
    vi.spyOn(os, 'totalmem').mockReturnValue(totalmem);
    restoreConstrained = setConstrainedMemory(constrained);
  };

  beforeEach(() => {
    _setOsPageSizeForTests(4096);
    vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', undefined);
    vi.stubEnv(QUERY_MAX_RSS_ENV, undefined);
  });

  afterEach(() => {
    restoreConstrained?.();
    restoreConstrained = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setBufferPoolSizeHint(undefined);
    _setOsPageSizeForTests(undefined);
  });

  it.each([
    ['256 MiB', 256 * MiB, 64 * MiB],
    ['512 MiB', 512 * MiB, 128 * MiB],
    ['1 GiB', GiB, 384 * MiB],
    ['2 GiB', 2 * GiB, 768 * MiB],
    ['3 GiB', 3 * GiB, 1280 * MiB],
    ['4 GiB', 4 * GiB, 2 * GiB],
    ['8 GiB', 8 * GiB, 2 * GiB],
    ['64 GiB', 64 * GiB, 2 * GiB],
  ])('defaultReadPoolBytes for %s of effective memory', (_label, ram, expected) => {
    expect(defaultReadPoolBytes(ram, defaultBudget(ram))).toBe(expected);
  });

  it('a read-only open in a 1 GiB container on a large node gets a pool well under the query memory budget', () => {
    runOn(HOST, GiB);
    const pool = readerPool();
    expect(pool).toBe(384 * MiB);
    expect(pool).toBeLessThanOrEqual(defaultBudget(GiB) - 256 * MiB);
    expect(getEffectiveBufferPoolSize('read')).toBe(pool);
  });

  it('a writable open in a 1 GiB container gets 80% of the container, not the read budget', () => {
    runOn(HOST, GiB);
    const pool = writerPool();
    expect(pool).toBe(Math.floor(0.8 * GiB));
    expect(getEffectiveBufferPoolSize()).toBe(pool);
    expect(getEffectiveBufferPoolSize('write')).toBe(pool);
  });

  it(`${QUERY_MAX_RSS_ENV} does not shrink a writable open`, () => {
    runOn(HOST, GiB);
    vi.stubEnv(QUERY_MAX_RSS_ENV, '512');
    expect(writerPool()).toBe(Math.floor(0.8 * GiB));
    expect(readerPool()).toBe(256 * MiB);
  });

  it.each([
    ['4 GiB', 4 * GiB, 2 * GiB, 2 * GiB],
    ['2 GiB', 2 * GiB, 768 * MiB, Math.floor(0.8 * 2 * GiB)],
  ])('a %s container on a large node', (_label, limit, reader, writer) => {
    runOn(HOST, limit);
    expect(readerPool()).toBe(reader);
    expect(writerPool()).toBe(writer);
  });

  it.each([
    ['returns 0', 0],
    ['is unavailable', undefined],
    ['reports the cgroup v1 "unlimited" sentinel', CGROUP_V1_UNLIMITED],
    ['reports UINT64_MAX', 2 ** 64],
  ])('keeps the 2 GiB default on a large host when constrainedMemory %s', (_label, value) => {
    runOn(HOST, value);
    expect(readerPool()).toBe(2 * GiB);
    expect(writerPool()).toBe(2 * GiB);
  });

  it('ignores a limit above physical RAM', () => {
    runOn(8 * GiB, 16 * GiB);
    expect(readerPool()).toBe(2 * GiB);
    expect(writerPool()).toBe(2 * GiB);
  });

  it.each([
    ['256 MiB', 256 * MiB, 64 * MiB],
    ['512 MiB', 512 * MiB, 128 * MiB],
  ])(
    'a read-only open in a tiny %s container keeps at least the 64 MiB floor',
    (_label, limit, expected) => {
      runOn(HOST, limit);
      expect(readerPool()).toBe(expected);
    },
  );

  it.each([
    ['1073741824', 1073741824],
    ['0', 0],
  ])('GITNEXUS_LBUG_BUFFER_POOL_SIZE=%s still wins in a 1 GiB container', (raw, expected) => {
    runOn(HOST, GiB);
    vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', raw);
    expect(readerPool()).toBe(expected);
    expect(writerPool()).toBe(expected);
    expect(getEffectiveBufferPoolSize('read')).toBe(expected);
    expect(getEffectiveBufferPoolSize()).toBe(expected);
  });

  it('an invalid GITNEXUS_LBUG_BUFFER_POOL_SIZE warns and falls back to the container-aware default', () => {
    const cap = _captureLogger();
    try {
      runOn(HOST, GiB);
      vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', 'abc');
      expect(readerPool()).toBe(384 * MiB);
      expect(writerPool()).toBe(Math.floor(0.8 * GiB));
      const warn = cap
        .records()
        .find(
          (r) =>
            typeof r.msg === 'string' &&
            r.msg.includes('Ignoring invalid GITNEXUS_LBUG_BUFFER_POOL_SIZE'),
        );
      expect(warn).toBeDefined();
    } finally {
      cap.restore();
    }
  });

  it.each([
    ['512', 256 * MiB],
    [' 512 ', 256 * MiB],
    ['0', 384 * MiB],
    ['4096', Math.floor(0.8 * GiB)],
    // Values the guard rejects fall back to its default budget.
    ['abc', 384 * MiB],
    ['-5', 384 * MiB],
    ['   ', 384 * MiB],
    // A fractional MiB is a real (tiny) budget for the guard; the pool floor wins.
    ['0.5', 64 * MiB],
  ])(
    `follows ${QUERY_MAX_RSS_ENV}=%j in a 1 GiB container (0 disables the guard, not the sizing)`,
    (raw, expected) => {
      runOn(HOST, GiB);
      vi.stubEnv(QUERY_MAX_RSS_ENV, raw);
      expect(readerPool()).toBe(expected);
    },
  );

  it.each([
    ['a 1 GiB container', HOST, GiB],
    ['no limit', HOST, 0],
    ['a limit above RAM', 8 * GiB, 16 * GiB],
    ['the cgroup v1 sentinel', HOST, CGROUP_V1_UNLIMITED],
    ['UINT64_MAX', HOST, 2 ** 64],
  ])('sizes from min(physical RAM, a real container limit): %s', (_label, total, limit) => {
    runOn(total, limit);
    // The query guard documents the same rule for its budget. It has no
    // exported seam for its own memory reading, so this pins the rule, not the
    // guard's implementation.
    const availableRam = Math.min(
      os.totalmem(),
      process.constrainedMemory() || Number.POSITIVE_INFINITY,
    );
    expect(effectiveRamBytes()).toBe(availableRam);
  });

  it('bounds the analyze hint by 80% of the container limit', () => {
    runOn(HOST, GiB);
    expect(estimateBufferPool(10_000_000)).toBe(Math.floor(0.8 * GiB));
    setBufferPoolSizeHint(8 * GiB);
    expect(writerPool()).toBe(Math.floor(0.8 * GiB));
  });

  it('lets the analyze cap win over the COPY floor in a 256 MiB container', () => {
    runOn(HOST, 256 * MiB);
    expect(estimateBufferPool(41)).toBe(Math.floor(0.8 * 256 * MiB));
  });

  it('keeps the hintless defaults unscaled on 64 KiB pages in a 1 GiB container', () => {
    runOn(HOST, GiB);
    _setOsPageSizeForTests(65536);
    expect(readerPool()).toBe(384 * MiB);
    expect(writerPool()).toBe(Math.floor(0.8 * GiB));
    expect(estimateBufferPool(41, 65536)).toBe(Math.floor(0.8 * GiB));
  });

  it('keeps a read-only pool at least 256 MiB under the default query budget for every container from 768 MiB to 4 GiB', () => {
    const totalmem = vi.spyOn(os, 'totalmem').mockReturnValue(HOST);
    for (let limit = 768 * MiB; limit <= 4 * GiB; limit += 64 * MiB) {
      restoreConstrained = setConstrainedMemory(limit);
      expect(getEffectiveBufferPoolSize('read'), `limit ${limit / MiB} MiB`).toBeLessThanOrEqual(
        defaultBudget(limit) - 256 * MiB,
      );
      restoreConstrained();
      restoreConstrained = undefined;
    }
    restoreConstrained = setConstrainedMemory(0);
    for (let ram = 4 * GiB; ram <= 64 * GiB; ram += 4 * GiB) {
      totalmem.mockReturnValue(ram);
      const legacy = Math.min(2 * GiB, Math.floor(0.8 * ram));
      expect(getEffectiveBufferPoolSize('read'), `host ${ram / GiB} GiB`).toBe(legacy);
      expect(getEffectiveBufferPoolSize('write'), `host ${ram / GiB} GiB`).toBe(legacy);
    }
  });

  it('names GITNEXUS_LBUG_BUFFER_POOL_SIZE for read-path pool exhaustion and ignores other errors', () => {
    runOn(HOST, GiB);
    const remedy = readBufferPoolExhaustionRemedy(
      'Buffer manager exception: Unable to allocate memory! The buffer pool is full and no memory could be freed!',
    );
    expect(remedy).toContain('384 MiB');
    expect(remedy).toContain('GITNEXUS_LBUG_BUFFER_POOL_SIZE');
    expect(remedy).toContain(QUERY_MAX_RSS_ENV);
    expect(readBufferPoolExhaustionRemedy('Could not set lock on file')).toBeUndefined();
  });
});
