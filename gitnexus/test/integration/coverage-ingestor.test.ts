import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { CoverageStore } from '../../src/core/coverage/store.js';
import { ingestCoverage, type IngestOptions } from '../../src/core/coverage/ingestor.js';
import type { CanonicalCoverage } from '../../src/core/coverage/types.js';

describe('ingestCoverage (integration)', () => {
  let dbPath: string;
  let store: CoverageStore;
  let graph: ReturnType<typeof createKnowledgeGraph>;
  let opts: IngestOptions;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `coverage-ingest-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new CoverageStore(dbPath);
    graph = createKnowledgeGraph();
    opts = { store, graph };
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it('runs full pipeline: parse → map → dual-write (graph + SQLite)', () => {
    // Set up graph nodes
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });
    graph.addNode({
      id: 'Function:bar',
      label: 'Function',
      properties: { name: 'bar', filePath: 'src/b.ts', startLine: 1, endLine: 20 },
    });
    // Add a CALLS edge so edge-mapper can exercise it
    graph.addRelationship({
      id: 'CALLS:foo->bar',
      sourceId: 'Function:foo',
      targetId: 'Function:bar',
      type: 'CALLS',
      confidence: 1.0,
      reason: 'test',
      step: 0,
    });

    const coverage: CanonicalCoverage = {
      format: 'gitnexus-coverage-v1',
      run: { id: 'run-1', timestamp: '2026-01-01T00:00:00Z', totalLines: 4, coveredLines: 3 },
      files: {
        'src/a.ts': { lines: { '5': 3, '6': 0, '8': 1 } },
        'src/b.ts': { lines: { '10': 5 } },
      },
    };

    const runId = ingestCoverage(coverage, opts);
    expect(runId).toBe('run-1');

    // Verify graph: CoverageRun node exists
    const runNode = graph.getNode('CoverageRun:run-1');
    expect(runNode).toBeDefined();
    expect(runNode!.label).toBe('CoverageRun');

    // Verify graph: symbol nodes have coverage properties
    const fooNode = graph.getNode('Function:foo');
    expect(fooNode!.properties.coverageRatio).toBeDefined();
    expect(fooNode!.properties.lastCoveredAt).toBe('2026-01-01T00:00:00Z');

    const barNode = graph.getNode('Function:bar');
    expect(barNode!.properties.coverageRatio).toBeDefined();

    // Verify graph: COVERED_BY edges
    const coveredByRels = graph.relationships.filter(r => r.type === 'COVERED_BY');
    expect(coveredByRels.length).toBeGreaterThanOrEqual(2);

    // Verify graph: CALLS edge has traversal data
    const callsRel = graph.relationships.find(r => r.id === 'CALLS:foo->bar');
    expect(callsRel).toBeDefined();
    expect((callsRel as any)!.traverseCount).toBe(1);
    expect((callsRel as any)!.traversedInRuns).toContain('run-1');

    // Verify SQLite: run stored
    const storedRun = store.getRun('run-1');
    expect(storedRun).toBeDefined();
    expect(storedRun!.id).toBe('run-1');

    // Verify SQLite: line hits stored
    const lineHits = store.getLineHits('run-1');
    expect(lineHits.length).toBe(4);

    // Verify SQLite: symbol coverage stored
    const symbolCov = store.getSymbolCoverage('run-1');
    expect(symbolCov.length).toBeGreaterThanOrEqual(2);
  });

  it('computes correct symbol coverage ratios', () => {
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });

    const coverage: CanonicalCoverage = {
      format: 'gitnexus-coverage-v1',
      run: { id: 'run-2', timestamp: '2026-01-01T00:00:00Z', totalLines: 4, coveredLines: 2 },
      files: {
        'src/a.ts': { lines: { '3': 5, '4': 0, '5': 3, '6': 0 } },
      },
    };

    ingestCoverage(coverage, opts);

    const fooNode = graph.getNode('Function:foo');
    // 4 lines total, 2 covered (hitCount > 0) → ratio = 0.5
    expect(fooNode!.properties.coverageRatio).toBe(0.5);

    // Also check SQLite
    const symbolCov = store.getSymbolCoverage('run-2');
    const fooCov = symbolCov.find(s => s.nodeId === 'Function:foo');
    expect(fooCov).toBeDefined();
    expect(fooCov!.totalLines).toBe(4);
    expect(fooCov!.coveredLines).toBe(2);
    expect(fooCov!.coverageRatio).toBe(0.5);
  });

  it('maps branch data to both graph and SQLite', () => {
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });

    const coverage: CanonicalCoverage = {
      format: 'gitnexus-coverage-v1',
      run: { id: 'run-3', timestamp: '2026-01-01T00:00:00Z', totalLines: 2, coveredLines: 2 },
      files: {
        'src/a.ts': {
          lines: { '5': 3, '7': 1 },
          branches: { '5:0': 3, '5:1': 0, '7:0': 1 },
        },
      },
    };

    ingestCoverage(coverage, opts);

    // Verify graph: branchCoverage on node
    const fooNode = graph.getNode('Function:foo');
    expect(fooNode!.properties.branchCoverage).toBeDefined();
    expect(fooNode!.properties.branchCoverage).toEqual({ total: 3, covered: 2 });

    // Verify SQLite: branch hits stored
    const mergedBranches = store.getMergedBranchHits(['run-3']);
    const aBranches = mergedBranches.get('src/a.ts');
    expect(aBranches).toBeDefined();
    expect(aBranches!.get('5:0')).toBe(3);
    expect(aBranches!.get('5:1')).toBe(0);
    expect(aBranches!.get('7:0')).toBe(1);
  });
});
