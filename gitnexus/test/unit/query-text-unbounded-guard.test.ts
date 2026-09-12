/**
 * The #2915 backstop: a query whose TEXT grew with a caller-sized list names
 * itself instead of dying in the engine's recursive evaluator with no message.
 *
 * Covers the helper's own contract and both wiring points — `executePrepared` /
 * `streamQuery` in `lbug-adapter.ts` (pino `logger`) and `executeParameterized`
 * in `pool-adapter.ts` (the module's `realStderrWrite` sidecar logger). Both
 * adapters run the guard BEFORE their "not initialized" throw, so the wiring is
 * observable without a real LadybugDB.
 */
import { describe, expect, it, vi } from 'vitest';

const { stderrWriteMock } = vi.hoisted(() => ({ stderrWriteMock: vi.fn() }));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: vi.fn(),
    Connection: vi.fn(),
  },
}));

vi.mock('../../src/mcp/stdio-capture.js', () => ({
  realStdoutWrite: vi.fn(),
  realStderrWrite: stderrWriteMock,
  setActiveStdoutWrite: vi.fn(),
  getActiveStdoutWrite: vi.fn(() => vi.fn()),
}));

import { warnIfQueryTextUnbounded } from '../../src/core/lbug/query-batch.js';
import { _captureLogger } from '../../src/core/logger.js';
import { executeParameterized, executeQuery } from '../../src/core/lbug/pool-adapter.js';
import { executePrepared, streamQuery } from '../../src/core/lbug/lbug-adapter.js';

/**
 * Comfortably over the 64 KB ceiling, in the exact shape the guard exists to
 * catch: a caller-sized id list spliced into the query TEXT.
 */
const OVERSIZED_CYPHER = `MATCH (n) WHERE n.id IN [${Array.from(
  { length: 5000 },
  (_unused, index) => `'symbol_${String(index).padStart(8, '0')}'`,
).join(', ')}] RETURN n`;

/** A realistic query — the repo's largest legitimate ones are under 8 KB. */
const NORMAL_CYPHER = 'MATCH (n:Function) WHERE n.filePath = $path RETURN n LIMIT 100';

/** Warnings the pool's sidecar logger wrote, as plain strings. */
const stderrWarnings = (): string[] =>
  stderrWriteMock.mock.calls.map((call) => String(call[0] as unknown));

describe('warnIfQueryTextUnbounded (#2915)', () => {
  it('has fixtures on the intended sides of the 64 KB ceiling', () => {
    expect(OVERSIZED_CYPHER.length).toBeGreaterThan(64 * 1024);
    expect(NORMAL_CYPHER.length).toBeLessThan(64 * 1024);
  });

  it('warns exactly once for query text over the ceiling', () => {
    const warn = vi.fn();
    warnIfQueryTextUnbounded(OVERSIZED_CYPHER, 'test context', warn);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('test context');
    expect(String(warn.mock.calls[0][0])).toContain('#2915');
  });

  it('stays silent for a normal query', () => {
    const warn = vi.fn();
    warnIfQueryTextUnbounded(NORMAL_CYPHER, 'test context', warn);

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent exactly at the ceiling and warns one byte past it', () => {
    const atCeiling = vi.fn();
    warnIfQueryTextUnbounded('x'.repeat(64 * 1024), 'test context', atCeiling);
    expect(atCeiling).not.toHaveBeenCalled();

    const pastCeiling = vi.fn();
    warnIfQueryTextUnbounded('x'.repeat(64 * 1024 + 1), 'test context', pastCeiling);
    expect(pastCeiling).toHaveBeenCalledTimes(1);
  });

  it('measures BYTES, so multi-byte text over the ceiling is not waved through', () => {
    // The case a `cypher.length` comparison got wrong: 30,000 CJK characters are
    // 30,000 UTF-16 code units — comfortably under a 65,536 ceiling — but 90,000
    // UTF-8 bytes, which is what the engine actually parses. The reported figure
    // has to be the byte figure too, or the warning understates by 3x (88 KB of
    // query text reported as 29 KB).
    const cjk = '中'.repeat(30_000);
    expect(cjk.length).toBeLessThan(64 * 1024);
    expect(Buffer.byteLength(cjk, 'utf8')).toBe(90_000);

    const warn = vi.fn();
    const byteLength = vi.spyOn(Buffer, 'byteLength');
    warnIfQueryTextUnbounded(cjk, 'test context', warn);
    // `mockRestore()` clears the call history, so read it first — and restore
    // before asserting, so a failure never leaks the spy into another test.
    const byteCountCalls = byteLength.mock.calls.length;
    byteLength.mockRestore();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('88 KB');
    // Text this long is exactly what the early return is meant to let through
    // to the byte count.
    expect(byteCountCalls).toBe(1);
  });

  it('skips the byte count for text too short to reach the ceiling', () => {
    // The guard runs on EVERY read query, so the common case must not pay for a
    // `Buffer.byteLength` scan. What makes skipping safe is that UTF-8 never
    // needs more than 3 bytes per UTF-16 code unit — a 3-byte BMP character is
    // the densest there is (an astral one costs 4 bytes across 2 units). This
    // fixture is the LONGEST text the early return lets through, made entirely
    // of those densest characters: even so it lands under the ceiling, so
    // nothing the byte count would have flagged is ever waved past.
    const dense = '中'.repeat(Math.floor((64 * 1024) / 3));
    expect(dense.length * 3).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(dense, 'utf8')).toBeLessThanOrEqual(64 * 1024);

    const warn = vi.fn();
    const byteLength = vi.spyOn(Buffer, 'byteLength');
    warnIfQueryTextUnbounded(dense, 'test context', warn);
    const byteCountCalls = byteLength.mock.calls.length;
    byteLength.mockRestore();

    expect(warn).not.toHaveBeenCalled();
    expect(byteCountCalls).toBe(0);
  });
});

