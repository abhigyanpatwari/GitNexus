/**
 * Import-emission memory probe for #3695. Run from gitnexus/:
 *   node --expose-gc --max-old-space-size=512 --import tsx \
 *     bench/import-emission/probe.mts --files 17095 --imports 32
 *
 * Pass --emitter /path/to/baseline/imports-to-edges.ts to compare revisions
 * with the same inputs, sink and runtime. Compare both ordered-edge and CSV
 * hashes. Run each revision in a fresh process, alternating order. A 288 MiB
 * old-space limit exercises pressure on this workload; disable core dumps
 * before running an old revision expected to exhaust its heap.
 *
 * Inputs stay live. GC at baseline/first emit/last emit/return measures heap
 * while the collector and sink are live. The signed first-emit delta includes
 * runtime bookkeeping and may be negative; compare the actual checkpoints
 * across revisions. Hashing and GC affect elapsed time, so this is not a speed
 * benchmark. Synthetic import pairs do not reproduce a whole repo.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { GraphRelationship, ImportEdge, Scope, ScopeId, ScopeTree } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { GraphEmitSink } from '../../src/core/lbug/graph-emit-sink.js';
import type { emitImportEdges as Emitter } from '../../src/core/ingestion/scope-resolution/graph-bridge/imports-to-edges.js';

const { values } = parseArgs({
  options: {
    files: { type: 'string', default: '17095' },
    imports: { type: 'string', default: '32' },
    'path-length': { type: 'string', default: '140' },
    emitter: { type: 'string' },
  },
});
const fileCount = Number(values.files);
const importsPerFile = Number(values.imports);
const pathLength = Number(values['path-length']);
assert(Number.isSafeInteger(fileCount) && fileCount > 1);
assert(Number.isSafeInteger(importsPerFile) && importsPerFile > 0 && importsPerFile < fileCount);
assert(Number.isSafeInteger(pathLength) && pathLength >= 32);
assert(global.gc, 'Run with --expose-gc');
const emitterUrl =
  values.emitter === undefined
    ? new URL(
        '../../src/core/ingestion/scope-resolution/graph-bridge/imports-to-edges.ts',
        import.meta.url,
      )
    : pathToFileURL(path.resolve(values.emitter));
const { emitImportEdges } = (await import(emitterUrl.href)) as { emitImportEdges: typeof Emitter };

const paths = Array.from({ length: fileCount }, (_, i) => {
  const suffix = `/File${String(i).padStart(8, '0')}.java`;
  return (
    `${'package/'.repeat(Math.ceil(pathLength / 8))}`.slice(0, pathLength - suffix.length) + suffix
  );
});
assert.equal(new Set(paths).size, fileCount);
const scopes = new Map(paths.map((filePath, i) => [`scope${i}` as ScopeId, { filePath } as Scope]));
const imports = new Map(
  paths.map((_, i) => [
    `scope${i}` as ScopeId,
    Array.from(
      { length: importsPerFile },
      (_, j) =>
        ({
          targetFile: paths[(i + j + 1) % fileCount],
          localName: 'Symbol',
          targetExportedName: 'Symbol',
          kind: 'named',
        }) as ImportEdge,
    ),
  ]),
);
const scopeTree = { getScope: (id: ScopeId) => scopes.get(id) } as ScopeTree;
const total = fileCount * importsPerFile;
const dir = mkdtempSync(path.join(tmpdir(), 'gitnexus-import-emission-'));
try {
  const sink = new GraphEmitSink(createKnowledgeGraph(), path.join(dir, 'csv'));
  try {
    sink.beginStreaming();
    Object.defineProperty(globalThis, '__importEmissionBenchmarkInputs', {
      value: { paths, scopes, imports, sink },
    });
    const digest = createHash('sha256');
    let emitted = 0;
    let firstEmitHeap = 0;
    let lastEmitHeap = 0;
    let sampledPeakHeap = 0;
    const graph = {
      addRelationship(rel: GraphRelationship) {
        if (emitted === 0) {
          global.gc!();
          firstEmitHeap = process.memoryUsage().heapUsed;
        }
        sink.addRelationship(rel);
        digest.update(JSON.stringify(rel));
        emitted++;
        if (emitted % 10000 === 0)
          sampledPeakHeap = Math.max(sampledPeakHeap, process.memoryUsage().heapUsed);
        if (emitted === total) {
          global.gc!();
          lastEmitHeap = process.memoryUsage().heapUsed;
        }
      },
    } as KnowledgeGraph;

    global.gc!();
    const inputHeap = process.memoryUsage().heapUsed;
    const started = performance.now();
    const count = emitImportEdges(graph, imports, scopeTree);
    const elapsedMs = performance.now() - started;
    const manifest = sink.finalize();
    global.gc!();
    const afterHeap = process.memoryUsage().heapUsed;
    assert.equal(count, total);
    assert.equal(emitted, total);
    assert.equal(manifest.totalRows, total);
    const csvDigest = createHash('sha256');
    for (const { csvPath } of manifest.relsByPair.values()) {
      for await (const chunk of createReadStream(csvPath)) csvDigest.update(chunk);
    }
    console.log(
      JSON.stringify({
        node: process.version,
        emitter: emitterUrl.href,
        fileCount,
        importsPerFile,
        pathLength,
        count,
        inputHeap,
        firstEmitHeap,
        firstEmitHeapDeltaBytes: firstEmitHeap - inputHeap,
        lastEmitHeap,
        sampledPeakHeap,
        afterHeap,
        maxRssKiB: process.resourceUsage().maxRSS,
        elapsedMs,
        edgeDigest: digest.digest('hex'),
        csvDigest: csvDigest.digest('hex'),
      }),
    );
  } finally {
    sink.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
