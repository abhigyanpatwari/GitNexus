#!/usr/bin/env node
/**
 * Per-file parse-cache benchmark. Build both revisions with their lockfiles.
 * From gitnexus/: node bench/file-result-reuse/benchmark.js --check
 *   --baseline-dist /path/to/base/gitnexus/dist --pairs 7 --workers 2
 *   --output /tmp/file-result-reuse/measure.json
 * Add --corpus /path/to/base/gitnexus/src for frozen real-source measurements.
 * Standalone: node --expose-gc --predictable-gc-schedule benchmark.js --files 1024
 *
 * Each phase has a fresh Node process and retains only on-disk input/cache state.
 * Timing covers ingestion and cache save, excluding startup and verification.
 * Peak RSS is max(phase process maxRSS), including parser worker threads.
 * Both arms use the same fixed GC profile; collection during analysis is timed.
 * V8's --predictable is deliberately absent: it serialises collection and
 * compilation, which nearly doubled cold RSS and slowed warm runs by 40%, so
 * the gate measured a runtime nobody ships.
 * Matching phases run consecutively; the first arm alternates between pairs.
 * Graph fingerprints retain every property and duplicate, with bounded memory.
 * Cross-version fingerprints omit only derived Community/Process nodes/edges.
 *
 * One warmup pair is excluded. Acceptance looks after every seven measured
 * pairs, up to the pair cap: it passes once every interval sits within its
 * reviewed limit in baseline.json, fails once any interval sits beyond it, and
 * otherwise measures seven more. Each look uses an equal share of the 5% error,
 * so extra looks never loosen the gate. Still inconclusive at the cap fails.
 * Historical reference timings in baseline.json predate this isolated profile;
 * they are evidence, not portable wall-clock budgets. CI never rewrites them.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const script = fileURLToPath(import.meta.url);
const baselinePath = new URL('./baseline.json', import.meta.url);
const baselineBytes = await fs.readFile(baselinePath);
const benchmarkBaseline = JSON.parse(baselineBytes.toString('utf8'));
assert.equal(benchmarkBaseline.schemaVersion, 1, 'Unknown benchmark baseline');
const heapMiB = benchmarkBaseline.defaults.heapMiB;
const identity = {
  base: 'file-result-reuse-benchmark-v1',
  pdg: 'file-result-reuse-benchmark-pdg-v1',
};
function requireGcProfile() {
  if (typeof global.gc !== 'function' || !process.execArgv.includes('--predictable-gc-schedule'))
    throw new Error(
      'Measurements require --expose-gc and --predictable-gc-schedule; comparisons enable them automatically',
    );
}

async function main() {
  const { values } = parseArgs({
    options: {
      dist: { type: 'string' },
      corpus: { type: 'string' },
      files: { type: 'string' },
      workers: { type: 'string' },
      'baseline-dist': { type: 'string' },
      pairs: { type: 'string' },
      'max-pairs': { type: 'string' },
      output: { type: 'string' },
      check: { type: 'boolean' },
      prepare: { type: 'boolean' },
      phase: { type: 'string' },
      'trial-root': { type: 'string' },
    },
  });
  if (values.prepare) {
    assert(
      values['trial-root'] &&
        !values.phase &&
        !values['baseline-dist'] &&
        !values.check &&
        !values.output &&
        !values.pairs &&
        !values['max-pairs'],
      'Invalid preparation options',
    );
    await measure(values);
  } else if (values.phase) {
    assert(
      !values['baseline-dist'] &&
        !values.check &&
        !values.output &&
        !values.pairs &&
        !values['max-pairs'],
      'Invalid phase options',
    );
    await measurePhase(values);
  } else if (values['baseline-dist']) await compareRuntimes(values);
  else {
    assert(
      !values.check &&
        !values.pairs &&
        !values['max-pairs'] &&
        !values.output &&
        !values['trial-root'],
      'Comparison requires --baseline-dist',
    );
    await measure(values);
  }
}

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;

/** Keep full-graph reuse checks, but compare parser output across runtime versions. */
export function graphDigests(graph) {
  const nodes = [...graph.nodes];
  const derivedIds = new Set(
    nodes
      .filter((node) => node.label === 'Community' || node.label === 'Process')
      .map((node) => node.id),
  );
  const rows = [],
    parsedRows = [];
  let edges = 0,
    parsedEdges = 0;
  // Retain fixed-size hashes, not serialized source text. Whole-graph strings
  // (including join's copies) otherwise dominate the RSS we intend to measure.
  const rowDigest = (kind, value) =>
    createHash('sha256')
      .update(kind)
      .update(JSON.stringify(canonical(value)))
      .digest('hex');
  for (const node of nodes) {
    const row = rowDigest('N ', node);
    rows.push(row);
    if (!derivedIds.has(node.id)) parsedRows.push(row);
  }
  for (const edge of graph.relationships) {
    const row = rowDigest('R ', edge);
    rows.push(row);
    edges++;
    if (!derivedIds.has(edge.sourceId) && !derivedIds.has(edge.targetId)) {
      parsedRows.push(row);
      parsedEdges++;
    }
  }
  const digest = (values) => {
    const hash = createHash('sha256');
    for (const value of values.sort()) hash.update(value);
    return hash.digest('hex');
  };
  return {
    nodes: nodes.length,
    edges,
    digest: digest(rows),
    parsedNodes: nodes.length - derivedIds.size,
    parsedEdges,
    parsedDigest: digest(parsedRows),
  };
}