describe('#2915 guard wired into lbug-adapter', () => {
  it('executePrepared warns once on oversized text', async () => {
    const capture = _captureLogger();
    const rejected = await executePrepared(OVERSIZED_CYPHER, {}).catch((err: unknown) => err);
    const records = capture.records();
    capture.restore();

    expect(String(rejected)).toContain('not initialized');
    expect(
      records.map((record) => String(record.msg)).filter((msg) => msg.includes('#2915')),
    ).toEqual([expect.stringContaining('executePrepared')]);
  });

  it('executePrepared stays silent on a normal query', async () => {
    const capture = _captureLogger();
    const rejected = await executePrepared(NORMAL_CYPHER, {}).catch((err: unknown) => err);
    const records = capture.records();
    capture.restore();

    expect(String(rejected)).toContain('not initialized');
    expect(
      records.map((record) => String(record.msg)).filter((msg) => msg.includes('#2915')),
    ).toEqual([]);
  });

  it('streamQuery warns once on oversized text', async () => {
    const capture = _captureLogger();
    const rejected = await streamQuery(OVERSIZED_CYPHER, () => {}).catch((err: unknown) => err);
    const records = capture.records();
    capture.restore();

    expect(String(rejected)).toContain('not initialized');
    expect(
      records.map((record) => String(record.msg)).filter((msg) => msg.includes('#2915')),
    ).toEqual([expect.stringContaining('streamQuery')]);
  });
});

describe('#2915 guard wired into pool-adapter', () => {
  it('executeParameterized warns once on oversized text', async () => {
    stderrWriteMock.mockClear();
    const rejected = await executeParameterized('unindexed-repo', OVERSIZED_CYPHER, {}).catch(
      (err: unknown) => err,
    );

    expect(String(rejected)).toContain('not initialized');
    expect(stderrWarnings()).toEqual([expect.stringContaining('pool executeParameterized')]);
  });

  it('executeParameterized stays silent on a normal query', async () => {
    stderrWriteMock.mockClear();
    const rejected = await executeParameterized('unindexed-repo', NORMAL_CYPHER, {}).catch(
      (err: unknown) => err,
    );

    expect(String(rejected)).toContain('not initialized');
    expect(stderrWarnings()).toEqual([]);
  });

  it('executeQuery warns once, not twice, through its delegation', async () => {
    stderrWriteMock.mockClear();
    const rejected = await executeQuery('unindexed-repo', OVERSIZED_CYPHER).catch(
      (err: unknown) => err,
    );

    expect(String(rejected)).toContain('not initialized');
    expect(stderrWarnings()).toHaveLength(1);
  });
});
