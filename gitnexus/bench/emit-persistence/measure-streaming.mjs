/**
 * Build-free byte-identity + bounded-retention bench for streaming/chunked PDG
 * graph emit (issue #2202).
 *
 * Proves the two acceptance criteria at scale, without a DB connection:
 *   1. BYTE-IDENTITY (R2): emitting a BasicBlock + intra-file PDG-edge set via
 *      the streaming `PdgEmitSink` produces the IDENTICAL CSV data-row set as
 *      the whole-graph `streamAllCSVsToDisk` path. Compared per file
 *      (basicblock.csv, rel_BasicBlock_BasicBlock.csv) over header-stripped,
 *      sorted lines so it is a pure function of the emitted row SET.
 *   2. BOUNDED RETENTION (R1): with streaming on, the in-memory graph holds
 *      ZERO BasicBlock nodes regardless of how many are emitted — the PDG layer
 *      never accumulates in process memory (peak RSS O(chunk), not O(graph)).
 *
 * Build-free: imports the `.ts` hotpaths through tsx
 * (`node --import tsx bench/emit-persistence/measure-streaming.mjs`).
 *
 * Without args: prints one JSON object. With `--check`: asserts byte-identity,
 * retention, and fingerprint == the committed baseline; exits non-zero on any
 * failure.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createKnowledgeGraph } from '../../src/core/graph/graph.ts';
import { streamAllCSVsToDisk } from '../../src/core/lbug/csv-generator.ts';
import { PdgEmitSink } from '../../src/core/lbug/pdg-emit-sink.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines-streaming.json');

// PDG edge types streamed per file (all intra-block BasicBlock→BasicBlock).
const PDG_TYPES = ['CFG', 'REACHING_DEF', 'CDG', 'POST_DOMINATE', 'TAINTED', 'SANITIZES'];

const FUNCS = 1200; // functions
const BLOCKS = 6; // basic blocks per function ⇒ FUNCS*BLOCKS BasicBlocks total
const CHUNK_ROWS = 64; // tiny streamed buffer to exercise frequent flushing

/**
 * Build the canonical PDG node/edge SET: `FUNCS` functions each with `BLOCKS`
 * BasicBlocks and a chain of intra-function PDG edges. Returns the structural
 * nodes (File/Function) separately from the BasicBlock + PDG-edge layer so the
 * streamed path can route them to different sinks.
 */
function buildSet() {
  const structuralNodes = [];
  const structuralRels = [];
  const bbNodes = [];
  const pdgEdges = [];
  for (let f = 0; f < FUNCS; f++) {
    const fp = `src/m${f % 50}.ts`;
    const fnId = `Function:${fp}:fn${f}:1`;
    structuralNodes.push({
      id: fnId,
      label: 'Function',
      properties: { name: `fn${f}`, filePath: fp, startLine: 1, endLine: 99 },
    });
    for (let b = 0; b < BLOCKS; b++) {
      bbNodes.push({
        id: `BasicBlock:${fp}:1:0:${f}_${b}`,
        label: 'BasicBlock',
        properties: {
          name: '',
          filePath: fp,
          startLine: b * 3,
          endLine: b * 3 + 2,
          text: `f${f}b${b}`,
        },
      });
    }
    for (let b = 0; b < BLOCKS - 1; b++) {
      const from = `BasicBlock:${fp}:1:0:${f}_${b}`;
      const to = `BasicBlock:${fp}:1:0:${f}_${b + 1}`;
      for (const type of PDG_TYPES) {
        pdgEdges.push({
          id: `${type}:${f}:${b}`,
          sourceId: from,
          targetId: to,
          type,
          confidence: 1,
          reason: type === 'REACHING_DEF' ? `v${b}` : type === 'CDG' ? 'T' : '',
        });
      }
    }
  }
  // A few File nodes so the structural emit produces a realistic multi-table mix.
  for (let m = 0; m < 50; m++) {
    structuralNodes.push({
      id: `File:src/m${m}.ts`,
      label: 'File',
      properties: { name: `m${m}.ts`, filePath: `src/m${m}.ts` },
    });
  }
  return { structuralNodes, structuralRels, bbNodes, pdgEdges };
}

