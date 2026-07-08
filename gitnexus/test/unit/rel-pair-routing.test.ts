import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { RelPairRouter, getNodeLabel } from '../../src/core/lbug/rel-pair-routing.js';

/**
 * Unit tests for RelPairRouter (#2203 U2) — the production per-pair emit path.
 *
 * Mirrors test/unit/rel-csv-split.test.ts: drives the router with an injected
 * mock WriteStream factory so the error, backpressure, and teardown paths are
 * exercised without LadybugDB or real disk streams. These paths are otherwise
 * unreachable in the integration suite (which only hits the no-backpressure
 * happy path), so this is the coverage for the router's failure modes.
 */

// Controllable backpressure + error injection (same shape as the split oracle's mock).
class MockWriteStream extends EventEmitter {
  public chunks: string[] = [];
  public destroyed = false;
  public ended = false;
  public blocked = false;
  public maxDrainListenersSeen = 0;
  // State flags + events so `stream/promises.finished(ws)` (used by the
  // router's close()) resolves against this mock instead of hanging.
  public writable = true;
  public writableEnded = false;
  public writableFinished = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    const count = this.listenerCount('drain');
    if (count > this.maxDrainListenersSeen) this.maxDrainListenersSeen = count;
    return !this.blocked;
  }

  end(cb?: (err?: Error) => void): this {
    this.ended = true;
    this.writableEnded = true;
    this.writableFinished = true;
    this.writable = false;
    if (cb) cb();
    queueMicrotask(() => {
      this.emit('finish');
      this.emit('close');
    });
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  unblock(): void {
    this.blocked = false;
    this.emit('drain');
  }

  triggerError(err: Error): void {
    this.emit('error', err);
  }
}

const HEADER = '"from","to","type","confidence","reason","step"';
const VALID = new Set<string>(['File', 'Function', 'Community', 'Process']);

const row = (from: string, to: string, type = 'CALLS'): string =>
  `"${from}","${to}","${type}",1.0,"auto",0`;

function mockFactory(streams: MockWriteStream[], opts?: { blocked?: boolean }) {
  return (() => {
    const ws = new MockWriteStream();
    if (opts?.blocked) ws.blocked = true;
    streams.push(ws);
    return ws;
  }) as unknown as (filePath: string) => import('fs').WriteStream;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-pair-routing-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('getNodeLabel', () => {
  it('maps comm_/proc_ prefixes and otherwise splits on the first colon', () => {
    expect(getNodeLabel('comm_42')).toBe('Community');
    expect(getNodeLabel('proc_7')).toBe('Process');
    expect(getNodeLabel('Function:src/a.ts:f:1')).toBe('Function');
    expect(getNodeLabel('File:src/a.ts')).toBe('File');
  });
});

describe('RelPairRouter', () => {
  it('routes valid edges to per-pair files (header first) and skips invalid-label edges', async () => {
    const streams: MockWriteStream[] = [];
    const router = new RelPairRouter(tmpDir, HEADER, VALID, mockFactory(streams));

    const route = async (from: string, to: string) => {
      const p = router.route(from, to, row(from, to));
      if (p) await p;
    };
    await route('File:a', 'Function:a:f:1');
    await route('File:a', 'Function:a:g:2'); // same pair
    await route('Function:a:f:1', 'Function:a:g:2'); // different pair
    await route('Bogus:x', 'File:a'); // invalid FROM label → skipped
    await route('File:a', 'Bogus:y'); // invalid TO label → skipped (other branch)
    await router.close();

    expect(router.skipped).toBe(2);
    expect(router.total).toBe(3);
    expect([...router.byPair.keys()].sort()).toEqual(['File|Function', 'Function|Function']);
    expect(router.byPair.get('File|Function')!.rows).toBe(2);
    // Header is the first chunk written to each pair stream.
    expect(streams[0].chunks[0]).toBe(HEADER + '\n');
    expect(streams.every((s) => s.ended)).toBe(true);
  });

  it('returns a drain promise under backpressure and completes once unblocked', async () => {
    const streams: MockWriteStream[] = [];
    const router = new RelPairRouter(
      tmpDir,
      HEADER,
      VALID,
      mockFactory(streams, { blocked: true }),
    );

    const pending = router.route('File:a', 'Function:a:f:1', row('File:a', 'Function:a:f:1'));
    expect(pending).toBeInstanceOf(Promise); // header write hit backpressure
    streams[0].unblock();
    await pending;

    expect(streams[0].maxDrainListenersSeen).toBeLessThanOrEqual(1);
    expect(streams[0].chunks[0]).toBe(HEADER + '\n');
    expect(router.total).toBe(1);
  });

  it('on a stream error: route() throws the real error, lastError exposes it, close() rejects + destroys', async () => {
    const streams: MockWriteStream[] = [];
    const router = new RelPairRouter(tmpDir, HEADER, VALID, mockFactory(streams));

    const first = router.route('File:a', 'Function:a:f:1', row('File:a', 'Function:a:f:1'));
    if (first) await first;

    const err = new Error('EMFILE: too many open files');
    streams[0].triggerError(err);

    // The next route surfaces the REAL error, not a generic AbortError.
    expect(() => router.route('File:a', 'Function:a:g:2', row('File:a', 'Function:a:g:2'))).toThrow(
      'EMFILE',
    );
    expect(router.lastError).toBe(err);
    await expect(router.close()).rejects.toThrow('EMFILE');
    expect(streams[0].destroyed).toBe(true);
  });

  it('destroy() tears down every open pair stream', async () => {
    const streams: MockWriteStream[] = [];
    const router = new RelPairRouter(tmpDir, HEADER, VALID, mockFactory(streams));

    const a = router.route('File:a', 'Function:a:f:1', row('File:a', 'Function:a:f:1'));
    if (a) await a;
    const b = router.route('Community:1', 'Community:2', row('Community:1', 'Community:2'));
    if (b) await b;

    router.destroy();
    expect(streams.length).toBe(2);
    expect(streams.every((s) => s.destroyed)).toBe(true);
  });
});
