/**
 * Build-free scaling + identity bench for the Go, C#, Dart and Ruby
 * import-target resolvers (#2877, #2878, #2879, #2880).
 *
 * Before this PR each of them answered its lookups with a full `allFilePaths`
 * scan per import, so import resolution cost O(imports × files):
 *
 *   - Go: `findRootPackageFiles` / `findAllFilesInPkgDir`, the latter once per
 *     path segment on the GOPATH fallback — several full scans per import;
 *   - C#: the no-csproj leg took the raw Set past the memoized index the csproj
 *     leg was already using — up to eight passes for a four-segment `using`;
 *   - Dart: one full scan per candidate path, and for an external package both
 *     candidates miss, so both always ran to completion;
 *   - Ruby: a complete `buildSuffixIndex` rebuilt and discarded per `require`.
 *
 * Two properties of the corpus are load-bearing and must not be "simplified":
 *
 *  1. **Most imports are unresolvable.** In real source the majority of imports
 *     name the stdlib or a third-party package, and those run every leg of the
 *     cascade to completion before returning null — the fast paths never fire.
 *     A corpus of mostly-resolving imports measures the wrong half of the
 *     function and would score a reintroduced scan as linear.
 *  2. **Import count scales WITH file count.** The regression is quadratic in
 *     `imports × files`; holding imports fixed while files grow would halve the
 *     exponent and let a per-import scan pass the budget.
 *
 * Reports per language and scale:
 *   - `ms`: fastest of REPS full passes, INCLUDING the one-time index build —
 *     hiding the build would let an index that is itself quadratic pass;
 *   - `scaling_ratio` `(t_large/t_small)/(LARGE/SMALL)`: ~1.0 linear, ~4.x
 *     quadratic at this scale gap;
 *   - a sha256 over every distinct `fromFile | target → result`, as the
 *     correctness gate. The tie-break-level proof that this PR's index
 *     reproduces the scans lives in
 *     `test/unit/scope-resolution/import-target-index-parity.test.ts`, which
 *     diffs against verbatim copies of the pre-change implementations; this
 *     fingerprint is the forward guard that keeps the output pinned from here.
 *
 * `--check` also asserts the corpus SHAPE (file and import counts) against the
 * baseline, so a future edit cannot quietly shrink the corpus below the sizes
 * that make the scaling arm meaningful and still print PASS.
 *
 * Run:
 *   node --import tsx bench/import-target/measure.mjs           # report
 *   node --import tsx bench/import-target/measure.mjs --check   # CI gate
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { resolveGoImportTarget } from '../../src/core/ingestion/languages/go/import-target.ts';
import { resolveDartImportTarget } from '../../src/core/ingestion/languages/dart/import-target.ts';
import { resolveRubyImportTarget } from '../../src/core/ingestion/languages/ruby/import-target.ts';
import { resolveCsharpImportTarget } from '../../src/core/ingestion/languages/csharp/import-target.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baselines.json');

const SMALL = 400;
const LARGE = 1600;
const IMPORTS_PER_FILE = 8;
const REPS = 5;
const WARMUP = 2;

/** Deterministic 32-bit avalanche (murmur3 finalizer) — no `Math.random()`, so
 *  the corpus and therefore the fingerprint are byte-reproducible. */
