/**
 * Integration test: PROF_LBUG_LOAD persistence-path profiling (#2203 U1).
 *
 * loadGraphToLbug is un-timed in production today; the analyze "emit" number
 * is the scope-resolution emit bucket, not this CSV→COPY persistence path.
 * U1 adds a zero-cost-when-off per-stage breakdown gated by PROF_LBUG_LOAD=1,
 * mirroring the PROF_SCOPE_RESOLUTION pattern. These tests assert the gate:
 *  - flag off  → no `[lbug-load prof]` line is logged, behaviour unchanged
 *  - flag on   → exactly one summary line with every stage key + node/rel counts
 *
 * Needs a real LadybugDB connection (initLbug), so it lives under integration.
 * Logger assertions use `_captureLogger()` — the exported `logger` is a Proxy
 * over a lazily-built pino instance and is not directly spy-able.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { buildTestGraph } from '../helpers/test-graph.js';
import { _captureLogger, type LoggerCapture } from '../../src/core/logger.js';

let tmpBase: string;
let storagePath: string;
let dbPath: string;
let cap: LoggerCapture;

const PROF_LINE = '[lbug-load prof]';

const profLines = (): string[] =>
  cap
    .records()
    .map((r) => (typeof r.msg === 'string' ? r.msg : ''))
    .filter((msg) => msg.includes(PROF_LINE));

beforeAll(async () => {
  tmpBase = path.join(os.tmpdir(), `gitnexus-lbug-prof-${Date.now()}-${process.pid}`);
  storagePath = path.join(tmpBase, '.gitnexus');
  dbPath = path.join(storagePath, 'lbug');
  await fs.mkdir(dbPath, { recursive: true });

  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  await adapter.initLbug(dbPath);
});

beforeEach(() => {
  cap = _captureLogger();
});

afterEach(() => {
  cap.restore();
  delete process.env.PROF_LBUG_LOAD;
});

afterAll(async () => {
  try {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.closeLbug();
  } catch {
    /* may not have opened */
  }
  try {
    await fs.rm(tmpBase, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('PROF_LBUG_LOAD persistence-path profiling (#2203 U1)', () => {
  it('does NOT log a prof summary when the flag is unset', async () => {
    delete process.env.PROF_LBUG_LOAD;
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    const graph = buildTestGraph(
      [
        { id: 'File:src/off.ts', label: 'File', name: 'off.ts', filePath: 'src/off.ts' },
        {
          id: 'Function:src/off.ts:offFn:1',
          label: 'Function',
          name: 'offFn',
          filePath: 'src/off.ts',
          startLine: 1,
          endLine: 2,
        },
      ],
      [{ sourceId: 'File:src/off.ts', targetId: 'Function:src/off.ts:offFn:1', type: 'DEFINES' }],
    );

    const result = await adapter.loadGraphToLbug(graph, tmpBase, storagePath);

    expect(result.success).toBe(true);
    expect(profLines()).toHaveLength(0);
  });

  it('logs exactly one summary line with all stage keys + counts when the flag is set', async () => {
    process.env.PROF_LBUG_LOAD = '1';
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    // Distinct ids from the flag-off graph so the COPY does not hit a
    // PK-dup IGNORE_ERRORS retry on the shared singleton connection.
    const graph = buildTestGraph(
      [
        { id: 'File:src/on.ts', label: 'File', name: 'on.ts', filePath: 'src/on.ts' },
        {
          id: 'Function:src/on.ts:onFn:1',
          label: 'Function',
          name: 'onFn',
          filePath: 'src/on.ts',
          startLine: 1,
          endLine: 2,
        },
        {
          id: 'Class:src/on.ts:OnClass:5',
          label: 'Class',
          name: 'OnClass',
          filePath: 'src/on.ts',
          startLine: 5,
          endLine: 8,
        },
      ],
      [
        { sourceId: 'File:src/on.ts', targetId: 'Function:src/on.ts:onFn:1', type: 'DEFINES' },
        { sourceId: 'File:src/on.ts', targetId: 'Class:src/on.ts:OnClass:5', type: 'DEFINES' },
      ],
    );

    const result = await adapter.loadGraphToLbug(graph, tmpBase, storagePath);
    expect(result.success).toBe(true);

    const lines = profLines();
    expect(lines).toHaveLength(1);

    const line = lines[0];
    // Relationships are routed to per-pair files during csv-emit (#2203 U2),
    // so there is no separate rel-split stage.
    for (const key of ['csv-emit=', 'copy-nodes=', 'copy-rels=', 'fallback=', 'total=']) {
      expect(line).toContain(key);
    }
    // Default load path is the node-COPY ‖ rel-emit overlap (#2203); the prof
    // line records which path ran. GITNEXUS_SERIAL_LBUG_LOAD is unset here.
    expect(line).toContain('mode=overlap');
    // 3 node rows (File, Function, Class), 2 valid rels emitted.
    expect(line).toContain('(3 nodes, 2 rels)');
  });
});
