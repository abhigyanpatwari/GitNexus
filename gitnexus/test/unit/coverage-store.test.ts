import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CoverageStore } from '../../src/core/coverage/store.js';

describe('CoverageStore', () => {
  let dbPath: string;
  let store: CoverageStore;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `coverage-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new CoverageStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it('upserts and retrieves a run', () => {
    store.upsertRun({
      id: 'run-1', timestamp: '2026-01-01T00:00:00Z',
      totalLines: 100, coveredLines: 75, coverageRatio: 0.75,
    });
    const run = store.getRun('run-1');
    expect(run).toBeDefined();
    expect(run!.coverageRatio).toBe(0.75);
  });

  it('lists runs ordered by timestamp descending', () => {
    store.upsertRun({ id: 'run-1', timestamp: '2026-01-01T00:00:00Z', totalLines: 10, coveredLines: 5, coverageRatio: 0.5 });
    store.upsertRun({ id: 'run-2', timestamp: '2026-02-01T00:00:00Z', totalLines: 10, coveredLines: 8, coverageRatio: 0.8 });
    const runs = store.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe('run-2');
  });

  it('deletes a run and cascades', () => {
    store.upsertRun({ id: 'run-1', timestamp: '2026-01-01T00:00:00Z', totalLines: 10, coveredLines: 5, coverageRatio: 0.5 });
    store.insertLineHits([{ runId: 'run-1', filePath: 'a.ts', lineNumber: 1, hitCount: 5 }]);
    store.deleteRun('run-1');
    expect(store.getRun('run-1')).toBeUndefined();
  });

  it('returns uncovered symbols sorted by ratio', () => {
    store.upsertRun({ id: 'run-1', timestamp: '2026-01-01T00:00:00Z', totalLines: 10, coveredLines: 5, coverageRatio: 0.5 });
    store.insertSymbolCoverage([
      { runId: 'run-1', nodeId: 'Function:a', totalLines: 10, coveredLines: 0, coverageRatio: 0 },
      { runId: 'run-1', nodeId: 'Function:b', totalLines: 10, coveredLines: 3, coverageRatio: 0.3 },
      { runId: 'run-1', nodeId: 'Function:c', totalLines: 10, coveredLines: 9, coverageRatio: 0.9 },
    ]);
    const uncovered = store.getUncoveredSymbols('run-1', 2);
    expect(uncovered).toHaveLength(2);
    expect(uncovered[0].nodeId).toBe('Function:a');
    expect(uncovered[1].nodeId).toBe('Function:b');
  });
});
