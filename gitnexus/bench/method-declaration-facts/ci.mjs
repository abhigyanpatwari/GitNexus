#!/usr/bin/env node
// One report for paired end-to-end time/RSS and retained declaration heap.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'baseline-root': { type: 'string' },
    'candidate-root': { type: 'string' },
    corpus: { type: 'string', default: 'repository' },
    output: { type: 'string' },
    samples: { type: 'string', default: '3' },
    'heap-samples': { type: 'string', default: '5' },
  },
});
assert(values['baseline-root'] && values['candidate-root'] && values.output);
assert(['repository', 'declarations'].includes(values.corpus));
const samples = Number(values.samples);
const heapSamples = Number(values['heap-samples']);
assert(Number.isInteger(samples) && samples >= 1 && samples <= 10);
assert(Number.isInteger(heapSamples) && heapSamples >= 1 && heapSamples <= 20);
const roots = {
  baseline: path.resolve(values['baseline-root']),
  candidate: path.resolve(values['candidate-root']),
};
const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(values.output);
mkdirSync(output); // Refuse existing destinations, including symlinks.
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const revision = (root) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const report = {
  schemaVersion: 1,
  corpus: values.corpus,
  samples: { endToEndPairs: samples, heapPairsPerLanguage: heapSamples },
  runUrl: process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
  },
  revisions: Object.fromEntries(
    Object.entries(roots).map(([side, root]) => [side, revision(root)]),
  ),
  lockfiles: Object.fromEntries(
    Object.entries(roots).map(([side, root]) => [
      side,
      sha256(path.join(root, 'package-lock.json')),
    ]),
  ),
  harness: Object.fromEntries(
    ['ci.mjs', 'measure.mjs', 'memory.mjs'].map((file) => [file, sha256(path.join(here, file))]),
  ),
  comparisons: { control: [], candidate: [] },
  heap: [],
  complete: false,
};
const save = () =>
  writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
save();

