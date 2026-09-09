/**
 * Ruby gem-boundary correctness and cost gate (#3096).
 *
 * Calls the production ScopeResolver hooks, including the filesystem-backed
 * configuration loader. Fixture creation and correctness hashing are untimed.
 * Each timed pass reloads config and owns a fresh file Set, so neither the
 * manifest load nor the per-pass fallback index is hidden by a warm memo.
 *
 * Small/large grow sibling projects, files, declarations and imports together.
 * Dense keeps projects/imports fixed and grows extra declarations from 8 to 128:
 * lookup must depend on require/path depth, not the number of declared gems.
 *
 * node --import tsx bench/ruby-gem-resolution/measure.mjs [--check]
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rubyScopeResolver } from '../../src/core/ingestion/languages/ruby/scope-resolver.ts';

const baselinePath = fileURLToPath(new URL('./baseline.json', import.meta.url));
const CHECK = process.argv.includes('--check');
const WARMUP = 2;
const REPS = 9;
const IMPORTS_PER_PROJECT = 256;
const roots = [];

function corpus(projects, gemsPerProject = 8) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-ruby-gems-bench-'));
  roots.push(root);
  const files = ['decoy/lib/generators.rb', 'decoy/lib/types.rb', 'decoy/lib/missing.rb'];
  const queries = [];
  for (let i = 0; i < projects; i++) {
    const directory = `packages/pkg${i}`;
    const onDisk = path.join(root, directory);
    fs.mkdirSync(path.join(onDisk, 'engine'), { recursive: true });
    fs.writeFileSync(
      path.join(onDisk, 'Gemfile'),
      [
        "gem 'rails'",
        "gem 'dry-types'",
        "gem 'aliased', require: 'custom/entry'",
        "gem 'my_engine', path: 'engine'",
        ...Array.from({ length: gemsPerProject }, (_, gem) => `gem 'dependency_${i}_${gem}'`),
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(onDisk, 'engine', 'my_engine.gemspec'),
      "Gem::Specification.new do |s|\n  s.name = 'my_engine'\n  s.require_paths = ['lib']\nend\n",
    );
    fs.writeFileSync(
      path.join(onDisk, 'Gemfile.lock'),
      'GEM\n  remote: https://rubygems.org/\n  specs:\n    locked_gem (1.0.0)\n',
    );
    const from = `${directory}/app/main.rb`;
    files.push(
      from,
      `${directory}/app/helper.rb`,
      `${directory}/lib/local_${i}.rb`,
      `${directory}/engine/lib/my_engine.rb`,
    );
    const cases = [
      ['rails/generators', null],
      ['dry/types', null],
      ['custom/entry', null],
      ['my_engine', `${directory}/engine/lib/my_engine.rb`],
      ['my_engine/missing', null],
      ['./helper', `${directory}/app/helper.rb`],
      [`local_${i}`, `${directory}/lib/local_${i}.rb`],
      ['locked_gem/missing', null],
      [`dependency_${i}_0/missing`, null],
      [`dependency_${(i + 1) % projects}_0/missing`, 'decoy/lib/missing.rb'],
    ];
    for (let j = 0; j < IMPORTS_PER_PROJECT; j++) {
      const [target, expected] = cases[j % cases.length];
      queries.push({ from, target, expected });
    }
  }
  return { root, projects, gemsPerProject, files, queries };
}

function resolve(query, pass) {
  return rubyScopeResolver.resolveImportTarget(query.target, query.from, pass.files, pass.config);
}

function prepare(input) {
  return {
    files: new Set(input.files),
    config: rubyScopeResolver.loadResolutionConfig(input.root),
  };
}

function correctness(input) {
  const pass = prepare(input);
  assert.ok(pass.config, 'the real manifest loader must supply configuration');
  const records = [];
  let resolved = 0;
  for (const query of input.queries) {
    const answer = resolve(query, pass);
    assert.equal(answer, query.expected, `${query.from}: ${query.target}`);
    if (answer !== null) resolved++;
    records.push(`${query.from}|${query.target}->${answer}`);
  }
  // The external decoy must actually be reachable without dependency evidence;
  // otherwise an always-null resolver could make a negative-only gate pass.
  assert.equal(
    resolve(
      { from: input.queries[0].from, target: 'rails/generators' },
      { files: pass.files, config: undefined },
    ),
    'decoy/lib/generators.rb',
  );
  return {
    projects: input.projects,
    declarations_per_project: input.gemsPerProject + 4,
    scopes: pass.config.scopesByDirectory.size,
    files: input.files.length,
    imports: records.length,
    resolved,
    fingerprint: crypto.createHash('sha256').update(records.join('\n')).digest('hex'),
  };
}

function measure(input, expectedResolved) {
  const loading = [];
  const resolution = [];
  for (let run = 0; run < WARMUP + REPS; run++) {
    const files = new Set(input.files);
    const loadStart = performance.now();
    const config = rubyScopeResolver.loadResolutionConfig(input.root);
    const loadMs = performance.now() - loadStart;
    const pass = { files, config };
    const start = performance.now();
    let resolved = 0;
    for (const query of input.queries) if (resolve(query, pass) !== null) resolved++;
    const resolveMs = performance.now() - start;
    assert.equal(resolved, expectedResolved, 'timed pass must do the validated work');
    if (run >= WARMUP) {
      loading.push(loadMs);
      resolution.push(resolveMs);
    }
  }
  // Like the neighboring resolver gates: min-of-N limits scheduler/GC noise.
  return { load_ms: Math.min(...loading), resolve_ms: Math.min(...resolution) };
}

try {
  const inputs = { small: corpus(32), large: corpus(128), dense: corpus(32, 128) };
  const shapes = {};
  const timings = {};
  for (const [name, input] of Object.entries(inputs)) {
    shapes[name] = correctness(input);
    timings[name] = measure(input, shapes[name].resolved);
  }
  const scale = inputs.large.projects / inputs.small.projects;
  const metrics = {
    load_scaling_ratio: timings.large.load_ms / timings.small.load_ms / scale,
    resolve_scaling_ratio: timings.large.resolve_ms / timings.small.resolve_ms / scale,
    dependency_count_ratio: timings.dense.resolve_ms / timings.small.resolve_ms,
    small_load_ms: timings.small.load_ms,
    small_resolve_ms: timings.small.resolve_ms,
    dense_load_ms: timings.dense.load_ms,
  };
  const report = {
    shapes,
    timings,
    metrics,
    estimator: { warmup: WARMUP, samples: REPS, statistic: 'minimum' },
  };
  console.log(JSON.stringify(report, null, 2));
  if (CHECK) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    assert.deepEqual(shapes, baseline.shapes, 'Ruby workload/fingerprint drift');
    const failures = [];
    for (const [name, budget] of Object.entries(baseline.budgets)) {
      if (!Number.isFinite(metrics[name]) || metrics[name] > budget) {
        failures.push(`${name}: ${metrics[name]} > ${budget}`);
      }
    }
    assert.equal(failures.length, 0, failures.join('\n'));
    console.log('[ruby-gem-resolution --check] PASS');
  }
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
