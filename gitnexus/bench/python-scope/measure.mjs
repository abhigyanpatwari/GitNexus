/**
 * Build-free measurement harness for `emitPythonScopeCaptures`
 * (ce-optimize: python-scope-capture).
 *
 * This is Python's counterpart to `bench/scope-capture/measure.mjs` (which
 * covers go/csharp/rust/php/ruby/cobol). Python lives here, NOT in that unified
 * harness, because this one ALSO covers import resolution
 * (`import-target-fingerprint.mjs`). Python's capture-scaling guard therefore
 * runs via `python-scope/measure.mjs --check`, not the unified harness — don't
 * remove either thinking the other covers Python.
 *
 * Mirrors the Go scope-capture harness (#1848). Imports the `.ts` hotpath
 * directly through tsx (`node --import tsx bench/python-scope/measure.mjs`):
 * a static `.ts` import works; a top-level `await import()` breaks tsx's lexer.
 *
 * Emits ONE JSON object on stdout with:
 *   - elapsed_ms_250 / elapsed_ms_800: median wall-clock (ms) of
 *     emitPythonScopeCaptures over a synthetic DAO-style source at that many
 *     top-level entities (warmed up first). 800/250 ~ 3.2x input; an O(n^2)
 *     path scales ~quadratically, an O(n) path ~linearly.
 *   - scaling_ratio: (t800/t250)/(800/250). ~3.2 = quadratic, ~1.0 = linear.
 *   - capture_groups_250 / capture_groups_800: match counts (a fast-but-empty
 *     regression can't pass — counts must stay > 0).
 *   - fingerprint: order-independent sha256 over emitPythonScopeCaptures output
 *     across the whole lang-resolution/python-* fixture corpus + a fixed
 *     20-entity synthetic DAO. This is the CORRECTNESS gate: any change to the
 *     captures changes the fingerprint. Entity-count-fixed so it is comparable
 *     across experiments regardless of the timing sizes.
 *   - capture_groups_fp / fixture_count: corpus sanity.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { emitPythonScopeCaptures } from '../../src/core/ingestion/languages/python/captures.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'lang-resolution');

// ---- correctness fingerprint (order-independent, mirrors the Go golden) ----

function canonicalizeMatch(match) {
  const parts = [];
  for (const tag of Object.keys(match)) {
    const cap = match[tag];
    const r = cap.range;
    parts.push(`${tag}|${cap.text}|${r.startLine}:${r.startCol}-${r.endLine}:${r.endCol}`);
  }
  parts.sort();
  return parts.join(';');
}

function digestCaptures(matches) {
  const matchStrings = matches.map(canonicalizeMatch).sort();
  return crypto.createHash('sha256').update(matchStrings.join('\n')).digest('hex');
}

/** All `.py` files under `lang-resolution/python-*`, sorted by repo-relative key. */
function collectPythonFixtures() {
  const out = [];
  for (const entry of fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('python-')) continue;
    const stack = [path.join(FIXTURE_ROOT, entry.name)];
    while (stack.length) {
      const dir = stack.pop();
      for (const c of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, c.name);
        if (c.isDirectory()) stack.push(p);
        else if (c.name.endsWith('.py')) {
          out.push({ key: path.relative(FIXTURE_ROOT, p).split(path.sep).join('/'), absPath: p });
        }
      }
    }
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/**
 * Synthetic DAO-style source: top-level imports + N classes (each with methods,
 * exercising @scope.function + @declaration.function + receiver binding) + N
 * module functions. Maximizes top-level children (rootChildren) AND function
 * matches, which is exactly the O(matches x rootChildren) shape #1848 hit.
 */
function generatePyDao(entityCount) {
  const lines = [];
  for (let i = 0; i < 12; i++) {
    lines.push(`from pkg.mod${i} import alpha${i}, beta${i}, gamma${i} as g${i}`);
    lines.push(`import top.level.module${i}`);
  }
  lines.push('');
  // Shared base + mixin so every Entity is heritage-bearing — exercises the
  // @reference.inherits synth (#1951) at scale (single + multiple inheritance),
  // not just the base capture loop.
  lines.push('class Base:', '    pass', '', 'class Mixin:', '    pass', '');
  for (let i = 0; i < entityCount; i++) {
    const n = String(i).padStart(4, '0');
    lines.push(
      `class Entity${n}(Base, Mixin):`,
      `    def __init__(self, id: int, name: str):`,
      `        self.id = id`,
      `        self.name = name`,
      `    def get_id(self) -> int:`,
      `        return self.id`,
      `    def set_name(self, name: str) -> None:`,
      `        self.name = name`,
      `    @classmethod`,
      `    def make(cls, id: int):`,
      `        return cls(id, "x")`,
      '',
      `def build_entity${n}(id: int, name: str) -> Entity${n}:`,
      `    return Entity${n}(id, name)`,
      '',
    );
  }
  return lines.join('\n');
}

