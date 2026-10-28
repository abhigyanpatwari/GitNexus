/**
 * #3696 — native-memory guard for read queries. Driven entirely through
 * injected deps: no real timers, RSS, or process exit.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createQueryMemoryGuard,
  formatBreachMessage,
  queryLabel,
  parsePhysFootprintBytes,
  resolveQueryRssBudgetBytes,
  FOOTPRINT_INTERVAL_MS,
  QUERY_MAX_RSS_ENV,
  QUERY_TRACE_ENV,
  type QueryMemoryGuardDeps,
} from '../../src/core/lbug/query-memory-guard.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function harness(
  env: Record<string, string> = {},
  totalMem = 64 * GIB,
  readFootprint?: () => Promise<number | null>,
) {
  let rss = 500 * MIB;
  let now = 1_000;
  let tick: (() => void) | null = null;
  const stop = vi.fn(() => {
    tick = null;
  });
  const deps: QueryMemoryGuardDeps = {
    readRss: () => rss,
    ...(readFootprint ? { readFootprint } : {}),
    env: () => env,
    totalMem: () => totalMem,
    now: () => now,
    writeStderr: vi.fn(),
    onBreach: vi.fn(),
    startSampler: vi.fn((t: () => void) => {
      tick = t;
      return stop;
    }),
  };
  const guard = createQueryMemoryGuard(deps);
  return {
    guard,
    deps,
    stop,
    setRss: (mb: number) => {
      rss = mb * MIB;
    },
    advance: (ms: number) => {
      now += ms;
    },
    tick: () => tick?.(),
    samplerRunning: () => tick !== null,
  };
}

describe('resolveQueryRssBudgetBytes', () => {
  it('defaults to 25% of RAM', () => {
    expect(resolveQueryRssBudgetBytes(undefined, 64 * GIB)).toBe(16 * GIB);
  });

  it('never defaults below 8 GiB, leaving room for the read pool page cache', () => {
    expect(resolveQueryRssBudgetBytes(undefined, 16 * GIB)).toBe(8 * GIB);
  });

  it('honours an explicit MiB value', () => {
    expect(resolveQueryRssBudgetBytes('2048', 64 * GIB)).toBe(2 * GIB);
    expect(resolveQueryRssBudgetBytes(' 1.5 ', 64 * GIB)).toBe(Math.floor(1.5 * MIB));
  });

  it('treats 0 as disabled', () => {
    expect(resolveQueryRssBudgetBytes('0', 64 * GIB)).toBeNull();
  });

  it('falls back to the default for unparseable or negative values', () => {
    for (const raw of ['', '   ', 'all', '10junk', '-5', 'NaN', 'Infinity']) {
      expect(resolveQueryRssBudgetBytes(raw, 64 * GIB)).toBe(16 * GIB);
    }
  });

  it('rejects overflowing and sub-byte budgets', () => {
    for (const raw of ['1e308', '1e-20']) {
      expect(resolveQueryRssBudgetBytes(raw, 64 * GIB)).toBe(16 * GIB);
    }
  });

  it('leaves headroom on small hosts and constrained runtimes', () => {
    expect(resolveQueryRssBudgetBytes(undefined, 8 * GIB)).toBe(6 * GIB);
    expect(resolveQueryRssBudgetBytes(undefined, 2 * GIB)).toBe(1.5 * GIB);
  });
});

describe('queryLabel', () => {
  it('flattens whitespace and bounds length', () => {
    expect(queryLabel('MATCH (n)\n   WHERE n.id = $id\n RETURN n')).toBe(
      'MATCH (n) WHERE n.id = $id RETURN n',
    );
    const long = queryLabel(`MATCH ${'x'.repeat(500)}`);
    expect(long.length).toBe(201);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('createQueryMemoryGuard', () => {
  it('checks the budget before starting even a short query', () => {
    const h = harness({ [QUERY_MAX_RSS_ENV]: '1000' });
    h.setRss(1500);
    h.guard.begin('RETURN 1');
    expect(h.deps.onBreach).toHaveBeenCalledTimes(1);
  });

  it('checks memory growth when a query ends between sampler ticks', () => {
    const h = harness({ [QUERY_MAX_RSS_ENV]: '1000' });
    const t = h.guard.begin('RETURN 1');
    h.setRss(1500);
    h.guard.end(t, 1);
    expect(h.deps.onBreach).toHaveBeenCalledTimes(1);
  });

  it('reports a breach with every running query once RSS passes the budget', () => {
    const h = harness({ [QUERY_MAX_RSS_ENV]: '1000' });
    h.guard.begin('MATCH (caller)-[r]->(n) RETURN caller');
    h.guard.begin('MATCH (s)-[r]->(p:Process) RETURN p');
    expect(h.samplerRunning()).toBe(true);

    h.setRss(900);
    h.tick();
    expect(h.deps.onBreach).not.toHaveBeenCalled();

    h.setRss(1500);
    h.tick();
    expect(h.deps.onBreach).toHaveBeenCalledTimes(1);
    expect(h.deps.onBreach).toHaveBeenCalledWith({
      rssBytes: 1500 * MIB,
      budgetBytes: 1000 * MIB,
      activeLabels: [
        'MATCH (caller)-[r]->(n) RETURN caller',
        'MATCH (s)-[r]->(p:Process) RETURN p',
      ],
    });

    // Only once, even if the exit is slow to take effect.
    h.tick();
    expect(h.deps.onBreach).toHaveBeenCalledTimes(1);
  });

  it('does not sample between queries', () => {
    const h = harness({ [QUERY_MAX_RSS_ENV]: '1000' });
    const t = h.guard.begin('RETURN 1');
    h.guard.end(t, 1);
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.samplerRunning()).toBe(false);

    // RSS held by something else while no query runs is not this guard's call.
    h.setRss(5000);
    h.guard.sample();
    expect(h.deps.onBreach).not.toHaveBeenCalled();
  });

  it('keeps sampling until the last concurrent query ends', () => {
    const h = harness({ [QUERY_MAX_RSS_ENV]: '1000' });
    const a = h.guard.begin('A');
    const b = h.guard.begin('B');
    expect(h.deps.startSampler).toHaveBeenCalledTimes(1);
    h.guard.end(a);
    expect(h.samplerRunning()).toBe(true);
    h.guard.end(b);
    expect(h.samplerRunning()).toBe(false);
  });

  it('starts no sampler when disabled and not tracing', () => {
    const h = harness({ [QUERY_MAX_RSS_ENV]: '0' });
    const t = h.guard.begin('RETURN 1');
    expect(h.deps.startSampler).not.toHaveBeenCalled();
    h.setRss(100_000);
    h.guard.sample();
    h.guard.end(t);
    expect(h.deps.onBreach).not.toHaveBeenCalled();
    expect(h.deps.writeStderr).not.toHaveBeenCalled();
  });

  it('is on by default with no environment set', () => {
    const h = harness({}, 16 * GIB);
    h.guard.begin('RETURN 1');
    h.setRss(8 * 1024);
    h.tick();
    expect(h.deps.onBreach).not.toHaveBeenCalled();
    h.setRss(8 * 1024 + 1);
    h.tick();
    expect(h.deps.onBreach).toHaveBeenCalledTimes(1);
  });

  it('writes one trace line per query with start, peak and end RSS', () => {
    const h = harness({ [QUERY_MAX_RSS_ENV]: '0', [QUERY_TRACE_ENV]: '1' });
    const t = h.guard.begin('MATCH (n)\n RETURN n');
    expect(h.samplerRunning()).toBe(true);
    h.setRss(2000);
    h.tick();
    h.setRss(700);
    h.advance(42);
    h.guard.end(t, 7);
    expect(h.deps.writeStderr).toHaveBeenCalledWith(
      '[query-trace] ms=42 rows=7 memStartMB=500 memPeakMB=2000 rssEndMB=700 active=0 q="MATCH (n) RETURN n"\n',
    );
  });

  it('ignores an unknown or already-ended token', () => {
    const h = harness({ [QUERY_TRACE_ENV]: '1' });
    const t = h.guard.begin('RETURN 1');
    h.guard.end(t);
    h.guard.end(t);
    h.guard.end({});
    expect(h.deps.writeStderr).toHaveBeenCalledTimes(1);
  });
});

describe('createQueryMemoryGuard: physical footprint (macOS)', () => {
  const flush = () => new Promise((r) => setImmediate(r));

  it('never reads the footprint for a short query', async () => {
    const readFootprint = vi.fn(async () => 50 * GIB);
    const h = harness({ [QUERY_MAX_RSS_ENV]: '1000' }, 64 * GIB, readFootprint);
    const t = h.guard.begin('RETURN 1');
    h.advance(FOOTPRINT_INTERVAL_MS - 1);
    h.tick();
    h.guard.end(t);
    await flush();
    expect(readFootprint).not.toHaveBeenCalled();
    expect(h.deps.onBreach).not.toHaveBeenCalled();
  });

  it('breaches on the footprint while RSS stays low (compressed pages)', async () => {
    const readFootprint = vi.fn(async () => 3 * GIB);
    const h = harness({ [QUERY_MAX_RSS_ENV]: '1000' }, 64 * GIB, readFootprint);
    h.guard.begin('MATCH (a), (b) RETURN a, b');
    h.setRss(300);
    h.advance(FOOTPRINT_INTERVAL_MS);
    h.tick();
    expect(readFootprint).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.deps.onBreach).toHaveBeenCalledWith({
      rssBytes: 3 * GIB,
      budgetBytes: 1000 * MIB,
      activeLabels: ['MATCH (a), (b) RETURN a, b'],
    });
  });

  it('reads at most once per interval and never overlaps reads', async () => {
    let release: (v: number) => void = () => {};
    const readFootprint = vi.fn(
      () => new Promise<number | null>((r) => (release = r as (v: number) => void)),
    );
    const h = harness({ [QUERY_MAX_RSS_ENV]: '1000' }, 64 * GIB, readFootprint);
    h.guard.begin('Q');
    h.advance(FOOTPRINT_INTERVAL_MS);
    h.tick();
    expect(readFootprint).toHaveBeenCalledTimes(1);
    release(600 * MIB);
    await flush();

    // Interval: measured from the start of the previous read.
    h.advance(FOOTPRINT_INTERVAL_MS - 1);
    h.tick();
    expect(readFootprint).toHaveBeenCalledTimes(1);
    h.advance(1);
    h.tick();
    expect(readFootprint).toHaveBeenCalledTimes(2);

    // Overlap: a read still in flight blocks the next one, however long it takes.
    h.advance(5 * FOOTPRINT_INTERVAL_MS);
    h.tick();
    expect(readFootprint).toHaveBeenCalledTimes(2);
    release(600 * MIB);
    await flush();
    h.tick();
    expect(readFootprint).toHaveBeenCalledTimes(3);
  });

  it('ignores a footprint that resolves after the query ended', async () => {
    let release: (v: number) => void = () => {};
    const readFootprint = vi.fn(
      () => new Promise<number | null>((r) => (release = r as (v: number) => void)),
    );
    const h = harness({ [QUERY_MAX_RSS_ENV]: '1000' }, 64 * GIB, readFootprint);
    const t = h.guard.begin('Q');
    h.advance(FOOTPRINT_INTERVAL_MS);
    h.tick();
    h.guard.end(t);
    release(50 * GIB);
    await flush();
    expect(h.deps.onBreach).not.toHaveBeenCalled();
  });

  it('does not charge a stale footprint to a later query', async () => {
    let release!: (bytes: number | null) => void;
    const pending = new Promise<number | null>((resolve) => {
      release = resolve;
    });
    const h = harness({ [QUERY_MAX_RSS_ENV]: '1000' }, 64 * GIB, () => pending);
    const old = h.guard.begin('old');
    h.advance(FOOTPRINT_INTERVAL_MS);
    h.tick();
    h.guard.end(old);
    const next = h.guard.begin('next');
    release(50 * GIB);
    await flush();
    expect(h.deps.onBreach).not.toHaveBeenCalled();
    h.guard.end(next);
  });

  it('retains a footprint while a query present at sampling still runs', async () => {
    let release!: (bytes: number | null) => void;
    const pending = new Promise<number | null>((resolve) => {
      release = resolve;
    });
    const h = harness({ [QUERY_MAX_RSS_ENV]: '1000' }, 64 * GIB, () => pending);
    const first = h.guard.begin('first');
    const second = h.guard.begin('second');
    h.advance(FOOTPRINT_INTERVAL_MS);
    h.tick();
    h.guard.end(first);
    release(50 * GIB);
    await flush();
    expect(h.deps.onBreach).toHaveBeenCalledTimes(1);
    h.guard.end(second);
  });

  it('treats an unavailable footprint as no signal', async () => {
    const readFootprint = vi.fn(async () => null);
    const h = harness({ [QUERY_MAX_RSS_ENV]: '1000' }, 64 * GIB, readFootprint);
    h.guard.begin('Q');
    h.advance(FOOTPRINT_INTERVAL_MS);
    h.tick();
    await flush();
    expect(h.deps.onBreach).not.toHaveBeenCalled();
  });
});

describe('parsePhysFootprintBytes', () => {
  it('reads the byte count from `footprint -f bytes` output', () => {
    const out =
      'node [123]: 64-bit    Footprint: 2474344 B (16384 bytes per page)\n' +
      '    phys_footprint: 2474344 B\n    phys_footprint_peak: 9000000 B\n';
    expect(parsePhysFootprintBytes(out)).toBe(2474344);
  });

  it('returns null for unexpected output', () => {
    expect(parsePhysFootprintBytes('')).toBeNull();
    expect(parsePhysFootprintBytes('phys_footprint: 11 MB')).toBeNull();
  });
});

describe('formatBreachMessage', () => {
  it('names the limit, the running queries and how to change it', () => {
    const msg = formatBreachMessage({
      rssBytes: 17 * GIB,
      budgetBytes: 16 * GIB,
      activeLabels: ['MATCH (a) RETURN a'],
    });
    expect(msg).toContain('17.0 GB');
    expect(msg).toContain('16.0 GB limit');
    expect(msg).toContain('  - MATCH (a) RETURN a');
    expect(msg).toContain(`${QUERY_MAX_RSS_ENV}=<MiB>`);
    expect(msg).toContain('#3696');
  });
});