function mix(n) {
  let x = n >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

const GO_MODULE = { modulePath: 'example.com/mod' };

/**
 * One synthetic repository per language: a file set plus the import list each
 * file issues. `dirsPerRepo` grows with the file count so directory fan-out is
 * realistic at both scales rather than collapsing onto a handful of buckets.
 */
function buildRepo(lang, fileCount) {
  const dirs = Math.max(4, Math.floor(fileCount / 8));
  const files = [];
  const ext = { go: '.go', csharp: '.cs', dart: '.dart', ruby: '.rb' }[lang];
  for (let i = 0; i < fileCount; i++) {
    const d = i % dirs;
    // A nested same-name directory in one repo slice: the shape whose handling
    // the first-`indexOf` tie-break decides (see package-dir-index.ts).
    const dir =
      lang === 'go'
        ? d % 7 === 0
          ? `src/pkg${d}/internal/pkg${d}`
          : `src/pkg${d}`
        : lang === 'csharp'
          ? d % 7 === 0
            ? `src/Ns${d}/Sub/Ns${d}`
            : `src/Ns${d}`
          : lang === 'dart'
            ? d % 3 === 0
              ? `lib/feature${d}`
              : `pkg/feature${d}`
            : `lib/mod${d}`;
    const stem = lang === 'csharp' ? `File${i}` : `file${i}`;
    // Go's package leg must exclude `_test.go`; keep a real share of them.
    const suffix = lang === 'go' && i % 6 === 0 ? '_test.go' : ext;
    files.push(`${dir}/${stem}${suffix}`);
  }

  const imports = [];
  for (let i = 0; i < fileCount; i++) {
    const from = files[i];
    for (let k = 0; k < IMPORTS_PER_FILE; k++) {
      const r = mix(i * 65599 + k);
      // ~3 in 8 imports resolve in-repo; the rest are external and run the
      // whole cascade to completion (corpus property 1).
      const local = r % 8 < 3;
      const d = r % dirs;
      const j = r % fileCount;
      let target;
      if (lang === 'go') {
        target = local
          ? `${GO_MODULE.modulePath}/src/pkg${d}`
          : (r >>> 3) % 2 === 0
            ? ['fmt', 'os', 'net/http', 'encoding/json'][(r >>> 4) % 4]
            : `github.com/org/repo${(r >>> 4) % 97}/pkg/util`;
      } else if (lang === 'csharp') {
        target = local
          ? `App.Ns${d}`
          : (r >>> 3) % 2 === 0
            ? ['System', 'System.Threading.Tasks', 'System.Collections.Generic'][(r >>> 4) % 3]
            : `Ghost${(r >>> 4) % 97}.Deep.Missing`;
      } else if (lang === 'dart') {
        target = local
          ? `package:app/feature${d}/file${j}.dart`
          : (r >>> 3) % 3 === 0
            ? ['dart:core', 'dart:async', 'dart:io'][(r >>> 4) % 3]
            : `package:ext${(r >>> 4) % 97}/src/thing.dart`;
      } else {
        target = local
          ? `mod${d}/file${j}`
          : (r >>> 3) % 2 === 0
            ? ['json', 'set', 'net/http', 'digest'][(r >>> 4) % 4]
            : `gem${(r >>> 4) % 97}/missing/thing`;
      }
      imports.push([from, target]);
    }
  }
  return { files, imports };
}

/** The timed loop. A FRESH Set per pass, so every pass pays exactly one index
 *  build — reusing one Set across passes would hide the build after the first
 *  and let a rebuilt-per-import index look free from rep 2 onward. */
function resolveAll(lang, files, imports) {
  const allFilePaths = new Set(files);
  let sink = 0;
  for (const [from, target] of imports) {
    const hit = resolveOne(lang, from, target, allFilePaths);
    if (hit !== null) sink++;
  }
  return sink;
}

function resolveOne(lang, from, target, allFilePaths) {
  if (lang === 'go') return resolveGoImportTarget(target, from, allFilePaths, GO_MODULE);
  if (lang === 'dart') return resolveDartImportTarget(target, from, allFilePaths);
  if (lang === 'ruby') return resolveRubyImportTarget(target, from, allFilePaths);
  return resolveCsharpImportTarget(
    { kind: 'namespace', localName: '_', importedName: '_', targetRaw: target },
    { fromFile: from, allFilePaths },
  );
}

/** Untimed identity pass, one resolve per DISTINCT `from|target`: on a fixed
 *  file set the resolvers are pure, so a repeated pair can only re-derive what
 *  the first occurrence already recorded. */
function outcomesOf(lang, files, imports) {
  const allFilePaths = new Set(files);
  const outcomes = new Set();
  const seen = new Set();
  for (const [from, target] of imports) {
    const key = `${from}\u0000${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = resolveOne(lang, from, target, allFilePaths);
    const rendered = hit === null ? '<null>' : Array.isArray(hit) ? hit.join(',') : hit;
    outcomes.add(`${key}\u0000${rendered}`);
  }
  return outcomes;
}

/** MIN, not median: both scales are timed in one process and every error source
 *  (GC, scheduler preemption, a noisy CI neighbour) is additive, so the fastest
 *  observed pass is the closest estimate of the uncontended cost. */
function fastest(values) {
  return Math.min(...values);
}

function timeResolution(lang, files, imports) {
  for (let w = 0; w < WARMUP; w++) resolveAll(lang, files, imports);
  const samples = [];
  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    resolveAll(lang, files, imports);
    samples.push(performance.now() - t0);
  }
  return fastest(samples);
}

function fingerprint(outcomes) {
  return crypto
    .createHash('sha256')
    .update([...outcomes].sort().join('\n'))
    .digest('hex');
}

const LANGS = ['go', 'csharp', 'dart', 'ruby'];
const report = {};
for (const lang of LANGS) {
  const scales = {};
  for (const [name, fileCount] of [
    ['small', SMALL],
    ['large', LARGE],
  ]) {
    const { files, imports } = buildRepo(lang, fileCount);
    const outcomes = outcomesOf(lang, files, imports);
    scales[name] = {
      files: files.length,
      imports: imports.length,
      // Reported, not asserted on its own: a corpus edit that collapsed the
      // resolved share would still produce a "valid" fingerprint over far less.
      resolved: resolveAll(lang, files, imports),
      distinct_outcomes: outcomes.size,
      ms: Number(timeResolution(lang, files, imports).toFixed(3)),
      fingerprint: fingerprint(outcomes),
    };
  }
  report[lang] = {
    small: scales.small,
    large: scales.large,
    scaling_ratio: Number((scales.large.ms / scales.small.ms / (LARGE / SMALL)).toFixed(3)),
    fingerprint: scales.large.fingerprint,
  };
}

if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
const failures = [];
for (const lang of LANGS) {
  const got = report[lang];
  const want = baseline.languages[lang];
  if (got.fingerprint !== want.fingerprint) {
    failures.push(
      `${lang}: fingerprint drift ${got.fingerprint} != ${want.fingerprint} — the resolver ` +
        `returned a DIFFERENT target set. That is a behaviour change, not a perf one; see the ` +
        `parity harness in test/unit/scope-resolution/import-target-index-parity.test.ts.`,
    );
  }
  if (got.scaling_ratio > baseline.scaling_budget) {
    failures.push(
      `${lang}: scaling ${got.scaling_ratio} > budget ${baseline.scaling_budget} — per-import ` +
        `cost grows with corpus size again. Timing arm: re-run on an idle machine before ` +
        `investigating; the fingerprint arm never warrants a re-run.`,
    );
  }
  for (const scale of ['small', 'large']) {
    for (const field of ['files', 'imports', 'resolved', 'distinct_outcomes']) {
      if (got[scale][field] !== want[scale][field]) {
        failures.push(
          `${lang}.${scale}.${field}: ${got[scale][field]} != ${want[scale][field]} — the corpus ` +
            `changed shape. A smaller or less-resolving corpus makes the scaling arm blind, so ` +
            `this is asserted separately from the fingerprint.`,
        );
      }
    }
  }
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error(`[import-target --check] FAIL\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('[import-target --check] PASS');
