/**
 * Integration test: loadGraphToLbug overlap ERROR paths (#2226 review F1/F2).
 *
 * The node-COPY ‖ relationship-emit overlap (#2203) added two error branches the
 * happy-path tests don't exercise:
 *  - F1: relationship emit fails while node COPY is in flight — the emit error
 *    must surface from loadGraphToLbug AND the in-flight node-COPY promise must
 *    be settled, so nothing leaks as an unhandled rejection.
 *  - F2: node COPY itself fails — the captured error must be rethrown at the FK
 *    barrier rather than silently swallowed.
 *
 * Both are fault-injected by mocking `streamAllCSVsToDisk` so the test controls
 * when `onNodePhaseComplete` fires (starting node COPY) and whether emit throws,
 * while a REAL LadybugDB connection (`initLbug`) runs the node COPY. The mock
 * pattern (vi.hoisted + vi.mock with importOriginal, preserving every other
 * export) mirrors test/unit/api-graph-streaming.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { StreamedCSVResult } from '../../src/core/lbug/csv-generator.js';
import type { NodeTableName } from '../../src/core/lbug/schema.js';
import { buildTestGraph } from '../helpers/test-graph.js';

const { emitMock } = vi.hoisted(() => ({ emitMock: vi.fn() }));

// Replace ONLY streamAllCSVsToDisk; importOriginal preserves StreamedCSVResult
// and every other export lbug-adapter (and its transitive deps) rely on.
vi.mock('../../src/core/lbug/csv-generator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/csv-generator.js')>();
  return { ...actual, streamAllCSVsToDisk: emitMock };
});

type NodeFiles = Map<NodeTableName, { csvPath: string; rows: number }>;

const REL_HEADER = 'from,to,type,confidence,reason,step';
const emptyResult = (): StreamedCSVResult => ({
  nodeFiles: new Map(),
  relsByPair: new Map(),
  relHeader: REL_HEADER,
  skippedRels: 0,
  totalValidRels: 0,
});

let tmpBase: string;
let storagePath: string;
let dbPath: string;

beforeAll(async () => {
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-lbug-overlap-err-'));
  storagePath = path.join(tmpBase, '.gitnexus');
  dbPath = path.join(storagePath, 'lbug');
  await fs.mkdir(dbPath, { recursive: true });

  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  await adapter.initLbug(dbPath);
});

afterEach(() => {
  emitMock.mockReset();
});

afterAll(async () => {
  try {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    await adapter.closeLbug();
  } catch {
    /* may already be closed */
  }
  if (tmpBase) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rm(tmpBase, { recursive: true, force: true });
        return;
      } catch {
        if (attempt < 4) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
});

describe('loadGraphToLbug overlap error paths (#2226 F1)', () => {
  it('relationship-emit failure with node COPY in flight surfaces the emit error and leaks no unhandled rejection', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const graph = buildTestGraph(
      [{ id: 'File:src/u1.ts', label: 'File', name: 'u1.ts', filePath: 'src/u1.ts' }],
      [],
    );

    // emit writes a REAL node CSV (so node COPY actually runs to completion in
    // flight), fires the hook to start node COPY, then throws as if the
    // relationship pass blew up (EMFILE / disk-full).
    emitMock.mockImplementation(
      async (
        _g: unknown,
        _r: unknown,
        dir: string,
        onNodePhaseComplete?: (n: NodeFiles) => void,
      ) => {
        await fs.mkdir(dir, { recursive: true }); // mocked emit skips the real csvDir creation
        const csvPath = path.join(dir, 'file.csv');
        await fs.writeFile(
          csvPath,
          'id,name,filePath,content\n"File:src/u1.ts","u1.ts","src/u1.ts",""\n',
        );
        onNodePhaseComplete?.(new Map([['File', { csvPath, rows: 1 }]]) as NodeFiles);
        throw new Error('simulated rel emit failure');
      },
    );

    const rejections: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      rejections.push(e);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(adapter.loadGraphToLbug(graph, tmpBase, storagePath)).rejects.toThrow(
        'simulated rel emit failure',
      );
      // Flush the macrotask queue so any stray rejection from the in-flight
      // node-COPY promise actually surfaces BEFORE we assert — otherwise the
      // check passes vacuously.
      await new Promise((r) => setImmediate(r));
      expect(rejections).toEqual([]);
    } finally {
      // forks reuse the process across this file's tests — a leaked listener
      // would corrupt sibling tests.
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('also logs the node-COPY error when BOTH emit and node COPY fail (emit error still wins)', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { _captureLogger } = await import('../../src/core/logger.js');
    const graph = buildTestGraph(
      [{ id: 'File:src/u1b.ts', label: 'File', name: 'u1b.ts', filePath: 'src/u1b.ts' }],
      [],
    );

    // nodeFiles points at a MISSING csv (node COPY fails) AND emit throws.
    emitMock.mockImplementation(
      async (
        _g: unknown,
        _r: unknown,
        dir: string,
        onNodePhaseComplete?: (n: NodeFiles) => void,
      ) => {
        onNodePhaseComplete?.(
          new Map([['File', { csvPath: path.join(dir, 'missing-u1b.csv'), rows: 1 }]]) as NodeFiles,
        );
        throw new Error('simulated rel emit failure (double)');
      },
    );

    const cap = _captureLogger();
    const rejections: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      rejections.push(e);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(adapter.loadGraphToLbug(graph, tmpBase, storagePath)).rejects.toThrow(
        'simulated rel emit failure (double)',
      );
      await new Promise((r) => setImmediate(r));
      expect(rejections).toEqual([]);
      const warned = cap
        .records()
        .map((rec) => (typeof rec.msg === 'string' ? rec.msg : ''))
        .some((m) => m.includes('node COPY also failed'));
      expect(warned).toBe(true);
    } finally {
      cap.restore();
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('loadGraphToLbug overlap error paths (#2226 F2)', () => {
  it('a node-COPY hard failure is rethrown at the FK barrier', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const graph = buildTestGraph(
      [{ id: 'File:src/u2.ts', label: 'File', name: 'u2.ts', filePath: 'src/u2.ts' }],
      [],
    );

    // Node COPY targets a MISSING csv → COPY fails at bind time ("No file
    // found …"), which IGNORE_ERRORS does NOT suppress (it only skips row-level
    // errors), so copyNodeCSVs throws. Emit otherwise "succeeds" (returns an
    // empty result), so the only failure is the node COPY captured in
    // nodeCopyError and rethrown at the FK barrier.
    emitMock.mockImplementation(
      async (
        _g: unknown,
        _r: unknown,
        dir: string,
        onNodePhaseComplete?: (n: NodeFiles) => void,
      ) => {
        onNodePhaseComplete?.(
          new Map([['File', { csvPath: path.join(dir, 'missing-u2.csv'), rows: 1 }]]) as NodeFiles,
        );
        return emptyResult();
      },
    );

    await expect(adapter.loadGraphToLbug(graph, tmpBase, storagePath)).rejects.toThrow(
      /COPY failed for File/,
    );
  });
});