// ---- timing ----

function timeOnce(src, filePath) {
  const start = process.hrtime.bigint();
  const matches = emitPythonScopeCaptures(src, filePath);
  const end = process.hrtime.bigint();
  return { ms: Number(end - start) / 1e6, count: matches.length };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function measureSize(entityCount, reps) {
  const src = generatePyDao(entityCount);
  // Warm up parser/query JIT (not counted).
  timeOnce(src, 'warmup.py');
  const samples = [];
  let count = 0;
  for (let i = 0; i < reps; i++) {
    const r = timeOnce(src, `bench-${entityCount}.py`);
    samples.push(r.ms);
    count = r.count;
  }
  return { ms: median(samples), count };
}

// ---- run ----

function computeFingerprint() {
  let groups = 0;
  const perFixtureDigests = [];
  for (const { key, absPath } of collectPythonFixtures()) {
    const src = fs.readFileSync(absPath, 'utf8');
    const matches = emitPythonScopeCaptures(src, absPath);
    groups += matches.length;
    perFixtureDigests.push(`${key}\t${matches.length}\t${digestCaptures(matches)}`);
  }
  // Fixed 20-entity synthetic source so the fingerprint is comparable across
  // experiments independent of the timing sizes.
  const daoMatches = emitPythonScopeCaptures(generatePyDao(20), 'synthetic-dao-20.py');
  groups += daoMatches.length;
  perFixtureDigests.push(`synthetic:dao-20\t${daoMatches.length}\t${digestCaptures(daoMatches)}`);
  const fingerprint = crypto
    .createHash('sha256')
    .update(perFixtureDigests.sort().join('\n'))
    .digest('hex');
  return { fingerprint, groups, fixtureCount: perFixtureDigests.length };
}

// Higher rep count keeps the median stable on noisy shared CI runners.
const REPS = 7;
const SCALING_BUDGET = 1.5; // ~3.2 (quadratic) vs ~1.0 (linear); 1.5 has headroom.
const CHECK = process.argv.includes('--check');

const fp = computeFingerprint();
const small = measureSize(250, REPS);
const large = measureSize(800, REPS);
const scalingRatio = small.ms > 0 ? large.ms / small.ms / (800 / 250) : 0;

const result = {
  elapsed_ms_250: Number(small.ms.toFixed(2)),
  elapsed_ms_800: Number(large.ms.toFixed(2)),
  scaling_ratio: Number(scalingRatio.toFixed(3)),
  capture_groups_250: small.count,
  capture_groups_800: large.count,
  fingerprint: fp.fingerprint,
  capture_groups_fp: fp.groups,
  fixture_count: fp.fixtureCount,
};

if (!CHECK) {
  process.stdout.write(JSON.stringify(result) + '\n');
} else {
  // CI gate: capture output unchanged (fingerprint == committed baseline) AND
  // the path is still linear (scaling ratio under budget). Re-baseline a
  // legitimate capture change with `node --import tsx measure.mjs` (no --check)
  // and commit the new baseline-fingerprint.txt deliberately.
  const baselinePath = path.resolve(__dirname, 'baseline-fingerprint.txt');
  const baseline = fs.readFileSync(baselinePath, 'utf8').trim();
  const failures = [];
  if (result.fingerprint !== baseline) {
    failures.push(
      `capture fingerprint drift: got ${result.fingerprint}, expected ${baseline} ` +
        `(emitPythonScopeCaptures output changed — re-baseline intentionally if expected)`,
    );
  }
  if (result.scaling_ratio >= SCALING_BUDGET) {
    failures.push(
      `capture scaling ratio ${result.scaling_ratio} >= ${SCALING_BUDGET} ` +
        `(possible O(n^2) regression; 250->800ms ${result.elapsed_ms_250}->${result.elapsed_ms_800})`,
    );
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`[measure --check] FAIL: ${f}\n`);
    process.exit(1);
  }
  process.stderr.write('[measure --check] PASS (capture fingerprint + scaling)\n');
}
