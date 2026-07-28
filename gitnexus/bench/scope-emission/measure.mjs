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
 * BOTH languages are measured. The filters are implemented twice —
 * `FUNCTION_BODY_OWNER_TYPES` in `typescript/captures.ts` and
 * `JS_FUNCTION_BODY_OWNER_TYPES` in `javascript/captures.ts`, each with its own
 * `blockDeclaresBinding` and its own `BLOCK_BINDING_CHILD_TYPES` — so a
 * TypeScript-only bench would let a JavaScript-only regression ship green.
 *
 * On this corpus the two currently agree exactly (2 blocks per module, 2200
 * scopes). That is a measured result, not a required invariant: the fixtures
 * are structurally parallel and the TS-only syntax they drop carries no extra
 * scopes. Each language is still gated against its OWN baseline, because the
 * filters are separate code and nothing enforces that the counts stay equal.
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
const { emitJsScopeCaptures } =
  await import('../../src/core/ingestion/languages/javascript/captures.ts');

/**
 * One synthetic TypeScript module, parameterised by index so names stay
 * distinct.
 *
 * Deliberately mixes the shapes the filters discriminate between:
 *   - function/method/arrow bodies      → block scope must be SUPPRESSED
 *   - `if`/`else`/`for`/`while`/`try`   → suppressed when they declare nothing
 *   - blocks declaring `let`/`const`    → block scope REQUIRED (shadowing)
 *   - a block declaring only `var`      → suppressed (`var` hoists past it)
 */
const tsModuleSource = (i) => `
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

/** The same shapes with the TypeScript-only syntax removed. Kept structurally
 *  parallel to `tsModuleSource` on purpose: when the two languages' block
 *  counts diverge, the cause is the emitter, not the fixture. */
const jsModuleSource = (i) => `
export class Svc${i} {
  total = 0;
  run(xs) {
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
  pick(flag) {
    if (flag) {
      const chosen = (n) => n * 2;
      return chosen(1);
    } else {
      const chosen = (n) => n * 3;
      return chosen(2);
    }
  }
  hoisted(flag) {
    if (flag) { var v = 1; }
    return v ?? 0;
  }
}

export function free${i}() {
  const inner = (n) => n + 1;
  return inner(1);
}
`;

const CORPUS_MODULES = 200;
const REPS = 7;

const LANGUAGES = [
  { name: 'typescript', ext: 'ts', emit: emitTsScopeCaptures, moduleSource: tsModuleSource },
  { name: 'javascript', ext: 'js', emit: emitJsScopeCaptures, moduleSource: jsModuleSource },
];

const measure = ({ ext, emit, moduleSource }) => {
  const corpus = Array.from({ length: CORPUS_MODULES }, (_, i) => ({
    path: `bench/mod${i}.${ext}`,
    source: moduleSource(i),
  }));

  const tally = () => {
    const counts = new Map();
    for (const { path, source } of corpus) {
      for (const match of emit(source, path)) {
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
  return {
    modules: CORPUS_MODULES,
    scopes,
    total_scopes: Object.values(scopes).reduce((a, b) => a + b, 0),
    emit_min_ms: Number(bestMs.toFixed(2)),
    blocks_per_module: Number(((scopes['@scope.block'] ?? 0) / CORPUS_MODULES).toFixed(3)),
  };
};

const result = Object.fromEntries(LANGUAGES.map((lang) => [lang.name, measure(lang)]));

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const baselines = JSON.parse(readFileSync(join(HERE, 'baselines.json'), 'utf8'));
const failures = [];

for (const { name } of LANGUAGES) {
  const expected = baselines[name];
  const actual = result[name];
  if (expected === undefined) {
    failures.push(`${name}: no baseline entry — add one rather than skipping the language`);
    continue;
  }

  // Scope counts are EXACT — a synthetic corpus and a deterministic emitter. A
  // mismatch means the emitted scope set moved and must be explained, never
  // re-baselined to make CI green.
  for (const [key, want] of Object.entries(expected.scopes)) {
    const got = actual.scopes[key] ?? 0;
    if (got !== want) failures.push(`${name} ${key}: expected ${want}, got ${got}`);
  }
  for (const key of Object.keys(actual.scopes)) {
    if (!(key in expected.scopes)) {
      failures.push(`${name}: unexpected capture ${key}: ${actual.scopes[key]}`);
    }
  }

  // Timing carries deliberate headroom for shared CI runners; it exists to
  // catch an order-of-magnitude regression, not to police a few percent.
  if (actual.emit_min_ms > expected.emit_ms_budget) {
    failures.push(
      `${name} emit_min_ms ${actual.emit_min_ms} exceeds budget ${expected.emit_ms_budget}`,
    );
  }
}

// A language present in baselines but not measured means the bench stopped
// covering it — the exact way a gate goes quietly green.
for (const name of Object.keys(baselines)) {
  if (name.startsWith('_')) continue;
  if (!(name in result)) failures.push(`${name}: baselined but not measured`);
}

console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) {
  console.error('[scope-emission --check] FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('[scope-emission --check] PASS');
