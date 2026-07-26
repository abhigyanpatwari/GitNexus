#!/usr/bin/env node
/**
 * Scope-emission bench (#2699).
 *
 * JavaScript/TypeScript gained block scopes so that `let`/`const` in sibling
 * blocks are distinct bindings. Emitted naively — one scope per
 * `statement_block` — that TRIPLED the block-scope count and cost ~10% of
 * analyze wall time, because every scope-chain walk in every function then
 * steps through levels that bind nothing.
 *
 * Two emit-side filters keep the semantics and drop the waste:
 *   1. a block that IS a function body duplicates the enclosing Function scope;
 *   2. a block that declares no `let`/`const`/`class`/`function` binds nothing,
 *      so it is transparent to every lookup.
 *
 * This bench guards that. It counts scope captures over a synthetic corpus
 * whose shape is fixed in this file, so the numbers are exact and independent
 * of the machine — unlike wall-clock analyze, where a 2% effect sits well
 * inside the noise of a shared runner (measured: ±10% run to run).
 *
 * Usage:
 *   node bench/scope-emission/measure.mjs           # print measurements
 *   node bench/scope-emission/measure.mjs --check   # gate against baselines
 *
 * Build-free: imports the TypeScript sources through tsx, like the other
 * benches here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const { emitTsScopeCaptures } =
  await import('../../src/core/ingestion/languages/typescript/captures.ts');

/**
 * One synthetic module, parameterised by index so names stay distinct.
 *
 * Deliberately mixes the shapes the filters discriminate between:
 *   - function/method/arrow bodies      → block scope must be SUPPRESSED
 *   - `if`/`else`/`for`/`while`/`try`   → suppressed when they declare nothing
 *   - blocks declaring `let`/`const`    → block scope REQUIRED (shadowing)
 *   - a block declaring only `var`      → suppressed (`var` hoists past it)
 */
const moduleSource = (i) => `
export class Svc${i} {
  private total = 0;
  run(xs: number[]): number {
    for (const x of xs) {
      if (x > 0) {
        this.total += x;
      } else {
        this.total -= x;
      }
    }
    while (this.total > 100) {
      this.total = this.total / 2;
    }
    try {
      this.total = Math.round(this.total);
    } catch {
      this.total = 0;
    }
    return this.total;
  }
  pick(flag: boolean): number {
    if (flag) {
      const chosen = (n: number) => n * 2;
      return chosen(1);
    } else {
      const chosen = (n: number) => n * 3;
      return chosen(2);
    }
  }
  hoisted(flag: boolean): number {
    if (flag) { var v = 1; }
    return v ?? 0;
  }
}

export function free${i}(): number {
  const inner = (n: number) => n + 1;
  return inner(1);
}
`;

const CORPUS_MODULES = 200;
const REPS = 7;

const corpus = Array.from({ length: CORPUS_MODULES }, (_, i) => ({
  path: `bench/mod${i}.ts`,
  source: moduleSource(i),
}));

const tally = () => {
  const counts = new Map();
  for (const { path, source } of corpus) {
    for (const match of emitTsScopeCaptures(source, path)) {
      for (const key of Object.keys(match)) {
        if (key.startsWith('@scope.')) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
};

// Warm the parser + query caches so the timing reflects steady state.
tally();

let bestMs = Infinity;
let counts;
for (let r = 0; r < REPS; r++) {
  const t0 = process.hrtime.bigint();
  counts = tally();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (ms < bestMs) bestMs = ms;
}

const scopes = Object.fromEntries([...counts.entries()].sort());
const total = Object.values(scopes).reduce((a, b) => a + b, 0);
const result = {
  modules: CORPUS_MODULES,
  scopes,
  total_scopes: total,
  emit_min_ms: Number(bestMs.toFixed(2)),
  blocks_per_module: Number(((scopes['@scope.block'] ?? 0) / CORPUS_MODULES).toFixed(3)),
};

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const baselines = JSON.parse(readFileSync(join(HERE, 'baselines.json'), 'utf8'));
const failures = [];

// Scope counts are EXACT — a synthetic corpus and a deterministic emitter. A
// mismatch means the emitted scope set moved and must be explained, never
// re-baselined to make CI green.
for (const [key, expected] of Object.entries(baselines.scopes)) {
  const actual = scopes[key] ?? 0;
  if (actual !== expected) failures.push(`${key}: expected ${expected}, got ${actual}`);
}
for (const key of Object.keys(scopes)) {
  if (!(key in baselines.scopes)) failures.push(`unexpected capture ${key}: ${scopes[key]}`);
}

// Timing carries deliberate headroom for shared CI runners; it exists to catch
// an order-of-magnitude regression, not to police a few percent.
if (result.emit_min_ms > baselines.emit_ms_budget) {
  failures.push(`emit_min_ms ${result.emit_min_ms} exceeds budget ${baselines.emit_ms_budget}`);
}

console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) {
  console.error('[scope-emission --check] FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('[scope-emission --check] PASS');
