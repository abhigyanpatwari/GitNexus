/**
 * Build-free emit-path throughput + byte-identity bench for the graph-DB
 * persistence pipeline (issue #2203).
 *
 * Measures `streamAllCSVsToDisk` — the CSV-generation half of the persistence
 * path that U2 (direct per-pair relationship routing) and U3 (per-row
 * microtask elimination) optimised. The LadybugDB `COPY` half needs a real DB
 * connection, so its timing lives in the runtime `PROF_LBUG_LOAD` breakdown +
 * the integration round-trip tests, NOT here (see README.md).
 *
 * For a synthetic KnowledgeGraph at two scales it reports:
 *   - elapsed_ms_small / elapsed_ms_large (median over REPS) + a scaling ratio
 *     `(t_large/t_small)/(LARGE/SMALL)`: ~1.0 linear, ~3.x quadratic;
 *   - an order-independent sha256 fingerprint over every emitted CSV line
 *     (node CSVs + per-FROM→TO-label-pair rel CSVs), as the byte-identity gate
 *     guarding the issue's "byte-identical graph content" requirement.
 *
 * Build-free: imports the `.ts` hotpaths through tsx
 * (`node --import tsx bench/emit-persistence/measure.mjs`). Static `.ts`
 * imports work; a top-level `await import()` breaks tsx's lexer.
 *
 * Without args: prints one JSON object per scenario.
 * With `--check`: asserts the fingerprint == the committed baseline AND the
 * scaling ratio < the recorded budget; exits non-zero on drift/regression.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createKnowledgeGraph } from '../../src/core/graph/graph.ts';
import { streamAllCSVsToDisk } from '../../src/core/lbug/csv-generator.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');

// ---- synthetic graph generation (deterministic — no randomness) ----

/**
 * Build a graph of `entityCount` files, each with 2 functions + 1 class and 4
 * relationships. ids carry valid table-label prefixes (File:/Function:/Class:)
 * so edges route to real pairs (File→Function, File→Class, Function→Function)
 * — exercising the U2 router across multiple label pairs. Node `content` is
 * never populated (no backing files), so emit cost reflects the CSV machinery
 * (routing, escaping, buffering, disk writes), not content extraction.
 */
function generateGraph(entityCount) {
  const graph = createKnowledgeGraph();
  for (let i = 0; i < entityCount; i++) {
    const fp = `src/e${i}.ts`;
    const fileId = `File:${fp}`;
    const fnA = `Function:${fp}:fnA:1`;
    const fnB = `Function:${fp}:fnB:10`;
    const cls = `Class:${fp}:C:20`;
    graph.addNode({ id: fileId, label: 'File', properties: { name: `e${i}.ts`, filePath: fp } });
    graph.addNode({
      id: fnA,
      label: 'Function',
      properties: { name: 'fnA', filePath: fp, startLine: 1, endLine: 5, isExported: true },
    });
    graph.addNode({
      id: fnB,
      label: 'Function',
      properties: { name: 'fnB', filePath: fp, startLine: 10, endLine: 15, isExported: false },
    });
    graph.addNode({
      id: cls,
      label: 'Class',
      properties: { name: 'C', filePath: fp, startLine: 20, endLine: 30, isExported: true },
    });
    graph.addRelationship({
      id: `${fileId}->${fnA}`,
      sourceId: fileId,
      targetId: fnA,
      type: 'CONTAINS',
      confidence: 1,
      reason: '',
    });
    graph.addRelationship({
      id: `${fileId}->${fnB}`,
      sourceId: fileId,
      targetId: fnB,
      type: 'CONTAINS',
      confidence: 1,
      reason: '',
    });
    graph.addRelationship({
      id: `${fileId}->${cls}`,
      sourceId: fileId,
      targetId: cls,
      type: 'CONTAINS',
      confidence: 1,
      reason: '',
    });
    graph.addRelationship({
      id: `${fnA}->${fnB}`,
      sourceId: fnA,
      targetId: fnB,
      type: 'CALLS',
      confidence: 1,
      reason: '',
    });
  }
  return graph;
}

