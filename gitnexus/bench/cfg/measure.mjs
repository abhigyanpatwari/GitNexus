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
import { collectFunctionCfgs } from '../../src/core/ingestion/cfg/collect.ts';
import { computeReachingDefs } from '../../src/core/ingestion/cfg/reaching-defs.ts';
import {
  DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION,
  DEFAULT_PDG_MAX_REACHING_DEF_BLOCK_REVISITS,
} from '../../src/core/ingestion/cfg/emit.ts';
import { getTreeSitterBufferSize } from '../../src/core/ingestion/constants.ts';
import { getLanguageGrammar } from '../../src/core/tree-sitter/parser-loader.ts';
import { getProvider } from '../../src/core/ingestion/languages/index.ts';
import { SupportedLanguages } from '../../src/config/supported-languages.ts';
import { buildTaintImportIndex, matchFunctionSites } from '../../src/core/ingestion/taint/match.ts';
import { TS_JS_TAINT_MODEL } from '../../src/core/ingestion/taint/typescript-model.ts';
import {
  computeTaintFlows,
  DEFAULT_PDG_MAX_TAINT_HOPS,
} from '../../src/core/ingestion/taint/propagate.ts';
import { encodeTaintPath } from '../../src/core/ingestion/taint/path-codec.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');

// ---- per-language registry (the U1 parameterization, #2195) ----
//
// A scenario names a `lang` (default 'ts'); the registry resolves its grammar,
// CFG visitor, and (optional) taint model GENERICALLY — the grammar via the
// production `getLanguageGrammar` loader and the visitor via the provider's
// `cfgVisitor` hook (the same seam `cfg-snapshot.test.ts` uses). No language is
// named in the bench logic itself: adding a language is one row here, not a new
// static grammar import (the language-naming anti-pattern). Lazy by design —
// only languages actually referenced by a scenario are loaded, so a missing
// optional grammar never breaks an unrelated run.
//
//   - `grammar`     — SupportedLanguages enum value for `getLanguageGrammar`.
//   - `taintModel`  — source/sink config threaded into the taint pass. ONLY the
//                     TS row carries `TS_JS_TAINT_MODEL`; C-family rows have no
//                     model (matching prod: `getSourceSinkConfig(<c-lang>)` is
//                     `undefined`), so the TS model never runs against a
//                     C-family CFG.
const LANGS = {
  ts: { grammar: SupportedLanguages.TypeScript, taintModel: TS_JS_TAINT_MODEL },
  go: { grammar: SupportedLanguages.Go, taintModel: null },
  java: { grammar: SupportedLanguages.Java, taintModel: null },
  c: { grammar: SupportedLanguages.C, taintModel: null },
  cpp: { grammar: SupportedLanguages.CPlusPlus, taintModel: null },
  csharp: { grammar: SupportedLanguages.CSharp, taintModel: null },
};

