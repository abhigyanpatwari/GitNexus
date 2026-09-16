/**
 * Build-free bench for Rust Cargo target membership (#3253).
 *
 * WHY THIS EXISTS. `loadRustCargoTargets` is a negative-proof loader: a
 * complete snapshot lets name-fallback refuse a cross-target unique name, and
 * an incomplete one fail-opens. Graph output does not show "how many files we
 * walked" or "we aborted because of `#[derive]`". A revert to treating
 * derive/println! as unknown, a glob that drops every path segment named
 * target, or a superlinear membership walk can still emit the same one CALLS
 * edge on a tiny fixture.
 * This file is the same shape as `bench/parse-dispatch-rounds`: exact floors
 * first, one ratio timing arm, never a millisecond ceiling.
 *
 * ARMS:
 *
 * - `typical_complete` / `include_unknown` / `explicit_disjoint` — EXACT.
 *   Typical crates (derive + expression-position std macros) must still
 *   certify a snapshot. `include!` must still abort it. An explicit
 *   `[lib] path = "target/entry.rs"` must stay a complete negative proof
 *   against `tests/helper.rs`, not vanish into the artifact glob.
 *
 * - `packages` / `rust_files` / `disjoint_false` / `shared_nested` /
 *   `shared_target_module` — EXACT, and they are the FLOOR. `typical_complete`
 *   only asserts something while the corpus still has many crates to walk.
 *   Shrink it to one happy-path package and the complete arm still passes,
 *   gating a property the corpus no longer has.
 *
 * - `layout_fingerprint` — EXACT. sha256 over sorted `caller|candidate|share`
 *   rows on the typical corpus. Catches a membership-set change that leaves
 *   the counts intact.
 *
 * - `load_scaling_ratio` — the only timing arm, a RATIO not a millisecond
 *   ceiling. `(t_4n / t_n) / 4` divides the machine out; ~1.0 is linear.
 *   Superlinear AST work over crate count lands here.
 *
 * Usage:
 *   node --import tsx bench/rust-cargo-targets/measure.mjs
 *   node --import tsx bench/rust-cargo-targets/measure.mjs --check
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  loadRustCargoTargets,
  rustFilesShareCargoTarget,
} from '../../src/core/ingestion/languages/rust/cargo-targets.ts';

const baselines = JSON.parse(readFileSync(new URL('./baselines.json', import.meta.url), 'utf8'));

const REPS = 15;
const PACKAGES = 8;
const TYPICAL_LIB = [
  '#[derive(Debug)]',
  'struct S;',
  'mod nested;',
  'mod target;',
  'pub fn helper() {}',
  'fn t() { println!("hi"); assert_eq!(1, 1); let _ = vec![1]; let _ = format!("{}", 1); }',
  '',
].join('\n');

function writeCrate(root, name, { libPath = 'src/lib.rs', libBody = TYPICAL_LIB } = {}) {
  const crateDir = path.join(root, 'crates', name);
  mkdirSync(path.join(crateDir, 'src', 'target'), { recursive: true });
  mkdirSync(path.join(crateDir, 'src', 'nested'), { recursive: true });
  mkdirSync(path.join(crateDir, 'tests'), { recursive: true });
  mkdirSync(path.join(crateDir, path.dirname(libPath)), { recursive: true });
  const manifest = ['[package]', `name="${name}"`, 'version="0.1.0"', 'edition="2021"', ''];
  if (libPath !== 'src/lib.rs') {
    manifest.push('[lib]', `path="${libPath}"`, '');
  }
  writeFileSync(path.join(crateDir, 'Cargo.toml'), `${manifest.join('\n')}`);
  writeFileSync(path.join(crateDir, libPath), libBody);
  const moduleDir = path.posix.dirname(libPath);
  writeFileSync(path.join(crateDir, moduleDir, 'nested.rs'), 'pub fn nested_helper() {}\n');
  writeFileSync(path.join(crateDir, 'src', 'target', 'mod.rs'), 'pub fn target_helper() {}\n');
  writeFileSync(path.join(crateDir, 'tests', 'helper.rs'), 'pub fn helper() {}\n');
}

function writeTypical(root, packages) {
  const names = Array.from({ length: packages }, (_, i) => `c${i}`);
  writeFileSync(
    path.join(root, 'Cargo.toml'),
    `[workspace]\nmembers=[${names.map((n) => `"crates/${n}"`).join(', ')}]\n`,
  );
  for (const name of names) writeCrate(root, name);
  return names;
}

function cratePaths(name, libPath = 'src/lib.rs') {
  const lib = `crates/${name}/${libPath}`;
  const moduleDir = path.posix.dirname(libPath);
  return {
    lib,
    nested: `crates/${name}/${moduleDir}/nested.rs`,
    target: `crates/${name}/src/target/mod.rs`,
    tests: `crates/${name}/tests/helper.rs`,
  };
}

function countRs(dir) {
  let n = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) n += countRs(p);
    else if (ent.name.endsWith('.rs')) n++;
  }
  return n;
}

function shareLabel(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return 'undefined';
}

function probesFor(config, names, libPath = 'src/lib.rs') {
  const rows = [];
  let disjointFalse = 0;
  let sharedNested = 0;
  let sharedTarget = 0;
  for (const name of names) {
    const paths = cratePaths(name, libPath);
    const nested = rustFilesShareCargoTarget(config, paths.lib, paths.nested);
    const target = rustFilesShareCargoTarget(config, paths.lib, paths.target);
    const tests = rustFilesShareCargoTarget(config, paths.lib, paths.tests);
    if (tests === false) disjointFalse++;
    if (nested === true) sharedNested++;
    if (target === true) sharedTarget++;
    rows.push(
      `${paths.lib}|${paths.nested}|${shareLabel(nested)}`,
      `${paths.lib}|${paths.target}|${shareLabel(target)}`,
      `${paths.lib}|${paths.tests}|${shareLabel(tests)}`,
    );
  }
  return {
    disjointFalse,
    sharedNested,
    sharedTarget,
    fingerprint: createHash('sha256').update(rows.sort().join('\n')).digest('hex'),
  };
}

async function fastest(fn, reps) {
  await fn();
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

const roots = [];
function workspace(build) {
  const root = mkdtempSync(path.join(tmpdir(), 'gn-rust-cargo-bench-'));
  roots.push(root);
  build(root);
  return root;
}

try {
  const typicalRoot = workspace((root) => writeTypical(root, PACKAGES));
  const typical4xRoot = workspace((root) => writeTypical(root, PACKAGES * 4));
  const explicitRoot = workspace((root) => {
    writeFileSync(path.join(root, 'Cargo.toml'), '[workspace]\nmembers=["crates/explicit"]\n');
    writeCrate(root, 'explicit', {
      libPath: 'target/entry.rs',
      libBody: '#[derive(Debug)] struct S;\nmod nested;\npub fn helper() {}\n',
    });
  });
  const includeRoot = workspace((root) => {
    writeFileSync(path.join(root, 'Cargo.toml'), '[workspace]\nmembers=["crates/unknown"]\n');
    writeCrate(root, 'unknown', { libBody: 'include!("generated.rs");\n' });
  });

  const typicalNames = Array.from({ length: PACKAGES }, (_, i) => `c${i}`);
  const [typicalConfig, explicitConfig, includeConfig] = await Promise.all([
    loadRustCargoTargets(typicalRoot),
    loadRustCargoTargets(explicitRoot),
    loadRustCargoTargets(includeRoot),
  ]);

  const typical = probesFor(typicalConfig, typicalNames);
  const explicitPaths = cratePaths('explicit', 'target/entry.rs');
  const explicitShare = rustFilesShareCargoTarget(
    explicitConfig,
    explicitPaths.lib,
    explicitPaths.tests,
  );
  const includeShare = rustFilesShareCargoTarget(
    includeConfig,
    'crates/unknown/src/lib.rs',
    'crates/unknown/tests/helper.rs',
  );

  const rustFiles = countRs(typicalRoot);
  const typicalComplete = typicalConfig !== undefined ? 1 : 0;
  const includeUnknown = includeConfig === undefined && includeShare === undefined ? 1 : 0;
  const explicitDisjoint = explicitShare === false ? 1 : 0;

  const smallMs = await fastest(() => loadRustCargoTargets(typicalRoot), REPS);
  const largeMs = await fastest(() => loadRustCargoTargets(typical4xRoot), REPS);
  const loadScaling = largeMs / smallMs / 4;

  console.log(`packages               : ${PACKAGES}  (expect ${baselines.packages})`);
  console.log(`rust_files             : ${rustFiles}  (expect ${baselines.rust_files})`);
  console.log(
    `typical_complete       : ${typicalComplete}  (expect ${baselines.typical_complete})`,
  );
  console.log(`include_unknown        : ${includeUnknown}  (expect ${baselines.include_unknown})`);
  console.log(
    `explicit_disjoint      : ${explicitDisjoint}  (expect ${baselines.explicit_disjoint})`,
  );
  console.log(
    `disjoint_false         : ${typical.disjointFalse}  (expect ${baselines.disjoint_false})`,
  );
  console.log(
    `shared_nested          : ${typical.sharedNested}  (expect ${baselines.shared_nested})`,
  );
  console.log(
    `shared_target_module   : ${typical.sharedTarget}  (expect ${baselines.shared_target_module})`,
  );
  console.log(`layout_fingerprint     : ${typical.fingerprint}`);
  console.log(
    `load_scaling_ratio     : ${loadScaling.toFixed(3)}  (budget <= ${baselines.load_scaling_budget}; ~1.0 is linear)`,
  );
  console.log(
    `reps                   : ${REPS}   small ${smallMs.toFixed(2)}ms / 4x ${largeMs.toFixed(2)}ms`,
  );

  if (process.argv.includes('--check')) {
    let failed = false;

    if (typical.fingerprint !== baselines.layout_fingerprint) {
      failed = true;
      console.error(
        `\nFAIL layout_fingerprint: ${typical.fingerprint}\n` +
          `  expected ${baselines.layout_fingerprint}\n` +
          `  Typical-corpus membership moved. Explain it; do not re-baseline alone.`,
      );
    }

    if (typicalComplete !== baselines.typical_complete) {
      failed = true;
      console.error(
        `\nFAIL typical_complete: ${typicalComplete}, expected ${baselines.typical_complete}.\n` +
          `  Ordinary #[derive] / println! / assert_eq! aborted the snapshot, so the\n` +
          `  #3253 veto never loads on typical crates.`,
      );
    }
    if (includeUnknown !== baselines.include_unknown) {
      failed = true;
      console.error(
        `\nFAIL include_unknown: ${includeUnknown}, expected ${baselines.include_unknown}.\n` +
          `  Item-position include! must still abort the membership proof.`,
      );
    }
    if (explicitDisjoint !== baselines.explicit_disjoint) {
      failed = true;
      console.error(
        `\nFAIL explicit_disjoint: ${explicitDisjoint}, expected ${baselines.explicit_disjoint}.\n` +
          `  [lib] path = "target/entry.rs" was dropped or left unknown — usually\n` +
          `  **/target/** glob ignore rather than Cargo artifact layouts.`,
      );
    }
    if (
      typical.disjointFalse !== baselines.disjoint_false ||
      typical.sharedNested !== baselines.shared_nested ||
      typical.sharedTarget !== baselines.shared_target_module
    ) {
      failed = true;
      console.error(
        `\nFAIL membership counts: disjoint_false ${typical.disjointFalse} (expected ${baselines.disjoint_false}), ` +
          `shared_nested ${typical.sharedNested} (expected ${baselines.shared_nested}), ` +
          `shared_target_module ${typical.sharedTarget} (expected ${baselines.shared_target_module}).\n` +
          `  Cross-target tests/helper.rs must stay proven-false; src/target/mod.rs must stay a library module.`,
      );
    }

    if (PACKAGES !== baselines.packages || rustFiles !== baselines.rust_files) {
      failed = true;
      console.error(
        `\nFAIL shape: packages ${PACKAGES} (expected ${baselines.packages}), ` +
          `rust_files ${rustFiles} (expected ${baselines.rust_files}).\n` +
          `  The corpus must stay large enough that the complete/disjoint arms still measure a walk.`,
      );
    }

    if (loadScaling > baselines.load_scaling_budget) {
      failed = true;
      console.error(
        `\nFAIL load_scaling_ratio: ${loadScaling.toFixed(3)} exceeds ` +
          `${baselines.load_scaling_budget} (~1.0 is linear).\n` +
          `  Re-run on an idle machine before investigating, and check \`reps\` first.`,
      );
    }

    if (failed) process.exit(1);
    console.log('\nOK — within budget.');
  }
} finally {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
}
