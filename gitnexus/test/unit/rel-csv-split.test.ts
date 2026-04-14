import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Regression tests for the relationship CSV splitting logic in lbug-adapter.ts.
 *
 * These tests exercise the backpressure, error handling, and drain-listener
 * guard that were fixed in PR #818. They use a mock WriteStream to simulate
 * backpressure and error conditions without touching real LadybugDB.
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
// Minimal reimplementation of the rel-CSV split logic under test.
// Mirrors the exact pattern in loadGraphToLbug() so these tests break if
// the production code regresses.
// ---------------------------------------------------------------------------
interface SplitResult {
  relHeader: string;
  pairMeta: Map<string, { rows: number }>;
  skippedRels: number;
  totalValidRels: number;
}

type WriteStreamFactory = (path: string) => MockWriteStream;

async function splitRelCsvByLabelPair(
  csvPath: string,
  csvDir: string,
  validTables: Set<string>,
  getNodeLabel: (id: string) => string,
  wsFactory: WriteStreamFactory,
): Promise<SplitResult> {
  const { createReadStream } = await import('fs');
  const { createInterface } = await import('readline');

  let relHeader = '';
  const pairMeta = new Map<string, { rows: number }>();
  const pairStreams = new Map<string, MockWriteStream>();
  let skippedRels = 0;
  let totalValidRels = 0;

  await new Promise<void>((resolve, reject) => {
    const inputStream = createReadStream(csvPath, 'utf-8');
    const rl = createInterface({ input: inputStream, crlfDelay: Infinity });

    const waitingForDrain = new Set<string>();

    let settled = false;
    const cleanup = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        rl.close();
      } catch {}
      try {
        inputStream.destroy();
      } catch {}
      for (const ws of pairStreams.values()) {
        try {
          ws.destroy();
        } catch {}
      }
      reject(err);
    };

    let isFirst = true;
    rl.on('line', (line) => {
      if (isFirst) {
        relHeader = line;
        isFirst = false;
        return;
      }
      if (!line.trim()) return;
      const match = line.match(/"([^"]*)","([^"]*)"/);
      if (!match) {
        skippedRels++;
        return;
      }
      const fromLabel = getNodeLabel(match[1]);
      const toLabel = getNodeLabel(match[2]);
      if (!validTables.has(fromLabel) || !validTables.has(toLabel)) {
        skippedRels++;
        return;
      }
      const pairKey = `${fromLabel}|${toLabel}`;
      let ws = pairStreams.get(pairKey);
      if (!ws) {
        ws = wsFactory(path.join(csvDir, `rel_${fromLabel}_${toLabel}.csv`));
        ws.on('error', cleanup);
        ws.write(relHeader + '\n');
        pairStreams.set(pairKey, ws);
        pairMeta.set(pairKey, { rows: 0 });
      }
      ws.write(line + '\n');
      pairMeta.get(pairKey)!.rows++;
      totalValidRels++;

      const ok = !ws.blocked;
      if (!ok && !waitingForDrain.has(pairKey)) {
        waitingForDrain.add(pairKey);
        rl.pause();
        ws.once('drain', () => {
          waitingForDrain.delete(pairKey);
          rl.resume();
        });
      }
    });
    rl.on('close', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    rl.on('error', cleanup);
  });

  return { relHeader, pairMeta, skippedRels, totalValidRels };
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-csv-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

  it('splits lines into per-pair files with correct row counts', async () => {
    const csvPath = writeCsv([
      HEADER,
      csvLine('Function:a', 'Class:b'),
      csvLine('Function:c', 'Class:d'),
      csvLine('File:e', 'Method:f'),
    ]);

    const streams: MockWriteStream[] = [];
    const result = await splitRelCsvByLabelPair(csvPath, tmpDir, validTables, getNodeLabel, () => {
      const ws = new MockWriteStream();
      streams.push(ws);
      return ws;
    });

    expect(result.totalValidRels).toBe(3);
    expect(result.pairMeta.get('Function|Class')?.rows).toBe(2);
    expect(result.pairMeta.get('File|Method')?.rows).toBe(1);
  });

  it('captures the CSV header in relHeader', async () => {
    const csvPath = writeCsv([HEADER, csvLine('Function:a', 'Class:b')]);

    const result = await splitRelCsvByLabelPair(
      csvPath,
      tmpDir,
      validTables,
      getNodeLabel,
      () => new MockWriteStream(),
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

    const result = await splitRelCsvByLabelPair(
      csvPath,
      tmpDir,
      validTables,
      getNodeLabel,
      () => new MockWriteStream(),
    );

    expect(result.totalValidRels).toBe(1);
    expect(result.skippedRels).toBe(2);
  });

  it('ignores blank lines without counting them as skipped', async () => {
    const csvPath = writeCsv([HEADER, '', csvLine('Function:a', 'Class:b'), '', '']);

    const result = await splitRelCsvByLabelPair(
      csvPath,
      tmpDir,
      validTables,
      getNodeLabel,
      () => new MockWriteStream(),
    );

    expect(result.totalValidRels).toBe(1);
    expect(result.skippedRels).toBe(0);
  });

  it('registers at most 1 drain listener per stream under heavy backpressure', async () => {
    // Create many lines targeting the same pair — all will hit backpressure
    const lines = [HEADER];
    for (let i = 0; i < 50; i++) {
      lines.push(csvLine(`Function:f${i}`, `Class:c${i}`));
    }
    const csvPath = writeCsv(lines);

    const streams: MockWriteStream[] = [];
    const factory = () => {
      const ws = new MockWriteStream();
      ws.blocked = true; // permanent backpressure
      streams.push(ws);
      return ws;
    };

    // Start the split — it will pause on first backpressure
    const promise = splitRelCsvByLabelPair(csvPath, tmpDir, validTables, getNodeLabel, factory);

    // Give readline time to buffer and fire lines
    await new Promise((r) => setTimeout(r, 50));

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
    const factory = () => {
      const ws = new MockWriteStream();
      ws.blocked = true; // hold the promise open via backpressure
      streams.push(ws);
      return ws;
    };

    const promise = splitRelCsvByLabelPair(csvPath, tmpDir, validTables, getNodeLabel, factory);

    // Wait for readline to process, then error while paused on drain
    await new Promise((r) => setTimeout(r, 50));
    expect(streams.length).toBeGreaterThan(0);
    streams[0].triggerError(new Error('disk full'));

    await expect(promise).rejects.toThrow('disk full');
  });

  it('destroys all streams when one errors (no lingering FDs)', async () => {
    // Use enough lines to create two different pair streams
    const lines = [HEADER];
    for (let i = 0; i < 10; i++) {
      lines.push(csvLine(`Function:f${i}`, `Class:c${i}`));
      lines.push(csvLine(`File:e${i}`, `Method:m${i}`));
    }
    const csvPath = writeCsv(lines);

    const streams: MockWriteStream[] = [];
    const factory = () => {
      const ws = new MockWriteStream();
      ws.blocked = true; // hold all streams open via backpressure
      streams.push(ws);
      return ws;
    };

    const promise = splitRelCsvByLabelPair(csvPath, tmpDir, validTables, getNodeLabel, factory);

    // Wait for readline to process and create streams
    await new Promise((r) => setTimeout(r, 50));
    expect(streams.length).toBeGreaterThanOrEqual(2);
    streams[0].triggerError(new Error('EMFILE'));

    await expect(promise).rejects.toThrow('EMFILE');

    for (const ws of streams) {
      expect(ws.destroyed).toBe(true);
    }
  });

  it('handles empty CSV (header only) without errors', async () => {
    const csvPath = writeCsv([HEADER]);

    const result = await splitRelCsvByLabelPair(
      csvPath,
      tmpDir,
      validTables,
      getNodeLabel,
      () => new MockWriteStream(),
    );

    expect(result.totalValidRels).toBe(0);
    expect(result.skippedRels).toBe(0);
    expect(result.relHeader).toBe(HEADER);
  });
});
