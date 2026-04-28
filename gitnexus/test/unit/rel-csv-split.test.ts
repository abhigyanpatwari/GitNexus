import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { splitRelCsvByLabelPair } from '../../src/core/lbug/lbug-adapter.js';

/**
 * Regression tests for splitRelCsvByLabelPair (PR #818).
 *
 * These tests call the real exported function from lbug-adapter.ts with a
 * mock WriteStream factory, exercising the actual backpressure, error
 * handling, and drain-listener guard without touching LadybugDB.
 */

// ---------------------------------------------------------------------------
// Mock WriteStream — controllable backpressure + error injection
// ---------------------------------------------------------------------------
class MockWriteStream extends EventEmitter {
  public chunks: string[] = [];
  public destroyed = false;
  public ended = false;
  public blocked = false;
  public maxDrainListenersSeen = 0;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    this._trackDrainListeners();
    return !this.blocked;
  }

  end(cb?: (err?: Error) => void): this {
    this.ended = true;
    if (cb) cb();
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

  private _trackDrainListeners(): void {
    const count = this.listenerCount('drain');
    if (count > this.maxDrainListenersSeen) {
      this.maxDrainListenersSeen = count;
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
const HEADER = '"from","to","type","confidence","reason","step"';

function csvLine(from: string, to: string, type = 'CALLS'): string {
  return `"${from}","${to}","${type}",1.0,"auto",0`;
}

function getNodeLabel(id: string): string {
  return id.split(':')[0];
}

/** Cast MockWriteStream factory to the real WriteStreamFactory type. */
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-csv-test-'));
});

afterEach(() => {
  // fs.rmSync's built-in retry loop handles Windows EBUSY/ENOTEMPTY/EPERM
  // when a just-closed fd hasn't been released yet (Node added this exactly
  // for cross-platform tmpdir cleanup — see Node.js fs docs). The production
  // function also waits for the input stream's 'close' event, so this is
  // defense-in-depth.
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function writeCsv(lines: string[]): string {
  const csvPath = path.join(tmpDir, 'relations.csv');
  fs.writeFileSync(csvPath, lines.join('\n') + '\n');
  return csvPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('splitRelCsvByLabelPair', () => {
  const validTables = new Set(['Function', 'Class', 'File', 'Method']);
  /** Bounded poll for readline + split loop to reach an observable milestone (DoD §2.7). */
  const pollOpts = { interval: 10, timeout: 10_000 } as const;

  it('splits lines into per-pair files with correct row counts', async () => {
    const csvPath = writeCsv([
      HEADER,
      csvLine('Function:a', 'Class:b'),
      csvLine('Function:c', 'Class:d'),
      csvLine('File:e', 'Method:f'),
    ]);

    const streams: MockWriteStream[] = [];
    const result = await splitRelCsvByLabelPair(
      csvPath,
      tmpDir,
      validTables,
      getNodeLabel,
      mockFactory(streams),
    );

    expect(result.totalValidRels).toBe(3);
    expect(result.relsByPairMeta.get('Function|Class')?.rows).toBe(2);
    expect(result.relsByPairMeta.get('File|Method')?.rows).toBe(1);
  });

  it('captures the CSV header in relHeader', async () => {
    const csvPath = writeCsv([HEADER, csvLine('Function:a', 'Class:b')]);

    const streams: MockWriteStream[] = [];
    const result = await splitRelCsvByLabelPair(
      csvPath,
      tmpDir,
      validTables,
      getNodeLabel,
      mockFactory(streams),
    );

    expect(result.relHeader).toBe(HEADER);
  });

  it('skips lines with unknown labels and counts them', async () => {
    const csvPath = writeCsv([
      HEADER,
      csvLine('Function:a', 'Class:b'),
      csvLine('Unknown:x', 'Class:y'),
      csvLine('Function:c', 'Bogus:d'),
    ]);

    const streams: MockWriteStream[] = [];
    const result = await splitRelCsvByLabelPair(
      csvPath,
      tmpDir,
      validTables,
      getNodeLabel,
      mockFactory(streams),
    );

    expect(result.totalValidRels).toBe(1);
    expect(result.skippedRels).toBe(2);
  });

  it('ignores blank lines without counting them as skipped', async () => {
    const csvPath = writeCsv([HEADER, '', csvLine('Function:a', 'Class:b'), '', '']);

    const streams: MockWriteStream[] = [];
    const result = await splitRelCsvByLabelPair(
      csvPath,
      tmpDir,
      validTables,
      getNodeLabel,
      mockFactory(streams),
    );

    expect(result.totalValidRels).toBe(1);
    expect(result.skippedRels).toBe(0);
  });

  it('registers at most 1 drain listener per stream under heavy backpressure', async () => {
    const lines = [HEADER];
    for (let i = 0; i < 50; i++) {
      lines.push(csvLine(`Function:f${i}`, `Class:c${i}`));
    }
    const csvPath = writeCsv(lines);

    const streams: MockWriteStream[] = [];
    const promise = splitRelCsvByLabelPair(
      csvPath,
      tmpDir,
      validTables,
      getNodeLabel,
      mockFactory(streams, { blocked: true }),
    );

    // All rows share Function|Class — one stream, blocked on header or row drain
    await expect.poll(() => streams.length, pollOpts).toBe(1);

    // Unblock all streams so the Promise can resolve
    for (const ws of streams) ws.unblock();
    await promise;

    // The guard should have kept drain listeners at 1
    for (const ws of streams) {
      expect(ws.maxDrainListenersSeen).toBeLessThanOrEqual(1);
    }
  });

  it('rejects the Promise when a WriteStream emits an error', async () => {
    const csvPath = writeCsv([HEADER, csvLine('Function:a', 'Class:b')]);

    const streams: MockWriteStream[] = [];
    const promise = splitRelCsvByLabelPair(
      csvPath,
      tmpDir,
      validTables,
      getNodeLabel,
      mockFactory(streams, { blocked: true }),
    );

    await expect.poll(() => streams.length, pollOpts).toBe(1);
    streams[0].triggerError(new Error('disk full'));

    await expect(promise).rejects.toThrow('disk full');
  });

  it('destroys all streams when one errors (no lingering FDs)', async () => {
    const lines = [HEADER];
    for (let i = 0; i < 10; i++) {
      lines.push(csvLine(`Function:f${i}`, `Class:c${i}`));
      lines.push(csvLine(`File:e${i}`, `Method:m${i}`));
    }
    const csvPath = writeCsv(lines);

    const streams: MockWriteStream[] = [];
    const promise = splitRelCsvByLabelPair(
      csvPath,
      tmpDir,
      validTables,
      getNodeLabel,
      mockFactory(streams, { blocked: true }),
    );

    // First pair stream once readline delivered a row; poll avoids Windows CI races.
    await expect.poll(() => streams.length, pollOpts).toBe(1);
    streams[0].unblock();
    // Exactly two pair keys before the third CSV row: Function|Class then
    // File|Method; the loop is blocked on the second stream's header drain.
    await expect.poll(() => streams.length, pollOpts).toBe(2);
    streams[0].triggerError(new Error('EMFILE'));

    await expect(promise).rejects.toThrow('EMFILE');

    for (const ws of streams) {
      expect(ws.destroyed).toBe(true);
    }
  });

  it('handles empty CSV (header only) without errors', async () => {
    const csvPath = writeCsv([HEADER]);

    const streams: MockWriteStream[] = [];
    const result = await splitRelCsvByLabelPair(
      csvPath,
      tmpDir,
      validTables,
      getNodeLabel,
      mockFactory(streams),
    );

    expect(result.totalValidRels).toBe(0);
    expect(result.skippedRels).toBe(0);
    expect(result.relHeader).toBe(HEADER);
  });
});
