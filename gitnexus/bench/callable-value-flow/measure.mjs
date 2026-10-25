/**
 * Build-free throughput + identity bench for `buildGraphTargetIndex`, the
 * callable-value-flow target index (issue #2693).
 *
 * #2693 widened this function's gate: before it, only Function/Method/
 * Constructor defs were considered; now VALUE bindings (Const/Property/Static/
 * Variable) are considered too, because a closure bound to a name declares as a
 * value but emits a callable graph node (#2687). Value bindings usually
 * OUTNUMBER callables in real source, so the widening puts the hot loop's cost
 * on a much larger def population — this bench exists to keep that honest.
 *
 * Value bindings are joined to their callable node POSITIONALLY
 * (`file\0line\0name`); they never run the `resolveDefGraphId` key chain,
 * whose label-agnostic `simpleKey` fallback would alias a binding onto any
 * same-named callable in the file.
 *
 * For a synthetic corpus at two scales it reports:
 *   - elapsed_ms_small / elapsed_ms_large (median of window minima) + a scaling ratio
 *     `(t_large/t_small)/(LARGE/SMALL)`: ~1.0 linear, ~3.x quadratic;
 *   - `callable_only_ms_large`, the same corpus with the PRE-#2693 def
 *     population, so the cost the widening actually added stays visible as
 *     `widening_overhead` rather than being folded into one opaque number;
 *   - an order-independent sha256 fingerprint over every (defNodeId → graphId)
 *     pair the index resolves, as the correctness gate. A fingerprint change
 *     means the set of callable-value targets moved — that is a behaviour
 *     change, never a performance one.
 *
 * Build-free: imports the `.ts` hotpaths through tsx
 * (`node --import tsx bench/callable-value-flow/measure.mjs`). Static `.ts`
 * imports work; a top-level `await import()` breaks tsx's lexer.
 *
 * Without args: prints one JSON object per scale plus the summary.
 * With `--check`: asserts the fingerprint == the committed baseline AND both
 * the scaling ratio and the widening overhead are within their recorded
 * budgets; exits non-zero on drift/regression.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createKnowledgeGraph } from '../../src/core/graph/graph.ts';
import { buildGraphNodeLookup } from '../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.ts';
import { buildGraphTargetIndex } from '../../src/core/ingestion/scope-resolution/passes/callable-value-flow.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');

const SMALL = 250;
const LARGE = 800;
const REPS = 7;
const WARMUP = 2;
const WINDOW_MS = 1000;

/**
 * Deterministic synthetic corpus — no randomness, so the fingerprint is stable.
 *
 * Per file: 2 free functions, 1 class with 2 methods, and 8 value bindings. Of
 * those 8, ONE is a closure binding: it declares as a value but its only graph
 * node is a `Function` (exactly what #2687 emits, and the sole case the widened
 * gate is meant to admit). The other 7 keep their own value node, so they must
 * be REJECTED — they are the population whose cost the widening added.
 *
 * The 7:1 reject:admit ratio is the point: the loop must reject seven bindings
 * cheaply for every one it admits. The closure binding's callable node sits at
 * the SAME line as its def, which is what the positional join keys on; the
 * seven others have their own value node at their own line and must not be
 * admitted by any name coincidence.
 */
function buildCorpus(fileCount) {
  const graph = createKnowledgeGraph();
  const defs = new Map();

  // `line` is 1-based (the convention definition ids use); graph nodes store a
  // 0-BASED startLine, and the positional join in buildGraphTargetIndex is what
  // reconciles the two. Modelling that off by one here would silently stop the
  // bench from exercising the value-binding path at all.
  const addNode = (label, filePath, qualifiedName, line) => {
    const id = `${label}:${filePath}:${qualifiedName}`;
    graph.addNode({
      id,
      label,
      properties: {
        filePath,
        name: qualifiedName.split('.').pop(),
        qualifiedName,
        startLine: line - 1,
      },
    });
    return id;
  };
  const addDef = (type, filePath, qualifiedName, line) => {
    const nodeId = `def:${filePath}#${line}:0:${type}:${qualifiedName}`;
    defs.set(nodeId, { nodeId, type, filePath, qualifiedName });
  };

  for (let f = 0; f < fileCount; f++) {
    const filePath = `src/module${f}/file${f}.ts`;
    let line = 1;

    for (let i = 0; i < 2; i++, line++) {
      addNode('Function', filePath, `fn${i}`, line);
      addDef('Function', filePath, `fn${i}`, line);
    }

    addNode('Class', filePath, `Cls`, line);
    for (let i = 0; i < 2; i++, line++) {
      addNode('Method', filePath, `Cls.m${i}`, line);
      addDef('Method', filePath, `Cls.m${i}`, line);
    }

    // 1 closure binding: value def, callable node, NO value node.
    addNode('Function', filePath, `handler`, line);
    addDef('Const', filePath, `handler`, line);
    line++;

    // 7 ordinary value bindings: value def AND its own value node → rejected.
    const valueLabels = [
      'Const',
      'Variable',
      'Property',
      'Static',
      'Const',
      'Variable',
      'Property',
    ];
    for (let i = 0; i < valueLabels.length; i++, line++) {
      const label = valueLabels[i];
      addNode(label, filePath, `value${i}`, line);
      addDef(label, filePath, `value${i}`, line);
    }
  }

  return { graph, scopes: { defs: { byId: defs } }, nodeLookup: buildGraphNodeLookup(graph) };
}