/** Bind each source path and byte length before adding its contents. */
export async function sourceDigest(directory, sources) {
  const hash = createHash('sha256');
  for (const file of sources) {
    const bytes = await fs.readFile(path.join(directory, file));
    hash.update(JSON.stringify([file, bytes.length])).update(bytes);
  }
  return hash.digest('hex');
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Two-sided Student-t critical value. With u = sqrt(df) * tan(angle), the mass
 * within +/-u is the integral of cos^(df-1) up to that angle over its integral
 * up to a right angle, so no gamma function or lookup table is needed.
 */
export function studentCritical(df, alpha) {
  assert(Number.isSafeInteger(df) && df > 0 && alpha > 0 && alpha < 1, 'Invalid Student-t request');
  const mass = (angle) => {
    const steps = 2000;
    const width = angle / steps;
    let sum = 1 + Math.cos(angle) ** (df - 1);
    for (let i = 1; i < steps; i++) sum += (i % 2 ? 4 : 2) * Math.cos(i * width) ** (df - 1);
    return (sum * width) / 3;
  };
  const target = (1 - alpha) * mass(Math.PI / 2);
  let low = 0,
    high = Math.PI / 2;
  for (let i = 0; i < 60; i++) {
    const middle = (low + high) / 2;
    if (mass(middle) < target) low = middle;
    else high = middle;
  }
  return Math.sqrt(df) * Math.tan((low + high) / 2);
}

/** Paired log-ratio intervals. Crossing 1 is unresolved, never equivalence. */
export function summarizePairs(pairs, alpha = 0.05) {
  assert(pairs.length > 0, 'At least one measured pair is required');
  const logs = pairs.map(({ baseline, candidate }) => {
    assert(
      Number.isFinite(baseline) && baseline > 0 && Number.isFinite(candidate) && candidate > 0,
    );
    return Math.log(candidate / baseline);
  });
  const average = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  let seed = 3598;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const samples = Array.from({ length: 10_000 }, () =>
    Math.exp(average(logs.map(() => logs[Math.floor(random() * logs.length)]))),
  ).sort((a, b) => a - b);
  const tail = Math.floor((samples.length * alpha) / 2);
  const bootstrap = [samples[tail], samples[samples.length - 1 - tail]];
  // Bootstrap alone understates uncertainty with few pairs. Enclose it in
  // the Student-t interval for the mean log ratio.
  const df = logs.length - 1;
  const mean = average(logs);
  const margin =
    df > 0
      ? studentCritical(df, alpha) *
        Math.sqrt(logs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / df / logs.length)
      : 0;
  const student = [Math.exp(mean - margin), Math.exp(mean + margin)];
  const interval = [Math.min(bootstrap[0], student[0]), Math.max(bootstrap[1], student[1])];
  return {
    pairs: pairs.length,
    baselineMedianMs: median(pairs.map((p) => p.baseline)),
    candidateMedianMs: median(pairs.map((p) => p.candidate)),
    geometricRatio: Math.exp(average(logs)),
    confidence: 1 - alpha,
    pairedBootstrap: bootstrap,
    pairedStudent: student,
    pairedInterval: interval,
    evidence:
      pairs.length < 7
        ? 'smoke-only'
        : interval[0] > 1
          ? 'regression'
          : interval[1] < 1
            ? 'no-detected-regression'
            : 'inconclusive',
  };
}

export const phases = ['cold', 'warm', 'edit', 'two-edits', 'repack'];
const digest = /^[a-f0-9]{64}$/;
const positive = (n) => Number.isFinite(n) && n > 0;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;

export function validatePair(pair) {
  const { baseline, candidate } = pair;
  assert(baseline?.provenance && candidate?.provenance, 'Missing provenance');
  for (const key of [
    'sourceDigest',
    'sourceFiles',
    'driverDigest',
    'node',
    'workers',
    'platform',
    'arch',
  ]) {
    assert.notEqual(baseline.provenance[key], undefined, `Missing ${key}`);
    assert.equal(candidate.provenance[key], baseline.provenance[key], `Mismatched ${key}`);
  }
  const files = baseline.provenance.sourceFiles;
  assert(integer(files) && files >= 2, 'Empty or undersized corpus');
  assert(
    integer(baseline.provenance.workers) && baseline.provenance.workers > 0,
    'Invalid workers',
  );
  for (const trial of [baseline, candidate]) {
    assert.equal(trial.provenance.phaseIsolation, 'process', 'Phases must use fresh processes');
    assert.deepEqual(
      trial.provenance.execArgv,
      ['--expose-gc', '--predictable-gc-schedule', '--max-old-space-size=' + heapMiB],
      'Unexpected measurement profile',
    );
    assert(
      ['sourceDigest', 'buildDigest', 'driverDigest'].every((key) =>
        digest.test(trial.provenance[key]),
      ),
      'Invalid digest',
    );
    assert(/^[a-f0-9]{40}$/.test(trial.provenance.runtimeHead), 'Missing runtime revision');
    assert.deepEqual(
      trial.measurements.map((row) => row.kind),
      phases,
      'Missing/duplicate phase',
    );
    const format = trial.measurements[0].cacheFormat;
    assert(['chunk', 'per-file'].includes(format), 'Unknown cache format');
    for (const row of trial.measurements) {
      for (const key of [
        'pipelineMs',
        'withSaveMs',
        'peakRssKb',
        'cacheBytes',
        'cacheFiles',
        'nodes',
        'edges',
        'parsedNodes',
        'parsedEdges',
      ]) {
        assert(positive(row[key]), `Invalid ${key}`);
      }
      assert(row.withSaveMs >= row.pipelineMs, 'Invalid publication timing');
      assert.equal(row.cacheFormat, format, 'Cache format changed within trial');
      assert(
        integer(row.reparsed) && integer(row.hits) && row.reparsed + row.hits === files,
        'Incomplete parsing',
      );
      assert.equal(row.workersStarted, row.reparsed > 0, 'Worker dispatch disagrees with reuse');
      assert(digest.test(row.digest), 'Missing graph digest');
      assert(digest.test(row.parsedDigest), 'Missing parsed graph digest');
    }
    assert.equal(trial.measurements[0].reparsed, files, 'Cold run must parse every file');
    assert.equal(trial.measurements[1].reparsed, 0, 'Warm run must reuse every file');
    assert.equal(trial.measurements[0].digest, trial.measurements[1].digest, 'Warm graph changed');
    assert.equal(
      trial.measurements[3].digest,
      trial.measurements[4].digest,
      'Repacking changed graph',
    );
    assert.notEqual(
      trial.measurements[1].parsedDigest,
      trial.measurements[2].parsedDigest,
      'Edit was not observed',
    );
    assert.notEqual(
      trial.measurements[2].parsedDigest,
      trial.measurements[3].parsedDigest,
      'Second edit was not observed',
    );
  }
  assert.equal(
    candidate.measurements[0].cacheFormat,
    'per-file',
    'Candidate did not use per-file reuse',
  );
  assert.deepEqual(
    candidate.measurements.map((row) => row.reparsed),
    [files, 0, 1, 2, 0],
    'Per-file reuse regressed',
  );
  for (let i = 0; i < phases.length; i++) {
    for (const key of ['parsedDigest', 'parsedNodes', 'parsedEdges']) {
      assert.equal(
        candidate.measurements[i][key],
        baseline.measurements[i][key],
        `Graph ${key} differs for ${phases[i]}`,
      );
    }
  }
}

/**
 * Decide at the latest planned look. `verdict` is 'continue' while the
 * evidence is inconclusive and pairs remain; the last look turns that into
 * 'fail'. Earlier looks are replayed, so a report that kept sampling after a
 * decision is rejected, and one that stopped early can never read as a pass.
 */
export function assessComparison(report) {
  assert.equal(report.schemaVersion, 6, 'Unknown report schema');
  const { stagePairs, maxPairs } = report.design ?? {};
  assert(
    Number.isSafeInteger(stagePairs) && stagePairs >= 7 && Number.isSafeInteger(maxPairs),
    'Seven measured process pairs are required per look',
  );
  const looks = Math.floor(maxPairs / stagePairs);
  const look = report.pairs.length / stagePairs;
  assert(Number.isSafeInteger(look) && look >= 1 && look <= looks, 'Pairs must end on a look');
  assert(report.warmup, 'Missing excluded warmup pair');
  const all = [report.warmup, ...report.pairs];
  for (const [index, pair] of all.entries()) {
    assert.equal(pair.iteration, index - 1, 'Duplicate or missing pair');
    assert.deepEqual(
      pair.order,
      index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'],
      'Pair order must alternate',
    );
    assert.deepEqual(
      pair.phaseOrder,
      phases.flatMap((phase) => pair.order.map((variant) => ({ phase, variant }))),
      'Matching phases must run consecutively',
    );
    validatePair(pair);
    assert(
      pair.baseline.provenance.sourceFiles >= 1024,
      'Acceptance corpus needs at least 1024 files',
    );
    for (const variant of ['baseline', 'candidate']) {
      assert.deepEqual(
        pair[variant].provenance,
        all[0][variant].provenance,
        'Runtime/corpus changed between trials',
      );
      assert.equal(
        pair[variant].measurements[0].cacheFormat,
        all[0][variant].measurements[0].cacheFormat,
        'Cache format changed between trials',
      );
    }
  }
  const improving = report.pairs[0].baseline.measurements[0].cacheFormat === 'chunk';
  const budgets = benchmarkBaseline.budgets;
  // Every look may accept or reject, so each gets an equal share of the 5%
  // error: the chance of a wrong decision across all looks stays within 5%.
  const alpha = 0.05 / looks;
  const assessLook = (pairs) => {
    const metric = (name, unit, select, limit, strict = false) => {
      const summary = summarizePairs(
        pairs.map((pair) => ({
          baseline: select(pair.baseline.measurements),
          candidate: select(pair.candidate.measurements),
        })),
        alpha,
      );
      const [lower, upper] = summary.pairedInterval;
      return {
        name,
        unit,
        limit,
        ...summary,
        passed: strict ? upper < limit : upper <= limit,
        regressed: lower > limit,
      };
    };
    const metrics = [
      metric(
        'repeated analyses',
        'ms',
        (rows) => rows.slice(1).reduce((sum, row) => sum + row.withSaveMs, 0),
        improving ? budgets.repeated : budgets.regression,
      ),
      metric(
        'peak process RSS',
        'KiB',
        (rows) => Math.max(...rows.map((row) => row.peakRssKb)),
        improving ? budgets.peakRss : budgets.regression,
        improving,
      ),
      ...phases.map((phase, i) =>
        metric(
          phase,
          'ms',
          (rows) => rows[i].withSaveMs,
          improving ? budgets.phase : budgets.regression,
        ),
      ),
      metric(
        'cold cache size',
        'bytes',
        (rows) => rows[0].cacheBytes,
        improving ? budgets.cacheBytes : budgets.regression,
      ),
    ];
    return {
      metrics,
      verdict: metrics.some((m) => m.regressed)
        ? 'fail'
        : metrics.every((m) => m.passed)
          ? 'pass'
          : 'continue',
    };
  };
  let result;
  for (let i = 1; i <= look; i++) {
    assert(!result || result.verdict === 'continue', 'Sampling continued past a decision');
    result = assessLook(report.pairs.slice(0, i * stagePairs));
  }
  const verdict = result.verdict === 'continue' && look === looks ? 'fail' : result.verdict;
  return {
    mode: improving ? 'require-improvement' : 'prevent-regression',
    look,
    looks,
    confidence: 1 - alpha,
    metrics: result.metrics,
    verdict,
    passed: verdict === 'pass',
  };
}

export async function compareRuntimes(options) {
  const count = Number(options.pairs ?? benchmarkBaseline.defaults.pairs);
  const workers = Number(options.workers ?? benchmarkBaseline.defaults.workers);
  const files = Number(options.files ?? benchmarkBaseline.defaults.files);
  assert(
    Number.isSafeInteger(count) && count >= (options.check ? 7 : 1) && count <= 30,
    'Invalid --pairs (acceptance needs at least seven)',
  );
  // Fewer than seven pairs is a smoke run: no acceptance, so no further looks.
  const maxPairs =
    count < 7
      ? count
      : Number(options['max-pairs'] ?? Math.max(count, benchmarkBaseline.defaults.maxPairs));
  assert(
    Number.isSafeInteger(maxPairs) && maxPairs >= count && maxPairs <= 90,
    'Invalid --max-pairs (must be at least --pairs)',
  );
  assert(Number.isSafeInteger(workers) && workers >= 1 && workers <= 16, 'Invalid --workers');
  assert(
    Number.isSafeInteger(files) && files >= (options.check ? 1024 : 2),
    'Invalid --files (acceptance needs at least 1024)',
  );
  assert(options.output, 'Comparison requires --output');
  const output = path.resolve(options.output);
  assert.notEqual(output, fileURLToPath(baselinePath), '--output must not overwrite baseline.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  const runtimes = {
    baseline: path.resolve(options['baseline-dist']),
    candidate: path.resolve(options.dist ?? 'dist'),
  };
  for (const dist of Object.values(runtimes)) await fs.access(path.join(dist, 'cli/index.js'));
  const report = {
    schemaVersion: 6,
    measuredAt: new Date().toISOString(),
    design: { stagePairs: count, maxPairs },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      workers,
    },
    runtimes,
    warmup: null,
    pairs: [],
    verdict: 'incomplete',
  };
  const save = () => fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  const run = async (variant, iteration, phase, root) => {
    const log = path.join(
      path.dirname(output),
      `${iteration < 0 ? 'warmup' : 'pair-' + iteration}-${variant}.log`,
    );
    const handle = await fs.open(log, phase ? 'a+' : 'w+');
    let outputText = '';
    try {
      const offset = (await handle.stat()).size;
      const args = [
        script,
        ...(phase ? ['--phase', phase] : ['--prepare']),
        '--trial-root',
        root,
        '--dist',
        runtimes[variant],
        '--files',
        String(files),
        '--workers',
        String(workers),
      ];
      if (!phase && options.corpus) args.push('--corpus', path.resolve(options.corpus));
      const child = spawn(
        process.execPath,
        ['--expose-gc', '--predictable-gc-schedule', '--max-old-space-size=' + heapMiB, ...args],
        {
          stdio: ['ignore', handle.fd, handle.fd],
          env: { ...process.env, GITNEXUS_MEMORY: 'off' },
        },
      );
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          code === 0
            ? resolve()
            : reject(new Error(`${variant} trial failed (${signal ?? code}); see ${log}`)),
        );
      });
      // Read the same log inode the child wrote, even if its path was replaced.
      for await (const chunk of handle.createReadStream({
        start: offset,
        autoClose: false,
        encoding: 'utf8',
      }))
        outputText += chunk;
    } finally {
      await handle.close();
    }
    const rows = outputText
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .filter((row) => row.kind === 'provenance' || phases.includes(row.kind));
    assert.equal(rows.length, 1, `Incomplete ${phase ?? 'preparation'}: ${log}`);
    assert.equal(rows[0].kind, phase ?? 'provenance', `Unexpected measurement: ${log}`);
    if (!phase) {
      assert.equal(
        rows[0].runtimeHead,
        execFileSync('git', ['-C', path.dirname(runtimes[variant]), 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        'Measured wrong runtime revision',
      );
      if (options.check)
        assert(rows[0].sourceFiles >= 1024, 'Acceptance corpus needs at least 1024 files');
    }
    return rows[0];
  };
  try {
    await save();
    for (let iteration = -1; report.verdict === 'incomplete'; iteration++) {
      const order = (iteration + 1) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      const pair = { iteration, order, phaseOrder: [] };
      if (iteration < 0) report.warmup = pair;
      else report.pairs.push(pair);
      const roots = {};
      try {
        for (const variant of order) {
          roots[variant] = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-file-reuse-bench-'));
          pair[variant] = {
            provenance: await run(variant, iteration, null, roots[variant]),
            measurements: [],
          };
        }
        // Match each phase before moving on. Whole-trial ordering separates
        // paired measurements by minutes of unrelated work and host drift.
        for (const phase of phases) {
          for (const variant of order) {
            console.log(
              `${iteration < 0 ? 'Warmup' : 'Pair ' + (iteration + 1) + ' of up to ' + maxPairs}: ${phase} ${variant}`,
            );
            pair[variant].measurements.push(await run(variant, iteration, phase, roots[variant]));
            pair.phaseOrder.push({ phase, variant });
            await save();
          }
        }
        validatePair(pair);
      } finally {
        await Promise.all(
          Object.values(roots).map((root) => fs.rm(root, { recursive: true, force: true })),
        );
      }
      if (report.pairs.length === 0 || report.pairs.length % count) continue;
      if (count < 7) report.verdict = 'smoke-only';
      else {
        report.assessment = assessComparison(report);
        const { look, looks, verdict } = report.assessment;
        console.log(`Look ${look}/${looks} after ${report.pairs.length} pairs: ${verdict}`);
        if (verdict !== 'continue') report.verdict = verdict;
      }
    }
    await save();
  } catch (error) {
    report.verdict = 'invalid';
    report.error = error.message;
    await save();
    throw error;
  } finally {
    const { metrics = [], mode = 'incomplete/smoke-only', ...decision } = report.assessment ?? {};
    const level = decision.confidence ? (100 * decision.confidence).toFixed(1) + '% ' : '';
    const summary =
      `## Per-file parse reuse: ${report.verdict}\n\nMode: ${mode}. One excluded warmup and ${report.pairs.length} measured, alternating pairs${decision.look ? ` (look ${decision.look} of ${decision.looks})` : ''}; every phase runs in a fresh process.\n\n| Metric | Unit | Base median | Candidate median | Paired ratio (${level}interval) | Limit | Pass |\n| --- | --- | ---: | ---: | --- | ---: | --- |\n` +
      metrics
        .map(
          (m) =>
            `| ${m.name} | ${m.unit} | ${m.baselineMedianMs.toFixed(1)} | ${m.candidateMedianMs.toFixed(1)} | ${m.pairedInterval.map((r) => r.toFixed(3)).join(' – ')} | ${m.limit} | ${m.passed} |`,
        )
        .join('\n') +
      `\n\nRepeated analyses sum warm, one edit, two edits, and repacking (including cache save). RSS is the maximum phase-process high-water mark, including parser worker threads; cache bytes are reported separately. Inconclusive evidence adds ${report.design.stagePairs} pairs per look up to ${report.design.maxPairs}; looks share the 5% error equally, and intervals still crossing a budget at the last look fail. Graph equality and exact per-file reuse are required.\n${report.error ? '\nError: ' + report.error + '\n' : ''}`;
    await fs.writeFile(output.replace(/\.json$/, '') + '.md', summary);
    console.log(summary);
  }
  if (options.check && report.verdict !== 'pass') process.exitCode = 1;
}

