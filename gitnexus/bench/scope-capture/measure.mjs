/**
 * Unified build-free scope-capture measurement harness for every currently
 * benchmarked language (the ones with a `*-pipeline-benchmark.test.ts`):
 * go, csharp, rust, php, ruby, cobol, swift — plus python lives in its own
 * `bench/python-scope/` harness (richer: it also covers import resolution).
 *
 * For each language it:
 *   - times `emit<Lang>ScopeCaptures` on a synthetic DAO-style source at two
 *     sizes (250 / 800 top-level entities), reporting elapsed_ms + a scaling
 *     ratio `(t_large/t_small)/(800/250)`: ~1.0 is linear, ~3.2 is quadratic
 *     (the O(matches × rootChildren) shape #1848 hit in Go);
 *   - computes an order-independent sha256 fingerprint over the whole
 *     `lang-resolution/<lang>-*` fixture corpus + a fixed 20-entity synthetic
 *     source, as the correctness gate.
 *
 * Build-free: imports the `.ts` hotpaths through tsx
 * (`node --import tsx bench/scope-capture/measure.mjs`). Static `.ts` imports
 * work; a top-level `await import()` breaks tsx's lexer.
 *
 * Without args: prints one JSON object per language.
 * With `--check`: asserts each language's fingerprint == its committed baseline
 * (baselines.json) AND scaling_ratio < that language's recorded budget; exits
 * non-zero on any drift/regression.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { emitGoScopeCaptures } from '../../src/core/ingestion/languages/go/index.ts';
import { emitCsharpScopeCaptures } from '../../src/core/ingestion/languages/csharp/index.ts';
import { emitRustScopeCaptures } from '../../src/core/ingestion/languages/rust/index.ts';
import { emitPhpScopeCaptures } from '../../src/core/ingestion/languages/php/index.ts';
import { emitRubyScopeCaptures } from '../../src/core/ingestion/languages/ruby/index.ts';
import { emitCobolScopeCaptures } from '../../src/core/ingestion/languages/cobol/index.ts';
import { emitSwiftScopeCaptures } from '../../src/core/ingestion/languages/swift/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'lang-resolution');
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');

// ---- correctness fingerprint (order-independent; mirrors python harness) ----

function canonicalizeMatch(match) {
  const parts = [];
  for (const tag of Object.keys(match)) {
    const cap = match[tag];
    if (cap === undefined || cap === null || cap.range === undefined) {
      parts.push(`${tag}|<no-range>`);
      continue;
    }
    const r = cap.range;
    parts.push(`${tag}|${cap.text}|${r.startLine}:${r.startCol}-${r.endLine}:${r.endCol}`);
  }
  parts.sort();
  return parts.join(';');
}

function digestCaptures(matches) {
  return crypto
    .createHash('sha256')
    .update(matches.map(canonicalizeMatch).sort().join('\n'))
    .digest('hex');
}

/** All fixture files for a language, sorted by repo-relative key. */
function collectFixtures(prefix, exts) {
  const out = [];
  for (const entry of fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${prefix}-`)) continue;
    const stack = [path.join(FIXTURE_ROOT, entry.name)];
    while (stack.length) {
      const dir = stack.pop();
      for (const c of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, c.name);
        if (c.isDirectory()) stack.push(p);
        else if (exts.some((e) => c.name.endsWith(e))) {
          out.push({ key: path.relative(FIXTURE_ROOT, p).split(path.sep).join('/'), absPath: p });
        }
      }
    }
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

// ---- per-language config: synthetic DAO generators + fixture globs ----

const LANGS = [
  {
    name: 'go',
    emit: emitGoScopeCaptures,
    fixturePrefix: 'go',
    exts: ['.go'],
    file: 'bench.go',
    header: 'package generated\n\n',
    unit: (n) =>
      `type Entity${n} struct {\n\tid int64\n\tname string\n}\n\n` +
      `func (e *Entity${n}) GetID() int64 { return e.id }\n` +
      `func (e *Entity${n}) SetName(v string) { e.name = v }\n\n`,
  },
  {
    name: 'csharp',
    emit: emitCsharpScopeCaptures,
    fixturePrefix: 'csharp',
    exts: ['.cs'],
    file: 'bench.cs',
    header: 'namespace Generated;\n\n',
    unit: (n) =>
      `public class Entity${n} {\n` +
      `  public long Id;\n  public string Name;\n` +
      `  public long GetId() { return Id; }\n` +
      `  public void SetName(string v) { Name = v; }\n}\n\n`,
  },
  {
    name: 'rust',
    emit: emitRustScopeCaptures,
    fixturePrefix: 'rust',
    exts: ['.rs'],
    file: 'bench.rs',
    header: '',
    unit: (n) =>
      `struct Entity${n} {\n  id: i64,\n  name: String,\n}\n\n` +
      `impl Entity${n} {\n` +
      `  fn get_id(&self) -> i64 { self.id }\n` +
      `  fn set_name(&mut self, v: String) { self.name = v; }\n}\n\n`,
  },
  {
    name: 'php',
    emit: emitPhpScopeCaptures,
    fixturePrefix: 'php',
    exts: ['.php'],
    file: 'bench.php',
    header: '<?php\n\n',
    unit: (n) =>
      `class Entity${n} {\n` +
      `  public $id;\n  public $name;\n` +
      `  function getId() { return $this->id; }\n` +
      `  function setName($v) { $this->name = $v; }\n}\n\n`,
  },
  {
    name: 'ruby',
    emit: emitRubyScopeCaptures,
    fixturePrefix: 'ruby',
    exts: ['.rb'],
    file: 'bench.rb',
    header: '',
    unit: (n) =>
      `class Entity${n}\n` +
      `  def get_id\n    @id\n  end\n` +
      `  def set_name(v)\n    @name = v\n  end\nend\n\n`,
  },
  {
    name: 'cobol',
    emit: emitCobolScopeCaptures,
    fixturePrefix: 'cobol',
    exts: ['.cbl', '.cpy'],
    file: 'bench.cbl',
    header:
      '       IDENTIFICATION DIVISION.\n' +
      '       PROGRAM-ID. BENCH.\n' +
      '       PROCEDURE DIVISION.\n',
    unit: (n) => `       PARA-${String(n).padStart(5, '0')}.\n           DISPLAY "P${n}".\n`,
  },
  {
    name: 'swift',
    emit: emitSwiftScopeCaptures,
    fixturePrefix: 'swift',
    exts: ['.swift'],
    file: 'bench.swift',
    header: '',
    unit: (n) =>
      `class Entity${n} {\n` +
      `  var id: Int64 = 0\n  var name: String = ""\n` +
      `  func getId() -> Int64 { return self.id }\n` +
      `  func setName(_ v: String) { self.name = v }\n}\n\n`,
  },
];

function generate(lang, entityCount) {
  let src = lang.header;
  for (let i = 0; i < entityCount; i++) src += lang.unit(i);
  return src;
}

// ---- timing ----

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function timeEmit(emit, src, file, reps) {
  emit(src, `warmup-${file}`); // warm parser/query JIT (not counted)
  const samples = [];
  let count = 0;
  for (let i = 0; i < reps; i++) {
    const start = process.hrtime.bigint();
    const out = emit(src, file);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    count = out.length;
  }
  return { ms: median(samples), count };
}

const SMALL = 250;
const LARGE = 800;
const REPS = 7;

function measureLang(lang) {
  // Correctness fingerprint over the fixture corpus + a fixed 20-entity source.
  const perFixture = [];
  let groups = 0;
  for (const { key, absPath } of collectFixtures(lang.fixturePrefix, lang.exts)) {
    const matches = lang.emit(fs.readFileSync(absPath, 'utf8'), absPath);
    groups += matches.length;
    perFixture.push(`${key}\t${matches.length}\t${digestCaptures(matches)}`);
  }
  const daoMatches = lang.emit(generate(lang, 20), `synthetic-dao-20${path.extname(lang.file)}`);
  groups += daoMatches.length;
  perFixture.push(`synthetic:dao-20\t${daoMatches.length}\t${digestCaptures(daoMatches)}`);
  const fingerprint = crypto
    .createHash('sha256')
    .update(perFixture.sort().join('\n'))
    .digest('hex');

  // Scaling.
  const small = timeEmit(lang.emit, generate(lang, SMALL), lang.file, REPS);
  const large = timeEmit(lang.emit, generate(lang, LARGE), lang.file, REPS);
  const scalingRatio = small.ms > 0 ? large.ms / small.ms / (LARGE / SMALL) : 0;

  return {
    language: lang.name,
    elapsed_ms_small: Number(small.ms.toFixed(2)),
    elapsed_ms_large: Number(large.ms.toFixed(2)),
    scaling_ratio: Number(scalingRatio.toFixed(3)),
    capture_groups_small: small.count,
    capture_groups_large: large.count,
    fingerprint,
    capture_groups_fp: groups,
    fixture_count: perFixture.length,
  };
}

// ---- run ----

const CHECK = process.argv.includes('--check');
const results = LANGS.map(measureLang);

if (!CHECK) {
  for (const r of results) process.stdout.write(JSON.stringify(r) + '\n');
} else {
  const baselines = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const failures = [];
  for (const r of results) {
    const base = baselines[r.language];
    if (base === undefined) {
      failures.push(`${r.language}: no baseline recorded`);
      continue;
    }
    if (r.fingerprint !== base.fingerprint) {
      failures.push(
        `${r.language}: capture fingerprint drift (got ${r.fingerprint}, expected ${base.fingerprint})`,
      );
    }
    if (r.scaling_ratio >= base.scaling_budget) {
      failures.push(
        `${r.language}: scaling ratio ${r.scaling_ratio} >= budget ${base.scaling_budget} ` +
          `(${SMALL}->${LARGE} ms ${r.elapsed_ms_small}->${r.elapsed_ms_large})`,
      );
    }
    process.stdout.write(JSON.stringify(r) + '\n');
  }
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`[scope-capture --check] FAIL: ${f}\n`);
    process.exit(1);
  }
  process.stderr.write(`[scope-capture --check] PASS (${results.length} languages)\n`);
}
