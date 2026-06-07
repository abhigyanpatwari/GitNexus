/**
 * Worker-backed parse helper for tests.
 *
 * Since the sequential (in-process) parser was removed, the worker pool is
 * GitNexus's only parse path. Tests that used to call `processParsing` with no
 * pool (driving the in-process parser) now route in-memory fixture files
 * through a REAL worker pool here and assert on the resulting graph exactly as
 * before — the assertions are about graph content, not which path produced it.
 *
 * Requires the compiled `dist/.../parse-worker.js`. The integration test tier
 * builds it via `pretest:integration`; unit-tier runs do not, so suites using
 * this helper must live under `test/integration/` (or otherwise ensure a build).
 * Use {@link distWorkerExists} to guard/skip when the build is absent.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
import {
  processParsing,
  type WorkerExtractedData,
} from '../../src/core/ingestion/parsing-processor.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import type { MutableSemanticModel } from '../../src/core/ingestion/model/index.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';
import type { ExportedTypeMap } from '../../src/core/ingestion/call-processor.js';

const HELPER_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The compiled worker the integration tier builds via `pretest:integration`. */
export const DIST_WORKER_URL = pathToFileURL(
  path.resolve(HELPER_DIR, '..', '..', 'dist', 'core', 'ingestion', 'workers', 'parse-worker.js'),
);

/** True when `dist/.../parse-worker.js` exists (i.e. the build has run). */
export const distWorkerExists = (): boolean => fs.existsSync(fileURLToPath(DIST_WORKER_URL));

export interface WorkerParseResult {
  graph: KnowledgeGraph;
  model: MutableSemanticModel;
  data: WorkerExtractedData;
}

/**
 * Parse in-memory fixture files through a real worker pool and return the
 * populated graph + semantic model. One worker by default — fixtures are tiny
 * and a single worker keeps startup cost down while exercising the real
 * dispatch + merge path.
 */
export const parseFilesWithWorkers = async (
  files: { path: string; content: string }[],
  opts: {
    poolSize?: number;
    exportedTypeMap?: ExportedTypeMap;
    outRawResults?: ParseWorkerResult[];
  } = {},
): Promise<WorkerParseResult> => {
  const graph = createKnowledgeGraph();
  const model = createSemanticModel();
  const pool = createWorkerPool(DIST_WORKER_URL, opts.poolSize ?? 1);
  try {
    const data = await processParsing(
      graph,
      files,
      model.symbols,
      pool,
      undefined,
      opts.outRawResults,
      opts.exportedTypeMap,
    );
    return { graph, model, data };
  } finally {
    await pool.terminate();
  }
};
