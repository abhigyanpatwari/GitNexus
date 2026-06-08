/**
 * Spike S1 (issue #2080, M0) — THROWAWAY benchmark. Not part of the build
 * (scripts/ is excluded from tsconfig) or the test suite.
 *
 * Question: can LadybugDB serve the headline REACHING_DEF query
 *   [:REACHING_DEF*1..5 {variable}]
 * fast enough, and what is the right storage shape for the `variable`?
 *
 * What it does:
 *   1. Builds a synthetic ~100K-edge graph of BasicBlock nodes + REACHING_DEF
 *      edges (variable carried in the CodeRelation `reason` column) with a
 *      realistic per-variable fan-out distribution, and loads it through the
 *      real bulk-COPY path (loadGraphToLbug).
 *   2. Probes whether LadybugDB supports a secondary index on a relationship
 *      property (the crux of the "edge property vs side table" decision).
 *   3. Times the variable-filtered bounded var-length path query.
 *
 * Run:  npx tsx scripts/spikes/s1-reaching-def-index-bench.ts [edgeCount]
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { performance } from 'node:perf_hooks';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';

const EDGE_COUNT = Number(process.argv[2] ?? 30_000);
// Realistic-ish def-use shape: many short chains, variables reused across them.
const CHAIN_LEN = 6; // blocks per function-ish chain
const DISTINCT_VARS = Math.max(1, Math.floor(EDGE_COUNT / 20)); // ~20 edges/variable fan-out

const log = (m: string) => process.stdout.write(m + '\n');

function buildSynthGraph(edgeCount: number): KnowledgeGraph {
  const g = createKnowledgeGraph();
  let edges = 0;
  let chain = 0;
  while (edges < edgeCount) {
    const base = `BasicBlock:synth/f${chain}.ts`;
    for (let i = 0; i <= CHAIN_LEN; i++) {
      g.addNode({
        id: `${base}:${i}`,
        label: 'BasicBlock',
        properties: {
          name: '',
          filePath: `synth/f${chain}.ts`,
          startLine: i,
          endLine: i,
          text: '',
        },
      });
    }
    for (let i = 0; i < CHAIN_LEN && edges < edgeCount; i++) {
      const variable = `v${edges % DISTINCT_VARS}`;
      g.addRelationship({
        id: `${base}:${i}->${i + 1}:${variable}`,
        sourceId: `${base}:${i}`,
        targetId: `${base}:${i + 1}`,
        type: 'REACHING_DEF',
        confidence: 1.0,
        reason: variable, // M0 storage: variable rides `reason`
      });
      edges++;
    }
    chain++;
  }
  return g;
}

async function main() {
  const tmp = path.join(os.tmpdir(), `s1-spike-${Date.now()}`);
  const storagePath = path.join(tmp, '.gitnexus');
  const dbPath = path.join(storagePath, 'lbug');
  await fs.mkdir(dbPath, { recursive: true });

  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  await adapter.initLbug(dbPath);

  log(
    `[S1] building synthetic graph: ~${EDGE_COUNT} REACHING_DEF edges, ` +
      `${DISTINCT_VARS} distinct variables (~20 edges/var fan-out), chains of ${CHAIN_LEN}`,
  );
  const g = buildSynthGraph(EDGE_COUNT);

  let t = performance.now();
  await adapter.loadGraphToLbug(g, tmp, storagePath);
  const loadMs = performance.now() - t;
  const stats = await adapter.getLbugStats();
  log(`[S1] bulk-COPY load: ${loadMs.toFixed(0)}ms  (nodes=${stats.nodes}, edges=${stats.edges})`);

  // (2) Probe: does LadybugDB support a secondary index on a REL property?
  let relIndexSupported = false;
  let relIndexErr = '';
  for (const stmt of [
    "CALL CREATE_REL_INDEX('CodeRelation', 'cr_reason_idx', 'reason')",
    'CREATE INDEX cr_reason_idx ON CodeRelation(reason)',
  ]) {
    try {
      await adapter.executeQuery(stmt);
      relIndexSupported = true;
      break;
    } catch (e: any) {
      relIndexErr = String(e?.message ?? e).split('\n')[0];
    }
  }
  log(
    `[S1] rel-property secondary index supported? ${relIndexSupported}  ` +
      `(last error: ${relIndexErr})`,
  );

  // (3a) Single-hop variable filter — the common case M3 runs most.
  const probeVar = 'v0';
  t = performance.now();
  const single = await adapter.executeQuery(
    `MATCH (a:BasicBlock)-[r:CodeRelation {type: 'REACHING_DEF', reason: '${probeVar}'}]->(b:BasicBlock)
     RETURN count(r) AS c`,
  );
  const singleMs = performance.now() - t;
  log(`[S1] single-hop variable filter → ${single[0]?.c} edges in ${singleMs.toFixed(0)}ms`);

  // (3b) SOURCE-ANCHORED bounded var-length path — the realistic taint query
  // (anchor the source block, then walk REACHING_DEF up to 5 hops). The
  // UNANCHORED global form ([:REACHING_DEF*1..5] from every block) is
  // impractical at scale (path explosion) — that is itself an S1 finding:
  // taint queries MUST be scoped to a source block, not run graph-wide.
  const srcId = 'BasicBlock:synth/f0.ts:0';
  t = performance.now();
  const anchored = await adapter.executeQuery(
    `MATCH p = (a:BasicBlock)-[:CodeRelation*1..5 {type: 'REACHING_DEF'}]->(b:BasicBlock)
     WHERE a.id = '${srcId}' AND all(rel IN relationships(p) WHERE rel.reason = '${probeVar}')
     RETURN count(p) AS paths`,
  );
  const pathMs = performance.now() - t;
  log(
    `[S1] source-anchored [:REACHING_DEF*1..5 {reason='${probeVar}'}] from one block → ` +
      `${anchored[0]?.paths} paths in ${pathMs.toFixed(0)}ms`,
  );

  await adapter.closeLbug();
  await fs.rm(tmp, { recursive: true, force: true });

  log('\n[S1] VERDICT INPUTS:');
  log(
    `  load_ms=${loadMs.toFixed(0)} single_hop_ms=${singleMs.toFixed(0)} anchored_path_ms=${pathMs.toFixed(0)} rel_index=${relIndexSupported}`,
  );
}

main().catch((e) => {
  console.error('[S1] FAILED:', e);
  process.exit(1);
});
