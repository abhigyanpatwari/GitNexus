/**
 * Resolver-output correctness fingerprint for `resolvePythonImportTarget`
 * (ce-optimize: python-scope-capture, hypothesis H2).
 *
 * H2 replaces the per-import O(files) suffix scan + candidate scan in
 * import-target.ts with a memoized index. The index MUST reproduce the exact
 * resolution result (including the deterministic tie-break and the
 * false-positive gating) for every input. This harness pins that: it runs
 * resolvePythonImportTarget over an exhaustive branch matrix PLUS a large
 * deterministic fuzz (varied repo layouts that force collisions / multi-match
 * tie-breaks), and prints an order-independent sha256 over every
 * `fromFile | targetRaw | result` triple.
 *
 * Build-free via tsx (static .ts import). Run:
 *   node --import tsx bench/python-scope/import-target-fingerprint.mjs
 *
 * The fingerprint before and after the H2 change MUST be identical.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePythonImportTarget } from '../../src/core/ingestion/languages/python/import-target.ts';

function mkImport(targetRaw) {
  return { kind: 'absolute', targetRaw, isRelative: false, names: [] };
}

function resolve(fromFile, files, targetRaw) {
  const ctx = { fromFile, allFilePaths: new Set(files) };
  return resolvePythonImportTarget(mkImport(targetRaw), ctx);
}

const lines = [];
let nonNull = 0;
function record(fromFile, files, targetRaw) {
  const r = resolve(fromFile, files, targetRaw);
  if (r !== null) nonNull++;
  lines.push(`${fromFile}\t${targetRaw}\t${r === null ? 'NULL' : r}`);
}

// ---- 1. Exhaustive branch matrix ----------------------------------------

// direct root hit
record('app/main.py', ['services/sync.py', 'services/__init__.py'], 'services.sync');
// direct package (__init__) hit
record('app/main.py', ['services/__init__.py'], 'services');
// ancestor walk hit
record('backend/routers/cron.py', ['backend/services/sync.py'], 'services.sync');
// ancestor pkg hit
record('backend/routers/cron.py', ['backend/services/__init__.py'], 'services');
// suffix fallback single match (nested vendor layout)
record('app/main.py', ['pkg/__init__.py', 'vendor/pkg/thing.py'], 'pkg.thing');
// suffix fallback to __init__ (package)
record('app/main.py', ['pkg/__init__.py', 'x/pkg/subpkg/__init__.py'], 'pkg.subpkg');
// suffix multi-match tie-break: fewest segments wins
record('app/main.py', ['pkg/__init__.py', 'a/pkg/models.py', 'b/c/pkg/models.py'], 'pkg.models');
// suffix multi-match tie-break at SAME depth: lexicographic
record('app/main.py', ['pkg/__init__.py', 'z/pkg/models.py', 'a/pkg/models.py'], 'pkg.models');
// suffix file vs pkg same name, mixed — both candidate forms present
record(
  'app/main.py',
  ['pkg/__init__.py', 'q/pkg/models.py', 'r/pkg/models/__init__.py'],
  'pkg.models',
);
// hasRepoCandidate FALSE — external dotted import w/ colliding local basename (django.apps guard)
record('app/main.py', ['accounts/apps.py'], 'django.apps');
// hasRepoCandidate TRUE via top-level package, but no concrete file -> null
record('app/main.py', ['pkg/__init__.py'], 'pkg.ghost');
// hasRepoCandidate via nested ancestor namespace package
record('backend/routers/cron.py', ['backend/services/sync.py'], 'services.helpers.util');
// collision: accounts.models must NOT match billing/models.py
record('app/main.py', ['accounts/__init__.py', 'billing/models.py'], 'accounts.models');
// relative imports
record('app/main.py', ['app/sibling.py'], '.sibling');
record('app/pkg/mod.py', ['app/sibling.py'], '..sibling');
record('app/main.py', ['app/sibling.py'], '...way.too.far');
// single-segment bare import (no '/'): skips candidate gate
record('app/main.py', ['mod.py'], 'mod');
record('app/main.py', ['lib/mod.py'], 'mod');
record('app/pkg/main.py', ['app/pkg/local.py'], 'local');
// empty / dynamic
record('app/main.py', ['a.py'], '');
// windows-style backslash paths in the set
record('app\\main.py', ['svc\\sync.py', 'svc\\__init__.py'], 'svc.sync');

// ---- 2. Deterministic fuzz ----------------------------------------------
// LCG (no Math.random — deterministic + reproducible).
let seed = 0x9e3779b9;
function rnd() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}
function pick(arr) {
  return arr[Math.floor(rnd() * arr.length)];
}

const DIRS = ['', 'a', 'b', 'a/b', 'b/c', 'x/y/z', 'vendor', 'src', 'src/app', 'pkg'];
const SEGS = [
  'pkg',
  'services',
  'models',
  'sync',
  'util',
  'core',
  'apps',
  'sub',
  'thing',
  'helpers',
];

function randPath() {
  const dir = pick(DIRS);
  const base = pick(SEGS);
  const isPkg = rnd() < 0.3;
  const file = isPkg ? `${base}/__init__.py` : `${base}.py`;
  return dir ? `${dir}/${file}` : file;
}
function randDotted() {
  const n = 1 + Math.floor(rnd() * 3);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(pick(SEGS));
  const rel = rnd() < 0.15 ? '.'.repeat(1 + Math.floor(rnd() * 2)) : '';
  return rel + parts.join('.');
}

for (let repo = 0; repo < 400; repo++) {
  const fileCount = 3 + Math.floor(rnd() * 14);
  const files = [];
  for (let i = 0; i < fileCount; i++) files.push(randPath());
  const fromFile = randPath();
  for (let imp = 0; imp < 25; imp++) {
    record(fromFile, files, randDotted());
  }
}

// ---- 3. Absolute-path coverage (PR #1918 review P3a) --------------------
// Production paths are repo-relative, but the index's prefix gating must
// reproduce the old `f.startsWith(prefix)` semantics for absolute paths too.
// The reviewer's exact case + a fuzz over leading-`/` file sets and absolute
// importer paths lock the absolute-path behavior end to end.

// The flagged case: an absolute file under the importer's own root.
record('/repo/app/main.py', ['/repo/svc/x.py'], 'svc.x');
record('/repo/app/main.py', ['/repo/svc/__init__.py', '/repo/svc/x.py'], 'svc.x');
// Absolute file NOT under the importer root — gate must not pass it.
record('/repo/app/main.py', ['/other/svc/x.py'], 'svc.x');
// Absolute vendored layout reachable only by suffix.
record('/repo/app/main.py', ['/repo/pkg/__init__.py', '/repo/vendor/pkg/thing.py'], 'pkg.thing');
// Absolute tie-break.
record(
  '/repo/app/main.py',
  ['/repo/pkg/__init__.py', '/a/pkg/models.py', '/b/c/pkg/models.py'],
  'pkg.models',
);
// Mixed absolute/relative file set.
record('/repo/app/main.py', ['/repo/pkg/__init__.py', 'pkg/models.py'], 'pkg.models');

function randAbsPath() {
  // Reuse the relative generator under one of a few absolute roots.
  const root = pick(['/repo', '/srv/app', '/']);
  const rel = randPath();
  return root === '/' ? `/${rel}` : `${root}/${rel}`;
}

for (let repo = 0; repo < 200; repo++) {
  const fileCount = 3 + Math.floor(rnd() * 12);
  const files = [];
  for (let i = 0; i < fileCount; i++) files.push(randAbsPath());
  const fromFile = randAbsPath();
  for (let imp = 0; imp < 20; imp++) {
    record(fromFile, files, randDotted());
  }
}

const fingerprint = crypto
  .createHash('sha256')
  .update([...lines].sort().join('\n'))
  .digest('hex');
const result = { fingerprint, cases: lines.length, non_null: nonNull };

if (!process.argv.includes('--check')) {
  process.stdout.write(JSON.stringify(result) + '\n');
} else {
  // CI gate: resolver output unchanged (fingerprint == committed baseline).
  // Re-baseline a legitimate resolution change by running without --check and
  // committing the new baseline-import-target-fingerprint.txt deliberately.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const baseline = fs
    .readFileSync(path.resolve(__dirname, 'baseline-import-target-fingerprint.txt'), 'utf8')
    .trim();
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.fingerprint !== baseline) {
    process.stderr.write(
      `[import-target-fingerprint --check] FAIL: resolver fingerprint drift: got ` +
        `${result.fingerprint}, expected ${baseline} (resolvePythonImportTarget output changed — ` +
        `re-baseline intentionally if expected)\n`,
    );
    process.exit(1);
  }
  process.stderr.write('[import-target-fingerprint --check] PASS (resolver fingerprint)\n');
}