/** Header-stripped, sorted, non-empty data rows of one CSV file (or [] if absent). */
async function dataRows(csvPath) {
  let text;
  try {
    text = await fsp.readFile(csvPath, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter((l) => l.length > 0);
  return lines.slice(1).sort(); // drop the header line
}

const sha = (rows) => crypto.createHash('sha256').update(rows.join('\n')).digest('hex');

async function measure() {
  // mkdtemp (unpredictable, unique) rather than a predictable pid-based tmp path.
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stream-bench-'));
  try {
    const { structuralNodes, structuralRels, bbNodes, pdgEdges } = buildSet();

    // ── whole-graph path ─────────────────────────────────────────────────
    const wholeGraph = createKnowledgeGraph();
    for (const n of structuralNodes) wholeGraph.addNode(n);
    for (const n of bbNodes) wholeGraph.addNode(n);
    for (const r of structuralRels) wholeGraph.addRelationship(r);
    for (const e of pdgEdges) wholeGraph.addRelationship(e);
    const wholeDir = path.join(tmpRoot, 'whole');
    await streamAllCSVsToDisk(wholeGraph, path.join(tmpRoot, 'no-repo'), wholeDir);

    // ── streamed path ────────────────────────────────────────────────────
    const realGraph = createKnowledgeGraph();
    const sink = new PdgEmitSink(realGraph, path.join(tmpRoot, 'pdg-csv'), CHUNK_ROWS);
    for (const n of structuralNodes) realGraph.addNode(n); // structural → real graph
    for (const r of structuralRels) realGraph.addRelationship(r);
    for (const n of bbNodes) sink.addNode(n); // BasicBlock layer → sink (CSV)
    for (const e of pdgEdges) sink.addRelationship(e);
    sink.finalize();
    const streamedCsvDir = path.join(tmpRoot, 'streamed');
    await streamAllCSVsToDisk(realGraph, path.join(tmpRoot, 'no-repo'), streamedCsvDir);

    // ── retention (R1): the real graph holds ZERO BasicBlocks ────────────
    let residentBasicBlocks = 0;
    for (const n of realGraph.iterNodes()) if (n.label === 'BasicBlock') residentBasicBlocks++;

    // ── byte-identity (R2): per-file data-row set equality ───────────────
    const wholeBb = await dataRows(path.join(wholeDir, 'basicblock.csv'));
    const streamedBb = await dataRows(path.join(tmpRoot, 'pdg-csv', 'basicblock.csv'));
    const wholeRel = await dataRows(path.join(wholeDir, 'rel_BasicBlock_BasicBlock.csv'));
    const streamedRel = await dataRows(
      path.join(tmpRoot, 'pdg-csv', 'rel_BasicBlock_BasicBlock.csv'),
    );

    const bbIdentical = sha(wholeBb) === sha(streamedBb);
    const relIdentical = sha(wholeRel) === sha(streamedRel);
    // Fingerprint over the canonical PDG data-row set (drift gate).
    const fingerprint = sha([...wholeBb, ...wholeRel].sort());

    return {
      scenario: 'streamingPdgEmit',
      basic_blocks: bbNodes.length,
      pdg_edges: pdgEdges.length,
      chunk_rows: CHUNK_ROWS,
      resident_basic_blocks: residentBasicBlocks,
      byte_identical_nodes: bbIdentical,
      byte_identical_edges: relIdentical,
      fingerprint,
    };
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

const CHECK = process.argv.includes('--check');
const result = await measure();

if (!CHECK) {
  process.stdout.write(JSON.stringify(result) + '\n');
} else {
  const base = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const failures = [];
  if (!result.byte_identical_nodes)
    failures.push('streamed BasicBlock rows differ from whole-graph emit');
  if (!result.byte_identical_edges)
    failures.push('streamed PDG-edge rows differ from whole-graph emit');
  if (result.resident_basic_blocks !== 0) {
    failures.push(
      `RSS bound violated: ${result.resident_basic_blocks} BasicBlock node(s) retained in the in-memory graph (expected 0)`,
    );
  }
  if (result.fingerprint !== base.fingerprint) {
    failures.push(`fingerprint drift (got ${result.fingerprint}, expected ${base.fingerprint})`);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`[stream-pdg-emit --check] FAIL: ${f}\n`);
    process.exit(1);
  }
  process.stderr.write('[stream-pdg-emit --check] PASS\n');
}