async function measure(values) {
  requireGcProfile();
  const args = new Map(Object.entries(values).map(([key, value]) => ['--' + key, value]));
  const dist = path.resolve(args.get('--dist') ?? 'dist');
  const count = Number(args.get('--files') ?? benchmarkBaseline.defaults.files),
    workers = Number(args.get('--workers') ?? benchmarkBaseline.defaults.workers);
  if (![count, workers].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new Error('Invalid files/workers');
  const root = values.prepare
    ? path.resolve(values['trial-root'])
    : await fs.mkdtemp(path.join(os.tmpdir(), 'gn-file-reuse-bench-'));
  const repo = path.join(root, 'repo');
  async function treeDigest(directory) {
    const hash = createHash('sha256');
    const files = (await fs.readdir(directory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
      .sort();
    for (const relative of files) {
      const file = path.join(directory, relative);
      const handle = await fs.open(file, 'r');
      try {
        if (!(await handle.stat()).isFile()) continue;
        const bytes = await handle.readFile();
        hash.update(JSON.stringify([relative, bytes.length])).update(bytes);
      } finally {
        await handle.close();
      }
    }
    return hash.digest('hex');
  }
  const runtimeHead = (() => {
    try {
      return execFileSync('git', ['-C', path.dirname(dist), 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return null;
    }
  })();
  try {
    await fs.mkdir(repo);
    const corpus = args.get('--corpus');
    if (corpus)
      await fs.cp(path.resolve(corpus), repo, {
        recursive: true,
        filter: (source) =>
          !['node_modules', '.git', '.gitnexus', 'dist'].includes(path.basename(source)),
      });
    else
      for (let i = 0; i < count; i++) {
        const name = `file${String(i).padStart(4, '0')}.ts`;
        const previous = `file${String(i - 1).padStart(4, '0')}`;
        await fs.writeFile(
          path.join(repo, name),
          (i ? `import { entry as prev } from './${previous}';\n` : '') +
            `export function entry(value: number): number { return ${i ? 'prev(value)' : 'value'} + ${i}; }\n` +
            Array.from(
              { length: 20 },
              (_, j) =>
                `export function helper${j}(value: number): number { return entry(value) + ${j}; }\n`,
            ).join(''),
        );
      }
    const sources = (await fs.readdir(repo, { recursive: true }))
      .filter((f) => /\.tsx?$/.test(f))
      .sort();
    console.log(
      JSON.stringify({
        kind: 'provenance',
        phaseIsolation: 'process',
        execArgv: process.execArgv,
        sourceDigest: await sourceDigest(repo, sources),
        sourceFiles: sources.length,
        node: process.version,
        workers,
        dist,
        cliDigest: createHash('sha256')
          .update(await fs.readFile(path.join(dist, 'cli/index.js')))
          .digest('hex'),
        buildDigest: await treeDigest(dist),
        driverDigest: createHash('sha256')
          .update(await fs.readFile(new URL(import.meta.url)))
          .update(baselineBytes)
          .digest('hex'),
        checkoutHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        runtimeHead,
        platform: process.platform,
        arch: process.arch,
      }),
    );
    if (values.prepare) return;
    for (const kind of phases) {
      // Preserve only the repository/cache between analyses. A fresh V8 isolate
      // prevents previous graphs, heap growth and JIT feedback affecting timing.
      const child = spawn(
        process.execPath,
        [
          ...process.execArgv,
          script,
          '--phase',
          kind,
          '--trial-root',
          root,
          '--dist',
          dist,
          '--workers',
          String(workers),
        ],
        {
          stdio: 'inherit',
          env: { ...process.env, GITNEXUS_MEMORY: 'off' },
        },
      );
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          code === 0
            ? resolve()
            : reject(new Error('Benchmark phase ' + kind + ' failed (' + (signal ?? code) + ')')),
        );
      });
    }
  } finally {
    if (!values.prepare) await fs.rm(root, { recursive: true, force: true });
  }
}

async function measurePhase(values) {
  const kind = values.phase;
  assert(phases.includes(kind), 'Invalid benchmark phase');
  assert(values['trial-root'], 'A phase requires --trial-root');
  requireGcProfile();
  const root = path.resolve(values['trial-root']);
  const repo = path.join(root, 'repo'),
    live = path.join(root, 'live');
  const dist = path.resolve(values.dist ?? 'dist');
  const workers = Number(values.workers ?? benchmarkBaseline.defaults.workers);
  assert(Number.isSafeInteger(workers) && workers >= 1 && workers <= 16, 'Invalid workers');
  if (kind === 'edit' || kind === 'two-edits') {
    const sources = (await fs.readdir(repo, { recursive: true }))
      .filter((f) => /\.tsx?$/.test(f))
      .sort();
    for (const file of sources.slice(0, kind === 'edit' ? 1 : 2)) {
      await fs.appendFile(
        path.join(repo, file),
        `\nexport function benchmarkAdded${kind === 'edit' ? 'One' : 'Two'}(value: number) { return value; }\n`,
      );
    }
  }
  const { runPipelineFromRepo } = await import(
    pathToFileURL(path.join(dist, 'core/ingestion/pipeline.js'))
  );
  const { emptyParseCache, loadParseCache, saveParseCache } = await import(
    pathToFileURL(path.join(dist, 'storage/parse-cache.js'))
  );
  const { mergeStagedDurableParsedFileStore } = await import(
    pathToFileURL(path.join(dist, 'storage/parsedfile-store.js'))
  );

  global.gc();
  const stage = path.join(root, kind);
  const cache =
    kind === 'cold'
      ? emptyParseCache(identity, { storagePath: live, writeStoragePath: stage })
      : await loadParseCache(live, identity, stage);
  const start = performance.now();
  const run = await runPipelineFromRepo(repo, () => {}, {
    workerPoolSize: workers,
    parseWorkerUrl: pathToFileURL(path.join(dist, 'core/ingestion/workers/parse-worker.js')),
    parseCache: cache,
    ...(kind === 'repack' ? { chunkByteBudget: 4096 } : {}),
  });
  const pipelineMs = performance.now() - start;
  const kept = await saveParseCache(live, cache);
  await mergeStagedDurableParsedFileStore(
    live,
    stage,
    identity.base,
    new Set(cache.fileResults ? [] : kept),
  );
  const withSaveMs = performance.now() - start;
  const fingerprints = graphDigests(run.graph);
  let cacheBytes = 0,
    cacheFiles = 0;
  for (const file of await fs.readdir(live, { recursive: true })) {
    const stat = await fs.stat(path.join(live, file));
    if (stat.isFile()) {
      cacheBytes += stat.size;
      cacheFiles++;
    }
  }
  console.log(
    JSON.stringify({
      kind,
      pipelineMs,
      withSaveMs,
      cacheBytes,
      cacheFiles,
      cacheFormat: cache.fileResults ? 'per-file' : 'chunk',
      peakRssKb: process.resourceUsage().maxRSS,
      reparsed: run.reparsedFileCount,
      hits: run.parseCacheHitFileCount,
      workersStarted: run.usedWorkerPool,
      ...fingerprints,
    }),
  );
  await fs.rm(stage, { recursive: true, force: true });
}
if (process.argv[1] && path.resolve(process.argv[1]) === script) await main();