// Lazily build + cache one { parser, visitor, parse, taintModel } toolkit per
// language id. The parser is created once and reused across parses/reps for that
// language (parse cost is isolated from CFG-build cost by reusing the tree).
const langToolkitCache = new Map();
function langToolkit(langId) {
  const cached = langToolkitCache.get(langId);
  if (cached) return cached;
  const spec = LANGS[langId];
  if (!spec) throw new Error(`bench: unknown lang '${langId}' (add a row to LANGS)`);
  const visitor = getProvider(spec.grammar).cfgVisitor;
  if (!visitor)
    throw new Error(`bench: provider for '${langId}' has no cfgVisitor (visitor not wired?)`);
  const parser = new Parser();
  parser.setLanguage(getLanguageGrammar(spec.grammar));
  // Large synthetic sources exceed tree-sitter's default read buffer; size it
  // from the content exactly as the parse worker does (getTreeSitterBufferSize).
  const parse = (src) => parser.parse(src, undefined, { bufferSize: getTreeSitterBufferSize(src) });
  const toolkit = { visitor, parse, taintModel: spec.taintModel };
  langToolkitCache.set(langId, toolkit);
  return toolkit;
}

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
    name: 'deep-nest',
    // #2201: N nested loops carrying one variable end-to-end — the pathology the
    // dense GEN/KILL worklist is superlinear on and that drives its block-visit
    // total past the blocks×64 ceiling (it would truncate to an empty result).
    // The production SSA solver is depth-INDEPENDENT (φ-nodes capture the loop
    // merges statically; no fixpoint iteration), so rd time scales ~linearly
    // with depth and the ceiling never fires. Two gates: rd_scaling_budget
    // catches a regression back to superlinear, and facts_large_min asserts the
    // solver still COMPUTES full facts under the PRODUCTION blocks×64 budget
    // (rdProductionBudget) — a dense worklist would report zero facts here.
    small: 40,
    large: 160, // 4×, well under the visitor's recursive-nesting depth guard
    rdMaxFacts: 0, // measure the algorithm, not the cap
    rdProductionBudget: true, // pass blocks×64 — the SSA solver must still compute
    gen: (n) => {
      let s = 'function f(c: number) {\n  let x = 0;\n';
      for (let i = 0; i < n; i++) s += '  '.repeat(i + 1) + `while (c > ${i}) {\n`;
      s += '  '.repeat(n + 1) + 'x = x + 1;\n';
      for (let i = n - 1; i >= 0; i--) s += '  '.repeat(i + 1) + '}\n';
      return s + '  return x;\n}\n';
    },
  },
  {
    name: 'wide-merge',
    // #2201 review R7: N bindings, each assigned in a 3-way branch (a WIDE φ
    // merge per binding) inside a loop, then all used after the merge. Unlike
    // dense-bindings (one chained redef per `if`), every binding here fans into
    // its own multi-operand φ — so the scenario stresses φ-placement + renaming +
    // the reachByScc condensation across MANY independent wide merges. N bindings
    // × constant arms ⇒ O(N) facts, so the gate is rd_scaling LINEARITY: a
    // regression to the per-binding-rescan class (O(N²), the recurring solver
    // antipattern reachByScc's alias fast path guards against) blows the ratio.
    // >=16 blocks + a reachable loop ⇒ the production SSA path.
    rdMaxFacts: 0, // measure the algorithm, not the cap
    rdProductionBudget: true, // prove the SSA path computes under blocks×64
    gen: (n) => {
      let s = 'function f(c: number) {\n';
      for (let i = 0; i < n; i++) s += `  let v${i} = ${i};\n`;
      s += '  while (c > 0) {\n';
      for (let i = 0; i < n; i++) {
        s +=
          `    if (c > ${i}) { v${i} = ${i} + c; }` +
          ` else if (c < ${i}) { v${i} = ${i} - c; }` +
          ` else { v${i} = c; }\n`;
      }
      for (let i = 0; i < n; i++) s += `    use(v${i});\n`;
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
  {
    name: 'taint-dense',
    // #2083 M3 U7 (R10): N functions, EACH source/sink-dense — 12 matched
    // `req.body` source statements + a 4-hop chained reassignment + 13 `eval`
    // sinks per function (13 deduped findings/fn, ABOVE the scenario cap of 8
    // so the cap binds). Functions scale with N, so total findings grow
    // linearly BY DESIGN; the boundedness gate is the per-function pin: kept
    // findings/function stays EXACTLY at the cap as N grows (a cap loss shows
    // as 13). This scenario's sites are the densest of the suite, so its
    // ABSOLUTE disk_bytes_large_max is the load-bearing site-harvest ceiling
    // (the M2 straight-line carrier has no call sites), and the summed
    // encoded TAINTED reason bytes get their own absolute ceiling
    // (taint_reason_bytes_large_max). The zero-match control (genZero) keeps
    // the identical statement/CFG shape with names OUTSIDE the model
    // (inp.payload / evalish) — the match-gate must make unmatched functions
    // cost ~nothing (no solver call), gated as zero-time/dense-time ratio.
    small: 125,
    large: 500, // 4x, like the global sizes — per-fn bodies are ~30 lines
    lang: 'ts', // taint model is TS-only; never run TS_JS_TAINT_MODEL on a C-family CFG
    taint: { cap: 8 },
    gen: (n) => genTaintFunctions(n, false),
    genZero: (n) => genTaintFunctions(n, true),
  },
  {
    name: 'go:branchy',
    // #2195 U7: the first NON-TS scaling scenario — the C-family analogue of the
    // TS `branchy` stressor, run through the Go grammar + Go CFG visitor. ONE Go
    // function with N sequential `if`s → N condition blocks + 2N+ edges in a
    // single CFG; stresses block/edge growth and the namedChildren walk on the
    // Go body. The `go:` namespace keys it out of the TS baseline keyspace so a
    // C-family entry can never collide with (or silently re-baseline) a TS
    // scenario. CFG-only (Go has no registered taint model — see LANGS), so the
    // gated metrics are the time/disk/heap/rd scaling ratios + the fingerprint.
    lang: 'go',
    gen: (n) => {
      let s = 'package p\nfunc f(x int) {\n';
      for (let i = 0; i < n; i++) s += `\tif x > ${i} {\n\t\ts${i}()\n\t}\n`;
      return s + '}\n';
    },
  },
];

// taint-dense generator: `zero` swaps every model-matched name for an
// unmatched one without changing statement count, def/use shape, or CFG.
const TAINT_SOURCES_PER_FN = 12;
const TAINT_CHAIN_HOPS = 4;
function genTaintFunctions(n, zero) {
  const recv = zero ? 'inp' : 'req';
  const prop = zero ? 'payload' : 'body';
  const sink = zero ? 'evalish' : 'eval';
  let s = '';
  for (let i = 0; i < n; i++) {
    s += `function f${i}(${recv}) {\n`;
    for (let j = 0; j < TAINT_SOURCES_PER_FN; j++) s += `  const s${j} = ${recv}.${prop};\n`;
    s += `  let c0 = s0 + '!';\n`;
    for (let h = 1; h < TAINT_CHAIN_HOPS; h++) s += `  const c${h} = c${h - 1} + '!';\n`;
    for (let j = 0; j < TAINT_SOURCES_PER_FN; j++) s += `  ${sink}(s${j});\n`;
    s += `  ${sink}(c${TAINT_CHAIN_HOPS - 1});\n`;
    s += '}\n';
  }
  return s;
}

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

function measureCollect(tk, src, file, reps) {
  const root = tk.parse(src).rootNode; // parse ONCE; reuse across reps
  collectFunctionCfgs(root, tk.visitor, `warmup-${file}`, NO_CAP); // warm JIT (uncounted)
  const samples = [];
  let out;
  for (let i = 0; i < reps; i++) {
    const start = process.hrtime.bigint();
    out = collectFunctionCfgs(root, tk.visitor, file, NO_CAP);
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
// When `blockVisitsMul` > 0 each call also passes the PRODUCTION per-function
// maxBlockVisits budget (blocks × mul). On the deep-nest scenario this is how
// "the ceiling stops firing" (#2201) is measured: the dense worklist would
// truncate to an empty result under this budget, whereas the production SSA
// solver computes the full facts — so a nonzero `facts` under the budget is the
// gate (see facts_large_min in baselines.json).
function measureReachingDefs(cfgs, reps, maxFacts, blockVisitsMul = 0) {
  const limitsFor = (c) =>
    blockVisitsMul > 0
      ? { maxFacts, maxBlockVisits: c.blocks.length * blockVisitsMul }
      : { maxFacts };
  for (const c of cfgs) computeReachingDefs(c, limitsFor(c)); // warm JIT
  const samples = [];
  let facts = 0;
  let allComputed = true;
  for (let i = 0; i < reps; i++) {
    const start = process.hrtime.bigint();
    facts = 0;
    for (const c of cfgs) {
      const r = computeReachingDefs(c, limitsFor(c));
      facts += r.facts.length;
      if (r.status !== 'computed') allComputed = false;
    }
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { ms: median(samples), facts, allComputed };
}

// ---- taint pass cost (#2083 M3 U7) ----

// Times the EXACT per-function sequence the in-phase emit driver runs on a
// --pdg run for a taint-modeled language: match sites → zero-match fast path
// → computeReachingDefs → computeTaintFlows. `cap` is the scenario's
// maxFindingsPerFunction (deliberately small so the cap BINDS on the dense
// generator). Also sums the encoded TAINTED `reason` bytes for the kept
// findings — the persisted-taint disk posture (R10).
function measureTaint(cfgs, reps, cap, taintModel) {
  const importIndex = buildTaintImportIndex([]); // bench callees are globals
  const pass = () => {
    let analyzed = 0;
    let kept = 0;
    let dropped = 0;
    let reasonBytes = 0;
    for (const c of cfgs) {
      const matches = matchFunctionSites(c, taintModel, importIndex);
      if (!matches.hasSource || !matches.hasSink) continue;
      const du = computeReachingDefs(c, {
        maxFacts: DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION,
      });
      const flows = computeTaintFlows(c, du, matches, {
        maxFindingsPerFunction: cap,
        maxHops: DEFAULT_PDG_MAX_TAINT_HOPS,
      });
      if (flows.status !== 'computed') continue;
      analyzed++;
      kept += flows.findings.length;
      dropped += flows.droppedFindings;
      for (const f of flows.findings) {
        // All structural chars + identifier names are single-byte ASCII, so
        // string length IS the byte length (path-codec discipline).
        reasonBytes += encodeTaintPath(
          f.hops.map((h) => ({ name: h.name, line: h.point.line, viaCall: h.viaCall })),
          { truncated: f.hopsTruncated === true, kind: f.sinkKind },
        ).reason.length;
      }
    }
    return { analyzed, kept, dropped, reasonBytes };
  };
  pass(); // warm JIT (uncounted)
  const samples = [];
  let out;
  for (let i = 0; i < reps; i++) {
    const start = process.hrtime.bigint();
    out = pass();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { ms: median(samples), ...out };
}

// ---- memory growth: retained heap of the cfgSideChannel payload ----

// Needs `node --expose-gc` to force collection for a clean delta; without it the
// heap metric is reported as null and its --check gate is skipped (so a local
// run without the flag still works).
const GC = typeof global.gc === 'function' ? () => (global.gc(), global.gc()) : null;

function retainedHeapBytes(tk, src, file) {
  if (!GC) return null;
  // Retained-size-by-RELEASE: measure the heap with the CFGs held, drop them,
  // GC, measure again. The drop isolates exactly the JS heap the cfgSideChannel
  // payload retains (the extra RAM a --pdg run carries per file until the shard
  // is flushed) — robust to pre-existing garbage, which is constant across both
  // measurements. The parse tree is a temporary (its native memory isn't on the
  // JS heap); block text strings are fresh copies, so they count here.
  let cfgs = collectFunctionCfgs(tk.parse(src).rootNode, tk.visitor, file, NO_CAP).cfgs;
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

function fingerprint(tk, scenario) {
  const out = collectFunctionCfgs(
    tk.parse(scenario.gen(FP_SIZE)).rootNode,
    tk.visitor,
    'fp',
    NO_CAP,
  );
  const canon = out.cfgs.map(canonicalizeCfg).sort().join('\n====\n');
  return {
    fingerprint: crypto.createHash('sha256').update(canon).digest('hex'),
    fp_cfgs: out.cfgs.length,
    fp_blocks: out.cfgs.reduce((a, c) => a + c.blocks.length, 0),
    fp_edges: out.cfgs.reduce((a, c) => a + c.edges.length, 0),
  };
}

function measureScenario(scenario) {
  // Resolve the scenario's language toolkit ONCE (default 'ts' keeps every
  // pre-existing TS scenario on the exact same grammar+visitor+model path it
  // used before the U1 parameterization → byte-identical baselines).
  const tk = langToolkit(scenario.lang ?? 'ts');
  // Per-scenario sizes (straight-line needs larger N to separate a concat
  // quadratic from noise — see its comment); the rest default to the globals.
  const nSmall = scenario.small ?? SMALL;
  const nLarge = scenario.large ?? LARGE;
  const small = measureCollect(tk, scenario.gen(nSmall), `${scenario.name}.src`, REPS);
  const large = measureCollect(tk, scenario.gen(nLarge), `${scenario.name}.src`, REPS);
  const sizeRatio = nLarge / nSmall;
  const scalingRatio = small.ms > 0 ? large.ms / small.ms / sizeRatio : 0;
  const diskRatio = small.diskBytes > 0 ? large.diskBytes / small.diskBytes / sizeRatio : 0;

  // Memory growth (only when --expose-gc gave us a forced GC).
  const heapSmall = retainedHeapBytes(tk, scenario.gen(nSmall), `${scenario.name}.src`);
  const heapLarge = retainedHeapBytes(tk, scenario.gen(nLarge), `${scenario.name}.src`);
  const heapRatio =
    heapSmall !== null && heapLarge !== null && heapSmall > 0
      ? heapLarge / heapSmall / sizeRatio
      : null;

  // #2082 M2: reaching-defs solve cost over the same CFGs. #2201: scenarios
  // marked `rdProductionBudget` also pass the per-function blocks×64 ceiling, to
  // prove the production SSA solver still COMPUTES where the dense worklist would
  // truncate (the deep-nest ceiling-stops-firing acceptance).
  const rdMaxFacts = scenario.rdMaxFacts ?? 0;
  const rdBudgetMul = scenario.rdProductionBudget ? DEFAULT_PDG_MAX_REACHING_DEF_BLOCK_REVISITS : 0;
  const rdSmall = measureReachingDefs(small.cfgs, REPS, rdMaxFacts, rdBudgetMul);
  const rdLarge = measureReachingDefs(large.cfgs, REPS, rdMaxFacts, rdBudgetMul);
  // Clamp the denominator: a 0.000ms small-N median would otherwise yield
  // ratio 0 and the gate would self-disable exactly when the solver is fast.
  const rdRatio = rdLarge.ms / Math.max(rdSmall.ms, 0.001) / sizeRatio;

  // #2083 M3 U7: taint pass cost + boundedness on taint-bearing scenarios. The
  // taint model is the scenario's language model (TS_JS_TAINT_MODEL for the TS
  // taint-dense scenario; a taint scenario requires a model-bearing language).
  let taintMetrics = {};
  if (scenario.taint !== undefined) {
    if (!tk.taintModel)
      throw new Error(
        `bench: scenario '${scenario.name}' has a taint config but lang '${scenario.lang ?? 'ts'}' has no taint model`,
      );
    const cap = scenario.taint.cap;
    const tSmall = measureTaint(small.cfgs, REPS, cap, tk.taintModel);
    const tLarge = measureTaint(large.cfgs, REPS, cap, tk.taintModel);
    const tRatio = tLarge.ms / Math.max(tSmall.ms, 0.001) / sizeRatio;
    // Zero-match control: identical CFG shape, no model hits — measures the
    // match-gate overhead unmatched functions pay on a real --pdg repo.
    const zeroCfgs = collectFunctionCfgs(
      tk.parse(scenario.genZero(nLarge)).rootNode,
      tk.visitor,
      `${scenario.name}-zero.src`,
      NO_CAP,
    ).cfgs;
    const tZero = measureTaint(zeroCfgs, REPS, cap, tk.taintModel);
    taintMetrics = {
      taint_ms_small: Number(tSmall.ms.toFixed(3)),
      taint_ms_large: Number(tLarge.ms.toFixed(3)),
      taint_scaling_ratio: Number(tRatio.toFixed(3)),
      // Boundedness: kept findings PER ANALYZED FUNCTION (total findings grow
      // linearly with N by design — the per-function pin is the cap gate).
      taint_findings_per_fn_small: tSmall.analyzed > 0 ? tSmall.kept / tSmall.analyzed : 0,
      taint_findings_per_fn_large: tLarge.analyzed > 0 ? tLarge.kept / tLarge.analyzed : 0,
      taint_dropped_large: tLarge.dropped,
      taint_reason_bytes_large: tLarge.reasonBytes,
      taint_zero_ms_large: Number(tZero.ms.toFixed(3)),
      taint_zero_findings: tZero.kept + tZero.dropped,
      taint_zero_match_ratio: Number((tZero.ms / Math.max(tLarge.ms, 0.001)).toFixed(3)),
    };
  }

  return {
    ...taintMetrics,
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
    rd_all_computed: rdLarge.allComputed,
    ...fingerprint(tk, scenario),
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
    // #2201 deep-nest: under the PRODUCTION blocks×64 budget the SSA solver must
    // still COMPUTE full facts (a nonzero floor) where the dense worklist would
    // truncate to empty — "the ceiling stops firing".
    if (base.facts_large_min !== undefined && r.facts_large < base.facts_large_min) {
      failures.push(
        `${r.scenario}: only ${r.facts_large} facts < floor ${base.facts_large_min} under the ` +
          `production block-visit budget — the ceiling fired (SSA should not truncate here)` +
          (r.rd_all_computed ? '' : ` [status != computed]`),
      );
    }
    // Independent of the fact-count floor: under the production budget every
    // function in a facts_large_min scenario must report status 'computed'. This
    // catches a partial-truncation regression that still clears the count floor.
    if (base.facts_large_min !== undefined && r.rd_all_computed === false) {
      failures.push(
        `${r.scenario}: a function did not reach status 'computed' under the production ` +
          `block-visit budget — the SSA solver truncated where it must compute`,
      );
    }
    if (base.disk_bytes_large_max !== undefined && r.disk_bytes_large > base.disk_bytes_large_max) {
      failures.push(
        `${r.scenario}: cfgSideChannel absolute size ${r.disk_bytes_large} > ceiling ` +
          `${base.disk_bytes_large_max} bytes (constant-factor encoding bloat)`,
      );
    }
    // #2083 M3 U7 gates — taint boundedness (per-function findings pinned at
    // the cap as N grows), an ABSOLUTE ceiling on persisted TAINTED reason
    // bytes, taint solve-time scaling, and the zero-match fast path staying
    // ~free relative to the match-dense pass.
    if (base.taint_findings_per_fn_pin !== undefined) {
      for (const side of ['small', 'large']) {
        const perFn = r[`taint_findings_per_fn_${side}`];
        if (perFn !== base.taint_findings_per_fn_pin) {
          failures.push(
            `${r.scenario}: taint findings/function (${side}) ${perFn} != pin ` +
              `${base.taint_findings_per_fn_pin} (cap must BIND exactly: above = cap lost, ` +
              `below = detection regressed)`,
          );
        }
      }
      if (r.taint_zero_findings !== 0) {
        failures.push(
          `${r.scenario}: zero-match control produced ${r.taint_zero_findings} findings ` +
            `(the control must not match the model — generator drift)`,
        );
      }
    }
    if (
      base.taint_reason_bytes_large_max !== undefined &&
      r.taint_reason_bytes_large > base.taint_reason_bytes_large_max
    ) {
      failures.push(
        `${r.scenario}: persisted TAINTED reason bytes ${r.taint_reason_bytes_large} > ceiling ` +
          `${base.taint_reason_bytes_large_max} (hop-encoding bloat or cap loss)`,
      );
    }
    if (
      base.taint_scaling_budget !== undefined &&
      r.taint_scaling_ratio >= base.taint_scaling_budget
    ) {
      failures.push(
        `${r.scenario}: taint scaling ratio ${r.taint_scaling_ratio} >= budget ` +
          `${base.taint_scaling_budget} (ms ${r.taint_ms_small}->${r.taint_ms_large})`,
      );
    }
    if (
      base.taint_zero_match_budget !== undefined &&
      r.taint_zero_match_ratio >= base.taint_zero_match_budget
    ) {
      failures.push(
        `${r.scenario}: zero-match taint time is ${r.taint_zero_match_ratio} of the match-dense ` +
          `pass, >= budget ${base.taint_zero_match_budget} (the match gate must keep unmatched ` +
          `functions ~free — no solver call)`,
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
