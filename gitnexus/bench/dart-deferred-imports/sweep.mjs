/**
 * Reproduce the PR #3910 scaling sweep on its pinned source tree.
 * npm run build
 * node --import tsx bench/dart-deferred-imports/sweep.mjs --output /absolute/output.json
 * Optional: --sizes 16,32,64,128,256 --rounds 3 --warmup 2 --reps 5
 * Sequential fresh processes avoid competing benchmark workers. Both forms
 * run adjacent; size and form order rotate between rounds. No timing verdict
 * is baked in: the output retains every sample, including warmup observations.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(folder, 'measure.mjs');
const sourceRoot = path.resolve(folder, '../../..');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' });
const trackedChanges = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
  cwd: sourceRoot,
  encoding: 'utf8',
});
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const sizes = option('--sizes', '16,32,64,128,256').split(',').map(Number);
const rounds = Number(option('--rounds', '3'));
const warmup = Number(option('--warmup', '2'));
const reps = Number(option('--reps', '5'));
const output = path.resolve(option('--output', 'dart-deferred-sweep.json'));
assert.ok(sizes.length >= 2 && new Set(sizes).size === sizes.length);
for (const value of [...sizes, rounds, reps]) assert.ok(Number.isSafeInteger(value) && value > 0);
assert.ok(Number.isSafeInteger(warmup) && warmup >= 0);
fs.mkdirSync(path.dirname(output), { recursive: true });

const report = {
  schema_version: 1,
  source_commit: revision.status === 0 ? revision.stdout.trim() : null,
  source_dirty: trackedChanges.status === 0 ? trackedChanges.stdout.trim().length > 0 : null,
  pull_request: 'https://github.com/abhigyanpatwari/GitNexus/pull/3910',
  started_at: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model,
    logical_cpus: os.cpus().length,
    available_parallelism: os.availableParallelism(),
    total_memory_bytes: os.totalmem(),
    load_average_start: os.loadavg(),
  },
  config: { sizes, rounds, warmup, reps, fixed_dimension: 16 },
  methodology: {
    process: 'One fresh process per form, size, axis and round; sequential execution.',
    order:
      'Size order reverses/rotates by round; form order alternates; phase order alternates per pass.',
    preparation:
      'Real worker parse, first resolution and one capture pass precede explicit warmups.',
    capture: 'emitDartScopeCaptures over all files; includes tree-sitter parsing.',
    resolve: 'runScopeResolution; structured clone and graph replay excluded from timing.',
    correctness:
      'Exact workload formulas and full graph fingerprint on every resolution; paired form equality.',
    exclusions:
      'No filesystem scanning, persistence, config loading, end-to-end analyze or full-pipeline memory claim.',
    inference:
      'Log-log slopes are finite-range descriptions, not asymptotic proofs. Round ranges are not confidence intervals.',
  },
  files_sha256: Object.fromEntries(
    ['measure.mjs', 'sweep.mjs', 'baseline.json'].map((name) => [
      name,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(folder, name)))
        .digest('hex'),
    ]),
  ),
  status: 'running',
  cells: [],
};
const save = () => {
  fs.writeFileSync(`${output}.tmp`, JSON.stringify(report, null, 2) + '\n');
  fs.renameSync(`${output}.tmp`, output);
};
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const pinned = JSON.parse(fs.readFileSync(path.join(folder, 'baseline.json'), 'utf8'));
save();
try {
  for (let round = 0; round < rounds; round++) {
    let orderedSizes = round % 2 ? [...sizes].reverse() : [...sizes];
    orderedSizes = [
      ...orderedSizes.slice(round % sizes.length),
      ...orderedSizes.slice(0, round % sizes.length),
    ];
    const axes = round % 2 ? ['uses', 'prefixes'] : ['prefixes', 'uses'];
    for (const axis of axes) {
      for (let index = 0; index < orderedSizes.length; index++) {
        const size = orderedSizes[index];
        const prefixes = axis === 'prefixes' ? size : 16;
        const uses = axis === 'uses' ? size : 16;
        const forms = (index + round) % 2 ? ['prefixed', 'deferred'] : ['deferred', 'prefixed'];
        const pair = [];
        for (const form of forms) {
          const started = performance.now();
          const args = [
            '--import',
            'tsx',
            runner,
            '--sweep-cell',
            form,
            String(prefixes),
            String(uses),
            String(warmup),
            String(reps),
            String(index + round),
          ];
          const child = spawnSync(process.execPath, args, {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            timeout: 300_000,
            env: { ...process.env, GITNEXUS_LOG_LEVEL: 'error' },
          });
          const marker = child.stdout
            ?.split('\n')
            .find((line) => line.startsWith('DART_DEFERRED_RESULT '));
          assert.ok(
            child.status === 0 && marker,
            `${form} ${prefixes}x${uses}: ${child.error?.message || child.stderr || child.stdout}`,
          );
          const result = JSON.parse(marker.slice('DART_DEFERRED_RESULT '.length));
          const known = Object.entries(pinned.shapes).find(
            ([name, shape]) =>
              name.startsWith(`${form}_`) &&
              shape.prefixes === prefixes &&
              shape.uses_per_prefix === uses,
          )?.[1];
          if (known) assert.deepEqual(result.shape, known);
          const cell = {
            round,
            axis,
            size,
            completed_at: new Date().toISOString(),
            elapsed_seconds: (performance.now() - started) / 1000,
            ...result,
          };
          report.cells.push(cell);
          pair.push(cell);
          save();
          const measured = cell.samples.filter((sample) => !sample.warmup);
          console.log(
            `${report.cells.length}/${rounds * 2 * sizes.length * 2} round=${round + 1}` +
              ` ${axis}=${size} ${form} capture=${median(measured.map((s) => s.capture_ms)).toFixed(1)}ms` +
              ` resolve=${median(measured.map((s) => s.resolve_ms)).toFixed(1)}ms`,
          );
        }
        assert.equal(
          pair[0].shape.fingerprint,
          pair[1].shape.fingerprint,
          `round ${round + 1} ${axis} ${size}: deferred and prefixed graphs differ`,
        );
      }
    }
  }
  report.status = 'complete';
  report.completed_at = new Date().toISOString();
  report.environment.load_average_end = os.loadavg();
  save();
  console.log(`Saved all samples and validated shapes: ${output}`);
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  save();
  throw error;
}