/** Only the pre-#2693 def population, for the overhead comparison. */
function callableOnlyScopes(scopes) {
  const byId = new Map();
  for (const [id, def] of scopes.defs.byId) {
    if (def.type === 'Function' || def.type === 'Method' || def.type === 'Constructor') {
      byId.set(id, def);
    }
  }
  return { defs: { byId } };
}

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function timeIndex(scopes, nodeLookup, graph) {
  // A short handful of calls can all overlap JIT, GC or scheduler pauses.
  // Keep the uncontended-cost estimator, but give each variant a full window
  // to reach it. Retaining only the minimum also bounds sampling memory.
  const start = performance.now();
  let best = Infinity;
  let last;
  do {
    const t0 = performance.now();
    last = buildGraphTargetIndex(scopes, nodeLookup, undefined, graph);
    best = Math.min(best, performance.now() - t0);
  } while (performance.now() - start < WINDOW_MS);
  return { ms: best, result: last };
}

function fingerprint(targets) {
  const lines = [...targets.entries()].map(([defId, t]) => `${defId}\u0000${t.id}`).sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

const cases = [
  ['small', SMALL],
  ['large', LARGE],
].map(([name, files]) => ({ name, files, ...buildCorpus(files) }));
const variants = cases.flatMap((corpus) => [
  corpus,
  { ...corpus, scopes: callableOnlyScopes(corpus.scopes) },
]);
const samples = variants.map(() => []);
const results = [];
// Measure all four variants in each round, reversing their order to avoid
// consistently favouring one tier or scale. Discard complete warmup rounds.
// Pair ratios within rounds so a change in runner load does not compare a
// quiet control period with a busy widened period (or small with large).
for (let round = 0; round < WARMUP + REPS; round++) {
  for (const i of round % 2 === 0 ? [0, 1, 2, 3] : [3, 2, 1, 0]) {
    const { scopes, nodeLookup, graph } = variants[i];
    const timed = timeIndex(scopes, nodeLookup, graph);
    results[i] = timed.result;
    if (round >= WARMUP) samples[i].push(timed.ms);
  }
}

const scales = {};
for (const [i, corpus] of cases.entries()) {
  scales[corpus.name] = {
    files: corpus.files,
    defs: corpus.scopes.defs.byId.size,
    ms: median(samples[i * 2]),
    callable_only_ms: median(samples[i * 2 + 1]),
    targets: results[i * 2].size,
    callable_only_targets: results[i * 2 + 1].size,
    fingerprint: fingerprint(results[i * 2]),
  };
}

const scalingRatio = median(samples[2].map((ms, i) => ms / samples[0][i] / (LARGE / SMALL)));
// How much slower the widened gate is than the pre-#2693 one on the same
// corpus. 1.0 = free; 2.0 = the widening doubled the index build.
const wideningOverhead = median(samples[2].map((ms, i) => ms / samples[3][i]));

const report = {
  small: scales.small,
  large: scales.large,
  scaling_ratio: Number(scalingRatio.toFixed(3)),
  widening_overhead: Number(wideningOverhead.toFixed(3)),
  fingerprint: scales.large.fingerprint,
};

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
const failures = [];
if (report.fingerprint !== baseline.fingerprint) {
  failures.push(
    `fingerprint drift: ${report.fingerprint} != ${baseline.fingerprint} — the resolved ` +
      `callable-value target set CHANGED. This is a behaviour change, not a perf one.`,
  );
}
if (report.scaling_ratio > baseline.scaling_budget) {
  failures.push(`scaling ${report.scaling_ratio} > budget ${baseline.scaling_budget}`);
}
if (report.widening_overhead > baseline.widening_overhead_budget) {
  failures.push(
    `widening overhead ${report.widening_overhead} > budget ${baseline.widening_overhead_budget}`,
  );
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error(`[callable-value-flow --check] FAIL\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('[callable-value-flow --check] PASS');
