/**
 * Four-size scaling sweep for RUBY-03, including the review fixes in #3905.
 * Run after npm run build:
 *   node --import tsx bench/ruby-block-param-stop/scaling.mjs [--check]
 *
 * Resolution uses measure.mjs's real worker output and exact edge oracle.
 * Each size runs in a fresh process. Capture-only workloads exercise many
 * lambda defaults and explicit calls beside parameters in a single file.
 * Report timings, work counts, normalized growth and a fitted log-log slope;
 * a finite sweep is evidence over these sizes, not an asymptotic proof.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { emitRubyScopeCaptures } from '../../src/core/ingestion/languages/ruby/index.ts';

const REPS = 7;
const WARMUP = 2;
const check = process.argv.includes('--check');
const script = fileURLToPath(import.meta.url);
const measure = fileURLToPath(new URL('./measure.mjs', import.meta.url));
const marker = 'RUBY_BLOCK_PARAM_RESULT ';

function child(file, args) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', file, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GITNEXUS_LOG_LEVEL: 'error' },
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const line = result.stdout.split('\n').find((line) => line.startsWith(marker));
  assert.ok(line, `missing result: ${result.stdout}`);
  return JSON.parse(line.slice(marker.length));
}

function captureWorkload(kind, size) {
  if (kind === 'wide-explicit') {
    const params = Array.from({ length: size }, (_, i) => `p${i}`);
    return (
      `class Host\ndef target; end\ndef run(${params.join(', ')}, target)\n` +
      'target()\n'.repeat(size) +
      'end\nend\n'
    );
  }
  if (kind === 'defaults') {
    // Every default reads one earlier parameter. Listing ALL earlier names
    // on every default would make the emitted metadata quadratic.
    const params = Array.from({ length: size }, (_, i) => `p${i} = user.save`);
    return (
      `class Host\n# @param user [User]\ndef run(user)\n` +
      `f = ->(user, ${params.join(', ')}) { user.save }\nuser.save\nend\nend\n`
    );
  }
  return (
    `class Host\ndef target(*args); end\n` +
    Array.from(
      { length: size },
      (_, i) =>
        `def run${i}(target)\n[1].each do |target|\ntarget()\ntarget(1)\ntarget 1\nend\nend\n`,
    ).join('') +
    'end\n'
  );
}

function measureCapture(kind, size) {
  const source = captureWorkload(kind, size);
  const samples = [];
  let matches;
  for (let i = 0; i < WARMUP + REPS; i++) {
    const start = performance.now();
    matches = emitRubyScopeCaptures(source, 'scaling.rb');
    const ms = performance.now() - start;
    if (i >= WARMUP) samples.push(ms);
  }
  const lexicalNames = matches.flatMap((match) =>
    JSON.parse(match['@scope.lexical-names']?.text ?? '[]'),
  );
  if (kind === 'defaults') {
    assert.equal(matches.filter((m) => m['@type-binding.parameter']).length, 1);
    assert.equal(matches.filter((m) => m['@scope.block']).length, size + 1);
    assert.equal(lexicalNames.length, size * 2 + 2, 'default metadata must grow linearly');
  } else {
    assert.equal(
      matches.filter(
        (m) =>
          m['@reference.call.member'] &&
          m['@reference.name']?.text === 'target' &&
          m['@reference.receiver']?.text === 'self',
      ).length,
      kind === 'wide-explicit' ? size : size * 3,
    );
    assert.equal(
      matches.filter((m) => m['@callable-flow.invocation-kind']?.text === 'indirect').length,
      0,
    );
  }
  return {
    size,
    bytes: Buffer.byteLength(source),
    capture_groups: matches.length,
    lexical_names: lexicalNames.length,
    samples_ms: samples,
    capture_ms: Math.min(...samples),
  };
}

function growth(rows, phase) {
  const xs = rows.map((r) => Math.log(r.size));
  const ys = rows.map((r) => Math.log(r[phase]));
  assert.ok(ys.every(Number.isFinite), `${phase}: non-finite timing`);
  const mean = (values) => values.reduce((sum, n) => sum + n, 0) / values.length;
  const mx = mean(xs);
  const my = mean(ys);
  const exponent =
    xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) /
    xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  const first = rows[0];
  const last = rows.at(-1);
  return {
    exponent,
    normalized_growth: last[phase] / first[phase] / (last.size / first.size),
    adjacent_normalized_growth: rows
      .slice(1)
      .map((row, i) => row[phase] / rows[i][phase] / (row.size / rows[i].size)),
  };
}

if (process.argv.includes('--capture')) {
  const at = process.argv.indexOf('--capture');
  const kind = process.argv[at + 1];
  assert.ok(['defaults', 'explicit', 'wide-explicit'].includes(kind));
  const size = Number(process.argv[at + 2]);
  assert.ok(Number.isSafeInteger(size) && size > 0);
  console.log(marker + JSON.stringify(measureCapture(kind, size)));
} else {
  const series = {};
  for (const form of ['sibling', 'nested']) {
    for (const axis of ['methods', 'blocks']) {
      const sizes = axis === 'methods' ? [64, 128, 256, 512] : [3, 6, 12, 24];
      const rows = [];
      for (const size of sizes) {
        const methods = axis === 'methods' ? size : 64;
        const blocks = axis === 'blocks' ? size : 6;
        const result = child(measure, [
          '--shape',
          form,
          String(methods),
          String(blocks),
          '--reps',
          String(REPS),
          '--warmup',
          String(WARMUP),
        ]);
        assert.equal(result.shape.expected_missing, 0);
        assert.equal(result.shape.unexpected_edges, 0);
        rows.push({ size, ...result.shape, ...result.timing });
      }
      series[`${form}_${axis}`] = {
        rows,
        capture: growth(rows, 'capture_ms'),
        resolve: growth(rows, 'resolve_ms'),
      };
    }
  }
  for (const kind of ['defaults', 'explicit', 'wide-explicit']) {
    const rows = [64, 128, 256, 512].map((size) =>
      child(script, ['--capture', kind, String(size)]),
    );
    series[kind] = { rows, capture: growth(rows, 'capture_ms') };
  }
  console.log(
    JSON.stringify(
      {
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          cpu: os.cpus()[0]?.model,
        },
        estimator: {
          samples: REPS,
          warmup: WARMUP,
          statistic: 'minimum',
          fresh_process_per_size: true,
        },
        // Slack for scheduling/GC noise; a quadratic 8x sweep grows 64x and fails.
        budgets: { exponent: 1.2, normalized_growth: 1.5 },
        series,
      },
      null,
      2,
    ),
  );
  if (check) {
    for (const [name, result] of Object.entries(series)) {
      for (const phase of ['capture', 'resolve']) {
        const metric = result[phase];
        if (!metric) continue;
        assert.ok(
          metric.exponent <= 1.2 && metric.normalized_growth <= 1.5,
          `${name}/${phase}: superlinear growth ${JSON.stringify(metric)}`,
        );
      }
    }
    console.log('[ruby-block-param-stop scaling --check] PASS');
  }
}
