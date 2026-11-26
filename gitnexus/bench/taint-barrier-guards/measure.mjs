/**
 * Build-free barrier-guard scaling bench (#3913).
 *
 * Times `computeTaintFlows` over guarded vs unguarded synthetic corpora at two
 * sizes. Reports a scaling ratio `(t_large/t_small)/(N_large/N_small)` and an
 * order-independent finding-count fingerprint so `--check` gates both cost and
 * correctness (guarded corpus stays clean; unguarded keeps findings).
 *
 *   node --import tsx bench/taint-barrier-guards/measure.mjs
 *   node --import tsx bench/taint-barrier-guards/measure.mjs --check
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';

import { createTypeScriptCfgVisitor } from '../../src/core/ingestion/cfg/visitors/typescript.ts';
import { computeReachingDefs } from '../../src/core/ingestion/cfg/reaching-defs.ts';
import { hasTaintSafeSites } from '../../src/core/ingestion/taint/site-safety.ts';
import { buildTaintImportIndex, matchFunctionSites } from '../../src/core/ingestion/taint/match.ts';
import { computeTaintFlows } from '../../src/core/ingestion/taint/propagate.ts';
import { discoverProtoGuardCallees } from '../../src/core/ingestion/taint/barrier-guards.ts';
import { TS_JS_TAINT_MODEL } from '../../src/core/ingestion/taint/typescript-model.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baseline.json');

const SMALL = 48;
const LARGE = 192;
const WARMUP = 1;
const REPS = 5;

const SPEC = {
  sources: TS_JS_TAINT_MODEL.sources,
  sinks: [{ name: 'exec', kind: 'command-injection', args: [0], global: true }],
  sanitizers: TS_JS_TAINT_MODEL.sanitizers,
};

function corpus(kind, n) {
  const parts = [
    `function isValidHostName(h: string) { return /^[a-z0-9.-]+$/i.test(h); }`,
    `function safeKey(k: string) { return k !== "__proto__" && k !== "constructor"; }`,
  ];
  for (let i = 0; i < n; i++) {
    if (kind === 'guarded') {
      parts.push(`
function handler${i}(req: any) {
  const hostname = req.body;
  if (!isValidHostName(hostname)) return;
  exec(hostname);
}
function set${i}(req: any) {
  const path = req.body;
  const keys = String(path).split(".");
  for (const key of keys) {
    if (!isValidKey(key)) continue;
    exec(key);
  }
}
function isValidKey(key: string) { return key !== "__proto__" && key !== "constructor"; }
function write${i}(req: any) {
  const key = req.body;
  if (!isValidKey(key)) return;
  exec(key);
}
`);
    } else {
      parts.push(`
function handler${i}(req: any) {
  const hostname = req.body;
  exec(hostname);
}
function set${i}(req: any) {
  const path = req.body;
  const keys = String(path).split(".");
  for (const key of keys) exec(key);
}
function write${i}(req: any) {
  const key = req.body;
  exec(key);
}
`);
    }
  }
  return parts.join('\n');
}

function buildCfgs(source) {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  const root = parser.parse(source).rootNode;
  const visitor = createTypeScriptCfgVisitor();
  const bound = visitor.forFile?.(root, 'bench.ts') ?? visitor;
  const fns = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (bound.isFunction(n)) fns.push(n);
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return fns.map((fn) => bound.buildFunctionCfg(fn, 'bench.ts')).filter((cfg) => cfg !== undefined);
}

function analyzeAll(cfgs) {
  const protoGuards = discoverProtoGuardCallees(cfgs);
  const barrierOptions = protoGuards.size > 0 ? { extraBarrierCallees: protoGuards } : undefined;
  const importIndex = buildTaintImportIndex([]);
  let findings = 0;
  let kills = 0;
  let analyzed = 0;
  const t0 = performance.now();
  for (const cfg of cfgs) {
    if (!hasTaintSafeSites(cfg)) continue;
    const matches = matchFunctionSites(cfg, SPEC, importIndex);
    if (!matches.hasSource || !matches.hasSink) continue;
    const defUse = computeReachingDefs(cfg);
    const flows = computeTaintFlows(cfg, defUse, matches, undefined, undefined, barrierOptions);
    if (flows.status !== 'computed') continue;
    analyzed++;
    findings += flows.findings.length;
    kills += flows.kills.length;
  }
  return { ms: performance.now() - t0, findings, kills, analyzed };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function measureArm(kind, n) {
  const source = corpus(kind, n);
  const cfgs = buildCfgs(source);
  const samples = [];
  let last;
  for (let i = 0; i < WARMUP + REPS; i++) {
    last = analyzeAll(cfgs);
    if (i >= WARMUP) samples.push(last.ms);
  }
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify({ findings: last.findings, kills: last.kills, analyzed: last.analyzed }))
    .digest('hex');
  return {
    units: n,
    functions: cfgs.length,
    findings: last.findings,
    kills: last.kills,
    analyzed: last.analyzed,
    median_ms: median(samples),
    fingerprint,
  };
}

function run() {
  const report = {};
  for (const kind of ['guarded', 'unguarded']) {
    const small = measureArm(kind, SMALL);
    const large = measureArm(kind, LARGE);
    report[kind] = {
      small,
      large,
      scaling: large.median_ms / small.median_ms / (LARGE / SMALL),
    };
  }
  return report;
}

const report = run();

if (process.argv.includes('--check')) {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  assert.deepEqual(Object.keys(report).sort(), Object.keys(baseline).sort());
  for (const [kind, arm] of Object.entries(report)) {
    const expected = baseline[kind];
    assert(
      Number.isFinite(expected.scaling_budget) && expected.scaling_budget > 0,
      `${kind}: missing scaling_budget`,
    );
    assert(
      arm.scaling <= expected.scaling_budget,
      `${kind}: scaling ${arm.scaling} > budget ${expected.scaling_budget}`,
    );
    for (const size of ['small', 'large']) {
      assert.equal(arm[size].findings, expected[size].findings, `${kind}/${size}: findings`);
      assert.equal(arm[size].analyzed, expected[size].analyzed, `${kind}/${size}: analyzed`);
      assert.equal(
        arm[size].fingerprint,
        expected[size].fingerprint,
        `${kind}/${size}: fingerprint drift`,
      );
    }
  }
  // Correctness: guarded stays clean; unguarded keeps findings.
  assert.equal(report.guarded.small.findings, 0);
  assert.equal(report.guarded.large.findings, 0);
  assert.ok(report.unguarded.small.findings > 0);
  assert.ok(report.unguarded.large.findings > 0);
}

console.log(JSON.stringify(report, null, 2));
