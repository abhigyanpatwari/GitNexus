import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { CoverageStore } from '../../src/core/coverage/store.js';
import { mergeRuns } from '../../src/core/coverage/merger.js';
import { ingestCoverage, type IngestOptions } from '../../src/core/coverage/ingestor.js';
import type { CanonicalCoverage } from '../../src/core/coverage/types.js';

describe('mergeRuns', () => {
  let dbPath: string;
  let store: CoverageStore;
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let opts: IngestOptions;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `coverage-merge-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new CoverageStore(dbPath);
    graph = createKnowledgeGraph();
    opts = { store, graph };
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it('merges line coverage across two runs (union — max hit count)', () => {
    // Set up a function node
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });

    // Run 1: line 5 hit 3 times
    const cov1: CanonicalCoverage = {
      format: 'gitnexus-coverage-v1',
      run: { id: 'run-1', timestamp: '2026-01-01T00:00:00Z', totalLines: 1, coveredLines: 1 },
      files: { 'src/a.ts': { lines: { '5': 3 } } },
    };
    ingestCoverage(cov1, opts);

    // Run 2: line 5 hit 7 times, line 8 hit 2 times
    const cov2: CanonicalCoverage = {
      format: 'gitnexus-coverage-v1',
      run: { id: 'run-2', timestamp: '2026-02-01T00:00:00Z', totalLines: 2, coveredLines: 2 },
      files: { 'src/a.ts': { lines: { '5': 7, '8': 2 } } },
    };
    ingestCoverage(cov2, opts);

    // Merge
    const mergedId = mergeRuns(
      ['run-1', 'run-2'],
      store,
      opts,
      { id: 'merged-1', timestamp: '2026-03-01T00:00:00Z' },
    );

    expect(mergedId).toBe('merged-1');

    // Verify merged line hits in store
    const mergedLines = store.getMergedLineHits(['run-1', 'run-2']);
    const aLines = mergedLines.get('src/a.ts');
    expect(aLines).toBeDefined();
    expect(aLines!.get(5)).toBe(7); // max(3, 7) = 7
    expect(aLines!.get(8)).toBe(2);
  });

  it('merges branch data across runs', () => {
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });

    // Run 1: branch 5:0 hit 3 times
    const cov1: CanonicalCoverage = {
      format: 'gitnexus-coverage-v1',
      run: { id: 'run-1', timestamp: '2026-01-01T00:00:00Z', totalLines: 1, coveredLines: 1 },
      files: { 'src/a.ts': { lines: { '5': 3 }, branches: { '5:0': 3 } } },
    };
    ingestCoverage(cov1, opts);

    // Run 2: branch 5:0 hit 5 times, branch 5:1 hit 0 times
    const cov2: CanonicalCoverage = {
      format: 'gitnexus-coverage-v1',
      run: { id: 'run-2', timestamp: '2026-02-01T00:00:00Z', totalLines: 1, coveredLines: 1 },
      files: { 'src/a.ts': { lines: { '5': 5 }, branches: { '5:0': 5, '5:1': 0 } } },
    };
    ingestCoverage(cov2, opts);

    mergeRuns(
      ['run-1', 'run-2'],
      store,
      opts,
      { id: 'merged-2', timestamp: '2026-03-01T00:00:00Z' },
    );

    // Verify merged branch hits in store
    const mergedBranches = store.getMergedBranchHits(['run-1', 'run-2']);
    const aBranches = mergedBranches.get('src/a.ts');
    expect(aBranches).toBeDefined();
    expect(aBranches!.get('5:0')).toBe(5); // max(3, 5) = 5
    expect(aBranches!.get('5:1')).toBe(0);
  });

  it('handles single run merge (no-op union)', () => {
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });

    const cov1: CanonicalCoverage = {
      format: 'gitnexus-coverage-v1',
      run: { id: 'run-1', timestamp: '2026-01-01T00:00:00Z', totalLines: 1, coveredLines: 1 },
      files: { 'src/a.ts': { lines: { '5': 3 } } },
    };
    ingestCoverage(cov1, opts);

    const mergedId = mergeRuns(
      ['run-1'],
      store,
      opts,
      { id: 'merged-3', timestamp: '2026-03-01T00:00:00Z' },
    );

    expect(mergedId).toBe('merged-3');
    const mergedLines = store.getMergedLineHits(['run-1']);
    expect(mergedLines.get('src/a.ts')!.get(5)).toBe(3);
  });
});