// ---- byte-identity fingerprint (order-independent) ----

/** sha256 over every non-empty line of every emitted CSV file, sorted so the
 * digest is a pure function of the emitted line SET (insertion-order agnostic). */
async function fingerprintEmit(graph, dir) {
  await streamAllCSVsToDisk(graph, path.join(dir, 'no-such-repo'), dir);
  // Per-file digest bound to the filename: a row routed to the WRONG pair file
  // (or a header written to the wrong file) changes the fingerprint — a global
  // line-flatten could not catch that. File bytes are hashed as-written (so it
  // also catches within-file row reordering); the entry list is sorted so
  // readdir order doesn't matter.
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.csv')) continue;
    const bytes = await fsp.readFile(path.join(dir, name));
    entries.push(`${name}\n${crypto.createHash('sha256').update(bytes).digest('hex')}`);
  }
  return crypto.createHash('sha256').update(entries.sort().join('\n')).digest('hex');
}

// ---- timing ----

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function timeEmit(graph, dir, reps) {
  await streamAllCSVsToDisk(graph, path.join(dir, 'no-such-repo'), dir); // warmup (not counted)
  const samples = [];
  for (let i = 0; i < reps; i++) {
    const start = process.hrtime.bigint();
    await streamAllCSVsToDisk(graph, path.join(dir, 'no-such-repo'), dir);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return median(samples);
}

const SMALL = 600;
const LARGE = 2400;
const REPS = 5;

async function measure() {
  const tmpRoot = path.join(os.tmpdir(), `gitnexus-emit-bench-${process.pid}`);
  await fsp.mkdir(tmpRoot, { recursive: true });
  try {
    const smallGraph = generateGraph(SMALL);
    const largeGraph = generateGraph(LARGE);

    const fingerprint = await fingerprintEmit(largeGraph, path.join(tmpRoot, 'fp'));
    const small = await timeEmit(smallGraph, path.join(tmpRoot, 'small'), REPS);
    const large = await timeEmit(largeGraph, path.join(tmpRoot, 'large'), REPS);
    const scalingRatio = small > 0 ? large / small / (LARGE / SMALL) : 0;

    return {
      scenario: 'streamAllCSVsToDisk',
      entities_small: SMALL,
      entities_large: LARGE,
      nodes_large: LARGE * 4,
      rels_large: LARGE * 4,
      elapsed_ms_small: Number(small.toFixed(2)),
      elapsed_ms_large: Number(large.toFixed(2)),
      scaling_ratio: Number(scalingRatio.toFixed(3)),
      fingerprint,
    };
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- run ----

const CHECK = process.argv.includes('--check');
const result = await measure();

if (!CHECK) {
  process.stdout.write(JSON.stringify(result) + '\n');
} else {
  const base = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const failures = [];
  if (result.fingerprint !== base.fingerprint) {
    failures.push(
      `byte-identity fingerprint drift (got ${result.fingerprint}, expected ${base.fingerprint})`,
    );
  }
  if (result.scaling_ratio >= base.scaling_budget) {
    failures.push(
      `scaling ratio ${result.scaling_ratio} >= budget ${base.scaling_budget} ` +
        `(${SMALL}->${LARGE} entities, ms ${result.elapsed_ms_small}->${result.elapsed_ms_large})`,
    );
  }
  // Absolute backstop: the scaling ratio alone passes a uniform Nx slowdown (it
  // only compares large/small). A generous, host-noise-tolerant ceiling catches
  // a gross absolute regression. Opt-in (only enforced when max_ms_large is set).
  if (base.max_ms_large !== undefined && result.elapsed_ms_large >= base.max_ms_large) {
    failures.push(
      `absolute wall-time regression: elapsed_ms_large ${result.elapsed_ms_large}ms >= budget ` +
        `${base.max_ms_large}ms (coarse backstop, not a tight SLA)`,
    );
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`[emit-persistence --check] FAIL: ${f}\n`);
    process.exit(1);
  }
  process.stderr.write('[emit-persistence --check] PASS\n');
}
