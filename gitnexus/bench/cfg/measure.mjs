/**
 * Build-free CFG-construction measurement harness (#2081 M1).
 *
 * Times `collectFunctionCfgs` (the per-function CFG builder the parse worker
 * runs on a `--pdg` run) on synthetic TS sources at two sizes, in three
 * scenarios that each stress a distinct cost dimension:
 *   - `straight-line`: ONE function with N coalescing statements — stresses the
 *     basic-block text accumulation (the `extendBlock` path);
 *   - `many-functions`: N small branchy functions — stresses the collect walk +
 *     per-function build + the tree-sitter `namedChildren` accesses;
 *   - `branchy`: ONE function with N sequential `if`s — stresses block/edge
 *     growth within a single CFG.
 *
 * For each scenario it reports three scaling ratios at small→large
 * (`(metric_large/metric_small)/(N_large/N_small)`: ~1.0 is linear, ~4.0 is the
 * O(n²) shape the M1 perf review flagged for `extendBlock`'s concat chain):
 *   - TIME — wall-clock of `collectFunctionCfgs` (median of reps);
 *   - DISK — utf8 byte size of the serialized `cfgSideChannel` (what a `--pdg`
 *     run writes onto every ParsedFile shard);
 *   - MEMORY — retained JS heap of the `cfgSideChannel` payload, by the
 *     release-delta method (heap held minus heap after dropping it). Requires
 *     `node --expose-gc`; without it the heap metric is null and its gate skips.
 * It also computes an order-independent sha256 fingerprint over the emitted
 * blocks/edges of a fixed-size source — the correctness gate that a structural
 * speedup must leave behavior-identical.
 *
 * Build-free: imports the `.ts` hotpaths through tsx
 * (`node --expose-gc --import tsx bench/cfg/measure.mjs`). Parsing happens ONCE
 * per size and the tree is reused across reps so the time measurement isolates
 * CFG build cost, not tree-sitter parse time. `maxFunctionLines` is 0 (no cap)
 * here on purpose — the bench measures the algorithm; the production default cap
 * is a separate safety net (and would otherwise skip the large straight-line fn).
 *
 * Without args: prints one JSON object per scenario.
 * With `--check`: asserts each scenario's fingerprint == its committed baseline
 * (baselines.json) AND each of the time / disk / heap ratios is below its
 * recorded budget; exits non-zero on any drift/regression.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { collectFunctionCfgs } from '../../src/core/ingestion/cfg/collect.ts';
import { computeReachingDefs } from '../../src/core/ingestion/cfg/reaching-defs.ts';
import { DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION } from '../../src/core/ingestion/cfg/emit.ts';
import { createTypeScriptCfgVisitor } from '../../src/core/ingestion/cfg/visitors/typescript.ts';
import { getTreeSitterBufferSize } from '../../src/core/ingestion/constants.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');

const visitor = createTypeScriptCfgVisitor();
const parser = new Parser();
parser.setLanguage(TypeScript.typescript);
// Large synthetic sources exceed tree-sitter's default read buffer; size it
// from the content exactly as the parse worker does (getTreeSitterBufferSize).
const parse = (src) => parser.parse(src, undefined, { bufferSize: getTreeSitterBufferSize(src) });

// ---- synthetic generators (one cost dimension each) ----

const SCENARIOS = [
  {
    name: 'straight-line',
    // One function, N coalescing simple statements → all fold into one basic
    // block whose text is accumulated statement-by-statement (extendBlock).
    // Uses LARGER sizes than the other scenarios: this scenario's only cost
    // dimension is text accumulation (output size is constant — 4 blocks at any
    // N — so the disk/heap ratios can't see it), so the TIME ratio is the sole
    // guard against an extendBlock O(n²)-concat re-regression. At small N a
    // quadratic is masked by V8 cons-strings + the linear tree-walk and slips
    // under the budget; these larger sizes make a real quadratic separate
    // cleanly (verified: a `+=` regression here exceeds the budget, the
    // array-join impl stays ~1).
    small: 2000,
    large: 8000,
    gen: (n) => {
      let s = 'function f() {\n';
      for (let i = 0; i < n; i++) s += `  let v${i} = ${i} + 1;\n`;
      return s + '  return v0;\n}\n';
    },
  },
  {
    name: 'many-functions',
    // N independent small functions with a branch + return → stresses the
    // tree walk in collectFunctionCfgs and the per-function build.
    gen: (n) => {
      let s = '';
      for (let i = 0; i < n; i++) {
        s += `function f${i}(x: number) { if (x > ${i}) { a(); } else { b(); } return x + ${i}; }\n`;
      }
      return s;
    },
  },
  {
    name: 'branchy',
    // One function, N sequential `if`s → N condition blocks + 2N+ edges in a
    // single CFG; stresses block/edge growth and namedChildren on the body.
    gen: (n) => {
      let s = 'function f(x: number) {\n';
      for (let i = 0; i < n; i++) s += `  if (x > ${i}) { s${i}(); }\n`;
      return s + '}\n';
    },
  },
  {
    name: 'dense-bindings',
    // #2082 M2: N bindings live across ~N blocks inside one loop — bindings ×
    // blocks scale JOINTLY, the discriminator for solver-lattice quadratics.
    // The overlay design (KTD2: sets shared by reference, OUT spine-copied
    // only on gen) is expected to scale ~linearly-with-a-spine-copy here
    // (normalized ratio low single digits); the regression this scenario
    // exists to catch is the repo's recurring per-item-rescan shape — a
    // per-use scan over all defs (O(n³) here) blows the ratio past ~16.
    // rd time is the gated metric (rd_scaling_budget).
    rdMaxFacts: 0, // measure the algorithm, not the cap
    gen: (n) => {
      let s = 'function f(c: number) {\n';
      for (let i = 0; i < n; i++) s += `  let v${i} = ${i};\n`;
      s += '  while (c > 0) {\n';
      for (let i = 0; i < n; i++) s += `    if (c > ${i}) { v${i} = v${(i + 1) % n} + 1; }\n`;
      return s + '    c = c - 1;\n  }\n  return v0;\n}\n';
    },
  },
  {
    name: 'fact-fanout',
    // #2082 M2: N parallel case-arm defs of one variable + N later uses —
    // facts are O(defs×uses) BY SPEC, so a linearity ratio gate is the wrong
    // shape. The gate here is BOUNDEDNESS: with the production fact limit
    // engaged, the materialized fact count stays FLAT (== limit) as N grows
    // past it (facts_large_max), and rd time stays bounded. An unbounded
    // materialization regression (losing the maxFacts early-stop) shows as
    // facts_large exploding quadratically.
    rdMaxFacts: DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION,
    gen: (n) => {
      let s = 'function f(c: number) {\n  let x = 0;\n  switch (c) {\n';
      for (let i = 0; i < n; i++) s += `    case ${i}: x = ${i}; break;\n`;
      s += '  }\n';
      for (let i = 0; i < n; i++) s += `  u${i}(x);\n`;
      return s + '}\n';
    },
  },
];

const SMALL = 500;
const LARGE = 2000; // 4× — O(n) ⇒ ratio ~1, O(n²) ⇒ ratio ~4
const REPS = 15; // median over more reps → stabler time signal at small absolute ms
const FP_SIZE = 15; // fixed size for the behavior fingerprint
const NO_CAP = 0; // measure the algorithm, not the production safety cap

// ---- timing ----

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function measureCollect(src, file, reps) {
  const root = parse(src).rootNode; // parse ONCE; reuse across reps
  collectFunctionCfgs(root, visitor, `warmup-${file}`, NO_CAP); // warm JIT (uncounted)
  const samples = [];
  let out;
  for (let i = 0; i < reps; i++) {
    const start = process.hrtime.bigint();
    out = collectFunctionCfgs(root, visitor, file, NO_CAP);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return {
    ms: median(samples),
    cfgs: out.cfgs,
    blockCount: out.cfgs.reduce((a, c) => a + c.blocks.length, 0),
    // DISK growth: utf8 byte size of the serialized cfgSideChannel — exactly
    // what a --pdg run writes onto every ParsedFile shard in the durable store
    // + parse cache (the field is plain JSON, so this is the on-disk delta).
    // Should scale linearly with source covered; a super-linear ratio means the
    // CFG duplicates text and bloats warm-cache shards at scale.
    diskBytes: Buffer.byteLength(JSON.stringify(out.cfgs), 'utf8'),
  };
}

// ---- reaching-defs solve cost (#2082 M2) ----

// Times computeReachingDefs over a scenario's collected CFGs (the exact work
// the scope-resolution emit loop adds per file on a --pdg run). `maxFacts`
// mirrors the per-scenario production posture: 0 (unlimited) measures the
// algorithm; the production default exercises the boundedness contract.
function measureReachingDefs(cfgs, reps, maxFacts) {
  for (const c of cfgs) computeReachingDefs(c, { maxFacts }); // warm JIT
  const samples = [];
  let facts = 0;
  for (let i = 0; i < reps; i++) {
    const start = process.hrtime.bigint();
    facts = 0;
    for (const c of cfgs) facts += computeReachingDefs(c, { maxFacts }).facts.length;
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { ms: median(samples), facts };
}

// ---- memory growth: retained heap of the cfgSideChannel payload ----

// Needs `node --expose-gc` to force collection for a clean delta; without it the
// heap metric is reported as null and its --check gate is skipped (so a local
// run without the flag still works).
const GC = typeof global.gc === 'function' ? () => (global.gc(), global.gc()) : null;

function retainedHeapBytes(src, file) {
  if (!GC) return null;
  // Retained-size-by-RELEASE: measure the heap with the CFGs held, drop them,
  // GC, measure again. The drop isolates exactly the JS heap the cfgSideChannel
  // payload retains (the extra RAM a --pdg run carries per file until the shard
  // is flushed) — robust to pre-existing garbage, which is constant across both
  // measurements. The parse tree is a temporary (its native memory isn't on the
  // JS heap); block text strings are fresh copies, so they count here.
  let cfgs = collectFunctionCfgs(parse(src).rootNode, visitor, file, NO_CAP).cfgs;
  GC();
  const withCfgs = process.memoryUsage().heapUsed;
  if (cfgs.length < 0) throw new Error('unreachable'); // keep cfgs live past withCfgs
  cfgs = null;
  GC();
  const withoutCfgs = process.memoryUsage().heapUsed;
  return Math.max(0, withCfgs - withoutCfgs);
}

// ---- correctness fingerprint (order-independent over blocks + edges) ----

function canonicalizeCfg(cfg) {
  const blocks = cfg.blocks
    .map(
      (b) =>
        `B|${b.index}|${b.startLine}-${b.endLine}|${b.kind}|${b.text}|` +
        // #2082 M2: statement facts join the canon so harvest drift (lost
        // defs/uses, changed binding resolution) trips the fingerprint gate.
        JSON.stringify(b.statements ?? null),
    )
    .sort();
  const edges = cfg.edges.map((e) => `E|${e.from}->${e.to}|${e.kind}`).sort();
  const bindings = JSON.stringify(cfg.bindings ?? null);
  return `${cfg.functionStartLine}:${cfg.functionStartColumn}\n${bindings}\n${blocks.join('\n')}\n${edges.join('\n')}`;
}

function fingerprint(scenario) {
  const out = collectFunctionCfgs(parse(scenario.gen(FP_SIZE)).rootNode, visitor, 'fp.ts', NO_CAP);
  const canon = out.cfgs.map(canonicalizeCfg).sort().join('\n====\n');
  return {
    fingerprint: crypto.createHash('sha256').update(canon).digest('hex'),
    fp_cfgs: out.cfgs.length,
    fp_blocks: out.cfgs.reduce((a, c) => a + c.blocks.length, 0),
    fp_edges: out.cfgs.reduce((a, c) => a + c.edges.length, 0),
  };
}

function measureScenario(scenario) {
  // Per-scenario sizes (straight-line needs larger N to separate a concat
  // quadratic from noise — see its comment); the rest default to the globals.
  const nSmall = scenario.small ?? SMALL;
  const nLarge = scenario.large ?? LARGE;
  const small = measureCollect(scenario.gen(nSmall), `${scenario.name}.ts`, REPS);
  const large = measureCollect(scenario.gen(nLarge), `${scenario.name}.ts`, REPS);
  const sizeRatio = nLarge / nSmall;
  const scalingRatio = small.ms > 0 ? large.ms / small.ms / sizeRatio : 0;
  const diskRatio = small.diskBytes > 0 ? large.diskBytes / small.diskBytes / sizeRatio : 0;

  // Memory growth (only when --expose-gc gave us a forced GC).
  const heapSmall = retainedHeapBytes(scenario.gen(nSmall), `${scenario.name}.ts`);
  const heapLarge = retainedHeapBytes(scenario.gen(nLarge), `${scenario.name}.ts`);
  const heapRatio =
    heapSmall !== null && heapLarge !== null && heapSmall > 0
      ? heapLarge / heapSmall / sizeRatio
      : null;

  // #2082 M2: reaching-defs solve cost over the same CFGs.
  const rdMaxFacts = scenario.rdMaxFacts ?? 0;
  const rdSmall = measureReachingDefs(small.cfgs, REPS, rdMaxFacts);
  const rdLarge = measureReachingDefs(large.cfgs, REPS, rdMaxFacts);
  // Clamp the denominator: a 0.000ms small-N median would otherwise yield
  // ratio 0 and the gate would self-disable exactly when the solver is fast.
  const rdRatio = rdLarge.ms / Math.max(rdSmall.ms, 0.001) / sizeRatio;

  return {
    scenario: scenario.name,
    elapsed_ms_small: Number(small.ms.toFixed(3)),
    elapsed_ms_large: Number(large.ms.toFixed(3)),
    scaling_ratio: Number(scalingRatio.toFixed(3)),
    disk_bytes_small: small.diskBytes,
    disk_bytes_large: large.diskBytes,
    disk_bytes_ratio: Number(diskRatio.toFixed(3)),
    heap_bytes_small: heapSmall,
    heap_bytes_large: heapLarge,
    heap_ratio: heapRatio === null ? null : Number(heapRatio.toFixed(3)),
    blocks_small: small.blockCount,
    blocks_large: large.blockCount,
    rd_ms_small: Number(rdSmall.ms.toFixed(3)),
    rd_ms_large: Number(rdLarge.ms.toFixed(3)),
    rd_scaling_ratio: Number(rdRatio.toFixed(3)),
    facts_small: rdSmall.facts,
    facts_large: rdLarge.facts,
    ...fingerprint(scenario),
  };
}

// ---- run ----

const CHECK = process.argv.includes('--check');

// The retained-heap budget is a primary regression detector, but it can only be
// measured with a forced GC. Rather than let `--check` silently PASS with the
// heap gate skipped (a green no-op if someone drops --expose-gc), fail loudly.
if (CHECK && !GC) {
  process.stderr.write(
    '[cfg --check] FAIL: retained-heap gate requires --expose-gc. ' +
      'Run: node --expose-gc --import tsx bench/cfg/measure.mjs --check\n',
  );
  process.exit(1);
}

const results = SCENARIOS.map(measureScenario);

if (!CHECK) {
  for (const r of results) process.stdout.write(JSON.stringify(r) + '\n');
} else {
  const baselines = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const failures = [];
  for (const r of results) {
    const base = baselines[r.scenario];
    if (base === undefined) {
      failures.push(`${r.scenario}: no baseline recorded`);
      continue;
    }
    if (r.fingerprint !== base.fingerprint) {
      failures.push(
        `${r.scenario}: CFG fingerprint drift (got ${r.fingerprint}, expected ${base.fingerprint})`,
      );
    }
    if (r.scaling_ratio >= base.scaling_budget) {
      failures.push(
        `${r.scenario}: scaling ratio ${r.scaling_ratio} >= budget ${base.scaling_budget} ` +
          `(${SMALL}->${LARGE} stmts/fns, ms ${r.elapsed_ms_small}->${r.elapsed_ms_large})`,
      );
    }
    if (base.disk_bytes_budget !== undefined && r.disk_bytes_ratio >= base.disk_bytes_budget) {
      failures.push(
        `${r.scenario}: cfgSideChannel disk-bytes ratio ${r.disk_bytes_ratio} >= budget ` +
          `${base.disk_bytes_budget} (bytes ${r.disk_bytes_small}->${r.disk_bytes_large})`,
      );
    }
    // #2082 M2 gates — rd solve-time scaling, fact-count boundedness, and an
    // ABSOLUTE side-channel size ceiling (a ratio gate is blind to a
    // constant-factor encoding bloat like named records vs indexed facts).
    if (base.rd_scaling_budget !== undefined && r.rd_scaling_ratio >= base.rd_scaling_budget) {
      failures.push(
        `${r.scenario}: reaching-defs scaling ratio ${r.rd_scaling_ratio} >= budget ` +
          `${base.rd_scaling_budget} (ms ${r.rd_ms_small}->${r.rd_ms_large})`,
      );
    }
    if (base.facts_large_max !== undefined && r.facts_large > base.facts_large_max) {
      failures.push(
        `${r.scenario}: fact materialization ${r.facts_large} > bound ${base.facts_large_max} ` +
          `(the maxFacts early-stop is the boundedness contract)`,
      );
    }
    if (base.disk_bytes_large_max !== undefined && r.disk_bytes_large > base.disk_bytes_large_max) {
      failures.push(
        `${r.scenario}: cfgSideChannel absolute size ${r.disk_bytes_large} > ceiling ` +
          `${base.disk_bytes_large_max} bytes (constant-factor encoding bloat)`,
      );
    }
    // Heap gate only when measured (--expose-gc present) AND a budget exists.
    if (
      base.heap_budget !== undefined &&
      r.heap_ratio !== null &&
      r.heap_ratio >= base.heap_budget
    ) {
      failures.push(
        `${r.scenario}: retained-heap ratio ${r.heap_ratio} >= budget ${base.heap_budget} ` +
          `(heap ${r.heap_bytes_small}->${r.heap_bytes_large})`,
      );
    }
    process.stdout.write(JSON.stringify(r) + '\n');
  }
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`[cfg --check] FAIL: ${f}\n`);
    process.exit(1);
  }
  process.stderr.write(`[cfg --check] PASS (${results.length} scenarios)\n`);
}