function child(script, args, name) {
  const cache = mkdtempSync(path.join(os.tmpdir(), 'callable-identity-'));
  let stdout;
  try {
    stdout = execFileSync(process.execPath, ['--expose-gc', path.join(here, script), ...args], {
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, XDG_RUNTIME_DIR: cache },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    writeFileSync(path.join(output, `${name}.stdout`), error.stdout ?? '');
    writeFileSync(path.join(output, `${name}.stderr`), error.stderr ?? String(error));
    throw error;
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
  writeFileSync(path.join(output, `${name}.stdout`), stdout);
  return script === 'measure.mjs'
    ? JSON.parse(
        stdout
          .split('\n')
          .find((line) => line.startsWith('BENCH_RESULT='))
          .slice(13),
      )
    : JSON.parse(stdout);
}

const order = (number) =>
  number % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const change = (before, after) => `${((after / before - 1) * 100).toFixed(2)}%`;

function summary() {
  const lines = [
    `# Callable time and memory: ${report.corpus}`,
    '',
    `Baseline: \`${report.revisions.baseline}\`; candidate: \`${report.revisions.candidate}\`.`,
    `Node ${process.version}; ${samples} alternating end-to-end pairs and ${heapSamples} heap pairs per language.`,
    `Dependency lockfiles ${report.lockfiles.baseline === report.lockfiles.candidate ? 'match' : '**differ; changes include dependency effects**'}.`,
    '',
    '| Comparison | Metric | Baseline | Candidate | Change |',
    '| --- | --- | ---: | ---: | ---: |',
  ];
  for (const [comparison, pairs] of Object.entries(report.comparisons)) {
    if (!pairs.length) continue;
    const metrics = {
      'Total indexing (ms)': (r) => r.runs.reduce((sum, run) => sum + run.wallMs, 0),
      'Peak process RSS (MiB)': (r) => Math.max(...r.runs.map((run) => run.cumulativeMaxRssMiB)),
      ...Object.fromEntries(
        ['cold', 'warm', 'changed'].map((scenario) => [
          `${scenario} indexing (ms)`,
          (r) => r.runs.find((run) => run.scenario === scenario).wallMs,
        ]),
      ),
    };
    for (const [label, metric] of Object.entries(metrics)) {
      const before = median(pairs.map((pair) => metric(pair.baseline)));
      const after = median(pairs.map((pair) => metric(pair.candidate)));
      lines.push(
        `| ${comparison === 'control' ? 'A/A noise control' : 'A/B'} | ${label} | ${before.toFixed(2)} | ${after.toFixed(2)} | ${change(before, after)} |`,
      );
    }
  }
  for (const language of ['java', 'typescript']) {
    const pairs = report.heap.filter((pair) => pair.language === language);
    if (!pairs.length) continue;
    for (const metric of [
      'extractionRetainedBytes',
      'emittedRetainedBytes',
      'releasedDeltaBytes',
    ]) {
      const before = median(pairs.map((pair) => pair.baseline[metric])) / 1048576;
      const after = median(pairs.map((pair) => pair.candidate[metric])) / 1048576;
      lines.push(
        `| ${language} heap | ${metric} (MiB) | ${before.toFixed(3)} | ${after.toFixed(3)} | ${change(before, after)} |`,
      );
    }
  }
  lines.push(
    '',
    report.complete
      ? 'All graph, cache-replay, digest, and tree-collection checks passed.'
      : '**Incomplete run; do not treat partial measurements as a performance result.**',
    '',
    'RSS is the cumulative process high-water mark across cold/warm/changed indexing, including worker threads and native memory. Retained heap is a separate forced-GC single-isolate probe; it includes cache overhead and is not whole-index memory.',
    '',
    'Compare A/B shifts with the identical-code A/A noise control. Timing and RSS are reported without a hard threshold; semantic mismatches and incomplete measurements fail the job.',
    '',
    'Raw per-phase timings, RSS samples, cache counts, graph hashes, heap stages, and harness hashes are in results.json.',
  );
  writeFileSync(path.join(output, 'summary.md'), lines.join('\n') + '\n');
}

try {
  for (const comparison of ['control', 'candidate']) {
    for (let number = 0; number < samples; number++) {
      const pair = {};
      for (const side of order(number)) {
        console.log(`${comparison} ${number + 1}/${samples}: ${side}`);
        pair[side] = child(
          'measure.mjs',
          [
            '--child',
            'analysis',
            '--root',
            roots[comparison === 'control' ? 'baseline' : side],
            '--corpus',
            values.corpus,
          ],
          `${comparison}-${number}-${side}`,
        );
      }
      report.comparisons[comparison].push(pair);
      save();
      assert.deepEqual(
        pair.baseline.manifest,
        pair.candidate.manifest,
        'different corpus manifests',
      );
      assert.deepEqual(
        pair.baseline.runs.map((r) => r.facts),
        pair.candidate.runs.map((r) => r.facts),
        'graph parity failed',
      );
      for (const result of Object.values(pair)) {
        assert.deepEqual(
          result.runs.map((r) => r.scenario),
          ['cold', 'warm', 'changed'],
        );
        assert.equal(result.runs[1].reparsed, 0);
        assert.equal(result.runs[2].reparsed, 1);
        assert(result.runs.every((r) => r.facts.nodes > 0 && r.facts.edges > 0));
      }
    }
  }
  for (const language of ['java', 'typescript']) {
    for (let number = 0; number < heapSamples; number++) {
      const pair = { language };
      for (const side of order(number)) {
        pair[side] = child(
          'memory.mjs',
          ['--root', roots[side], '--language', language],
          `heap-${language}-${number}-${side}`,
        );
      }
      report.heap.push(pair);
      save();
      assert.equal(pair.baseline.digest, pair.candidate.digest, 'heap probe semantic mismatch');
      assert(
        pair.baseline.treeCollected && pair.candidate.treeCollected,
        'probe retained its native tree',
      );
    }
  }
  report.complete = true;
} finally {
  save();
  summary();
}
