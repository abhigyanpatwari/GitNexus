import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { CoverageStore } from '../../src/core/coverage/store.js';
import { streamIngest } from '../../src/core/coverage/streaming.js';
import type { IngestOptions } from '../../src/core/coverage/ingestor.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('streamIngest', () => {
  let dbPath: string;
  let store: CoverageStore;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `coverage-stream-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new CoverageStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it('flushes on reaching batchSize', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 100 },
    });

    const opts: IngestOptions = { store, graph };
    const meta = { id: 'stream-1', timestamp: '2026-01-01T00:00:00Z' };

    // Generate 5 JSONL lines, batchSize=3 → should flush twice (at 3, then at EOF)
    const lines = [
      JSON.stringify({ file: 'src/a.ts', line: 10, count: 1 }),
      JSON.stringify({ file: 'src/a.ts', line: 11, count: 1 }),
      JSON.stringify({ file: 'src/a.ts', line: 12, count: 1 }),
      JSON.stringify({ file: 'src/a.ts', line: 13, count: 1 }),
      JSON.stringify({ file: 'src/a.ts', line: 14, count: 1 }),
    ];

    const input = Readable.from(lines.map(l => l + '\n'));
    const runId = await streamIngest(input, opts, meta, 3, 60000);

    expect(runId).toBe('stream-1');
    // Verify the run was stored
    const run = store.getRun('stream-1');
    expect(run).toBeDefined();
    // Verify line hits were stored
    const lineHits = store.getLineHits('stream-1');
    expect(lineHits.length).toBeGreaterThanOrEqual(5);
  });

  it('flushes remaining data at EOF', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 100 },
    });

    const opts: IngestOptions = { store, graph };
    const meta = { id: 'stream-2', timestamp: '2026-01-01T00:00:00Z' };

    // Only 2 lines — less than batchSize=10, so flush only happens at EOF
    const lines = [
      JSON.stringify({ file: 'src/a.ts', line: 20, count: 5 }),
      JSON.stringify({ file: 'src/a.ts', line: 21, count: 3 }),
    ];

    const input = Readable.from(lines.map(l => l + '\n'));
    const runId = await streamIngest(input, opts, meta, 10, 60000);

    expect(runId).toBe('stream-2');
    const lineHits = store.getLineHits('stream-2');
    expect(lineHits).toHaveLength(2);
    // Verify specific line counts
    const line20 = lineHits.find(h => h.lineNumber === 20);
    const line21 = lineHits.find(h => h.lineNumber === 21);
    expect(line20!.hitCount).toBe(5);
    expect(line21!.hitCount).toBe(3);
  });

  it('handles branch data in JSONL input', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 100 },
    });

    const opts: IngestOptions = { store, graph };
    const meta = { id: 'stream-3', timestamp: '2026-01-01T00:00:00Z' };

    const lines = [
      JSON.stringify({ file: 'src/a.ts', line: 10, count: 2, branch: '10:0' }),
      JSON.stringify({ file: 'src/a.ts', line: 10, count: 0, branch: '10:1' }),
      JSON.stringify({ file: 'src/a.ts', line: 20, count: 1 }),
    ];

    const input = Readable.from(lines.map(l => l + '\n'));
    await streamIngest(input, opts, meta, 10, 60000);

    // Branch data should be stored in branch_hits table
    const mergedBranches = store.getMergedBranchHits(['stream-3']);
    const aBranches = mergedBranches.get('src/a.ts');
    expect(aBranches).toBeDefined();
    expect(aBranches!.get('10:0')).toBe(2);
    expect(aBranches!.get('10:1')).toBe(0);
  });
});
