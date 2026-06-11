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
    blockCount: out.cfgs.reduce((a, c) => a + c.blocks.length, 0),
    // DISK growth: utf8 byte size of the serialized cfgSideChannel — exactly
    // what a --pdg run writes onto every ParsedFile shard in the durable store
    // + parse cache (the field is plain JSON, so this is the on-disk delta).
    // Should scale linearly with source covered; a super-linear ratio means the
    // CFG duplicates text and bloats warm-cache shards at scale.
    diskBytes: Buffer.byteLength(JSON.stringify(out.cfgs), 'utf8'),
  };
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
    .map((b) => `B|${b.index}|${b.startLine}-${b.endLine}|${b.kind}|${b.text}`)
    .sort();
  const edges = cfg.edges.map((e) => `E|${e.from}->${e.to}|${e.kind}`).sort();
  return `${cfg.functionStartLine}:${cfg.functionStartColumn}\n${blocks.join('\n')}\n${edges.join('\n')}`;
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
