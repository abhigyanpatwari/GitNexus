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
 * For each scenario it reports `elapsed_ms` at small/large and a scaling ratio
 * `(t_large/t_small)/(N_large/N_small)`: ~1.0 is linear, ~4.0 is quadratic (the
 * O(n²) shape the M1 perf review flagged for `extendBlock`'s concat chain).
 * It also computes an order-independent sha256 fingerprint over the emitted
 * blocks/edges of a fixed-size source — the correctness gate that a structural
 * speedup must leave behavior-identical.
 *
 * Build-free: imports the `.ts` hotpaths through tsx
 * (`node --import tsx bench/cfg/measure.mjs`). Parsing happens ONCE per size and
 * the tree is reused across reps so the measurement isolates CFG build cost, not
 * tree-sitter parse time. `maxFunctionLines` is 0 (no cap) here on purpose — the
 * bench measures the algorithm; the production default cap is a separate safety
 * net (and would otherwise skip the large straight-line function).
 *
 * Without args: prints one JSON object per scenario.
 * With `--check`: asserts each scenario's fingerprint == its committed baseline
 * (baselines.json) AND scaling_ratio < its recorded budget; exits non-zero on
 * any drift/regression.
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
const REPS = 7;
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
    // Serialized size of the cfgSideChannel payload — what rides on every
    // ParsedFile through the disk store + parse cache. Should scale linearly
    // with source (O(source covered)); a super-linear bytes ratio means the
    // CFG is duplicating text and will bloat warm-cache shards at scale.
    bytes: JSON.stringify(out.cfgs).length,
  };
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
  const small = measureCollect(scenario.gen(SMALL), `${scenario.name}.ts`, REPS);
  const large = measureCollect(scenario.gen(LARGE), `${scenario.name}.ts`, REPS);
  const sizeRatio = LARGE / SMALL;
  const scalingRatio = small.ms > 0 ? large.ms / small.ms / sizeRatio : 0;
  const bytesRatio = small.bytes > 0 ? large.bytes / small.bytes / sizeRatio : 0;
  return {
    scenario: scenario.name,
    elapsed_ms_small: Number(small.ms.toFixed(3)),
    elapsed_ms_large: Number(large.ms.toFixed(3)),
    scaling_ratio: Number(scalingRatio.toFixed(3)),
    bytes_small: small.bytes,
    bytes_large: large.bytes,
    bytes_ratio: Number(bytesRatio.toFixed(3)),
    blocks_small: small.blockCount,
    blocks_large: large.blockCount,
    ...fingerprint(scenario),
  };
}

// ---- run ----

const CHECK = process.argv.includes('--check');
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
    if (base.bytes_budget !== undefined && r.bytes_ratio >= base.bytes_budget) {
      failures.push(
        `${r.scenario}: cfgSideChannel bytes ratio ${r.bytes_ratio} >= budget ${base.bytes_budget} ` +
          `(bytes ${r.bytes_small}->${r.bytes_large})`,
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
