/** Whole-command paired measurements. Run --help; never treats a smoke run as acceptance. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const SCENARIOS = [
  'graph-only',
  'noop',
  'incremental',
  'http-fresh',
  'http-cached',
  'http-resume',
  'local-fresh',
  'local-cached',
];
const sha = (text) => createHash('sha256').update(text).digest('hex');

async function runtimeEnvironment(cli) {
  const describeFile = async (file) => {
    const resolved = await fs.realpath(file);
    const [stat, filesystem] = await Promise.all([
      fs.stat(resolved, { bigint: true }),
      fs.statfs(resolved, { bigint: true }),
    ]);
    return { path: resolved, device: String(stat.dev), filesystem: String(filesystem.type) };
  };
  const nativeEntry = createRequire(cli).resolve('@ladybugdb/core');
  return {
    cli: await describeFile(cli),
    nativeEntry: await describeFile(nativeEntry),
    nativeEntryDigest: sha(await fs.readFile(nativeEntry)),
    lockDigest: sha(await fs.readFile(path.resolve(path.dirname(cli), '../../package-lock.json'))),
  };
}

export function assertComparableRuntimes(baseline, candidate, allowDependencyChanges = false) {
  for (const component of ['cli', 'nativeEntry']) {
    assert.equal(
      candidate[component].device,
      baseline[component].device,
      `${component} runtime files are on different devices; stage both checkouts on the same filesystem`,
    );
    assert.equal(
      candidate[component].filesystem,
      baseline[component].filesystem,
      `${component} runtime files are on different filesystem types`,
    );
  }
  if (!allowDependencyChanges) {
    assert.equal(candidate.lockDigest, baseline.lockDigest, 'Dependency lockfiles differ');
    assert.equal(
      candidate.nativeEntryDigest,
      baseline.nativeEntryDigest,
      'Native runtime entry bytes differ',
    );
  }
}

export function assertCompletedCase(scenario, metadata, beforeMetadata) {
  assert(
    !metadata.incrementalInProgress && !metadata.graphWriteCollapsed,
    'Graph was not finalized',
  );
  assert(
    Number.isSafeInteger(metadata.stats?.nodes) && metadata.stats.nodes > 0,
    'Missing graph node count',
  );
  if (scenario === 'noop') {
    assert(beforeMetadata?.indexedAt, 'No-op setup lacks a freshness receipt');
    assert.equal(metadata.indexedAt, beforeMetadata.indexedAt, 'No-op changed graph freshness');
  }
  if (scenario.startsWith('http-') || scenario.startsWith('local-')) {
    assert(metadata.stats.embeddings > 0, 'Embedding scenario produced no vectors');
    assert(
      !metadata.embeddingCheckpoint && !metadata.embeddingJob,
      'Embedding work remains pending',
    );
  }
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Paired log-ratio intervals. Crossing 1 is unresolved, never equivalence. */
export function summarizePairs(pairs) {
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
  const bootstrap = [samples[250], samples[9749]];
  // Bootstrap alone understates uncertainty with seven pairs. Enclose it in
  // the Student-t interval for the mean log ratio; round df down in this table.
  const df = logs.length - 1;
  const critical = [
    [1, 12.707],
    [2, 4.303],
    [3, 3.183],
    [4, 2.777],
    [5, 2.571],
    [6, 2.447],
    [7, 2.365],
    [8, 2.307],
    [9, 2.263],
    [10, 2.229],
    [15, 2.132],
    [20, 2.086],
    [30, 2.043],
  ]
    .filter(([degree]) => degree <= df)
    .at(-1)?.[1];
  const mean = average(logs);
  const margin =
    df > 0
      ? critical * Math.sqrt(logs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / df / logs.length)
      : 0;
  const student = [Math.exp(mean - margin), Math.exp(mean + margin)];
  const interval = [Math.min(bootstrap[0], student[0]), Math.max(bootstrap[1], student[1])];
  return {
    pairs: pairs.length,
    baselineMedianMs: median(pairs.map((p) => p.baseline)),
    candidateMedianMs: median(pairs.map((p) => p.candidate)),
    geometricRatio: Math.exp(average(logs)),
    pairedBootstrap95: bootstrap,
    pairedStudent95: student,
    paired95: interval,
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

/** Detect slowdowns against a contemporaneous base, never historical wall-clock timings. */
export function checkPerformance(summaries, baseline) {
  assert.equal(baseline.schemaVersion, 1, 'Unsupported benchmark baseline');
  assert.equal(baseline.maxPairedRatio, 1, 'The gate must not allow a performance regression');
  const scenarios = Object.keys(baseline.scenarios);
  assert(scenarios.length > 0, 'Missing baseline scenarios');
  const failedScenarios = [];
  const inconclusiveScenarios = [];
  for (const scenario of scenarios) {
    const summary = summaries[scenario];
    assert(summary && summary.pairs >= 7, `Missing seven measured pairs for ${scenario}`);
    const interval = summary.paired95;
    assert(
      Array.isArray(interval) &&
        interval.length === 2 &&
        interval.every((value) => Number.isFinite(value) && value > 0) &&
        interval[0] <= interval[1],
      `Invalid paired interval for ${scenario}`,
    );
    if (interval[0] > baseline.maxPairedRatio) failedScenarios.push(scenario);
    else if (interval[1] >= baseline.maxPairedRatio) inconclusiveScenarios.push(scenario);
  }
  return { failedScenarios, inconclusiveScenarios };
}

/** Sample Linux process RSS once per process, including descendants, never per thread. */
async function sampleTree(pid) {
  if (process.platform !== 'linux') return undefined;
  const pending = [pid];
  const seen = new Set();
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    try {
      const [status, children] = await Promise.all([
        fs.readFile(`/proc/${current}/status`, 'utf8'),
        fs.readFile(`/proc/${current}/task/${current}/children`, 'utf8'),
      ]);
      bytes += Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0) * 1024;
      pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  return bytes;
}

export async function measureProcess(command, args, { cwd, env, logFile, sampleMs = 25 }) {
  const log = await fs.open(logFile, 'wx');
  let timer;
  let polling;
  let samplingError;
  let peakRssBytes = process.platform === 'linux' ? 0 : null;
  let samples = 0;
  const start = performance.now();
  try {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', log.fd, log.fd] });
    const poll = () => {
      if (!polling && child.pid) {
        polling = sampleTree(child.pid)
          .then((rss) => {
            if (rss !== undefined) {
              peakRssBytes = Math.max(peakRssBytes, rss);
              samples++;
            }
          })
          .catch((error) => {
            samplingError ??= error.message;
          })
          .finally(() => {
            polling = undefined;
          });
      }
    };
    poll();
    timer = setInterval(poll, sampleMs);
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    const elapsedMs = performance.now() - start;
    clearInterval(timer);
    await polling;
    return {
      ...outcome,
      elapsedMs,
      sampledPeakProcessTreeRssBytes: samplingError ? null : peakRssBytes,
      rssSamples: samples,
      rssSampleIntervalMs: sampleMs,
      samplingError,
      logFile,
    };
  } finally {
    clearInterval(timer);
    await polling;
    await log.close();
  }
}

export async function startProvider(dimensions = 256) {
  let active;
  const server = createServer(async (req, res) => {
    const counters = active;
    try {
      assert(counters && req.method === 'POST', 'Unexpected provider request');
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        assert(size <= 8 * 1024 * 1024, 'Benchmark request exceeds 8 MiB');
        chunks.push(chunk);
      }
      const { input } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert(
        Array.isArray(input) && input.length && input.every((text) => typeof text === 'string'),
      );
      counters.requests++;
      counters.requestBytes += size;
      if (counters.acceptedInputs + input.length > counters.failAfter) {
        counters.rejectedRequests++;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Deterministic interrupted-run fixture' } }));
        return;
      }
      const data = input.map((text, index) => {
        const hash = createHash('sha256').update(text).digest();
        counters.inputs.add(hash.toString('hex'));
        counters.acceptedInputs++;
        // Same text produces exactly the same nonzero vector in either implementation.
        const embedding = Array.from({ length: dimensions }, (_, i) => (hash[i % 32] + 1) / 256);
        return { object: 'embedding', index, embedding };
      });
      const body = JSON.stringify({ object: 'list', data, model: 'gitnexus-benchmark' });
      counters.responseBytes += Buffer.byteLength(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    } catch (error) {
      if (counters) counters.error ??= error.message;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    begin(failAfter = Infinity) {
      active = {
        failAfter,
        requests: 0,
        rejectedRequests: 0,
        acceptedInputs: 0,
        requestBytes: 0,
        responseBytes: 0,
        inputs: new Set(),
      };
      return active;
    },
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function moduleText(moduleIndex, modules, functions, revision = 0) {
  const previous = (moduleIndex + modules - 1) % modules;
  const lines = [`import { task_${previous}_0 } from './module-${previous}.js';`];
  for (let i = 0; i < functions; i++) {
    const dependency = i ? `task_${moduleIndex}_${i - 1}` : `task_${previous}_0`;
    lines.push(`/** Compute deterministic module ${moduleIndex}, operation ${i}. */`);
    lines.push(`export function task_${moduleIndex}_${i}(value: number): number {`);
    lines.push(`  if (value <= 0) return ${i + (moduleIndex === 0 && i === 0 ? revision : 0)};`);
    lines.push(`  return ${dependency}(value - 1) + ${i + 1};`, '}');
  }
  return lines.join('\n') + '\n';
}

async function fixture(directory, modules, functions) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  for (let i = 0; i < modules; i++) {
    await fs.writeFile(path.join(directory, `module-${i}.ts`), moduleText(i, modules, functions));
  }
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: directory,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      },
    });
  git('init', '-q');
  git('config', 'user.name', 'GitNexus benchmark');
  git('config', 'user.email', 'benchmark@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const hooks = path.join(directory, '.git', 'empty-hooks');
  await fs.mkdir(hooks);
  git('config', 'core.hooksPath', hooks);
  git('add', '.');
  git('commit', '-qm', 'fixture');
  return git;
}

function providerSnapshot(counters) {
  return {
    requests: counters.requests,
    rejectedRequests: counters.rejectedRequests,
    acceptedInputs: counters.acceptedInputs,
    uniqueInputs: counters.inputs.size,
    uniqueInputFingerprint: sha([...counters.inputs].sort().join('\n')),
    requestBytes: counters.requestBytes,
    responseBytes: counters.responseBytes,
    error: counters.error,
  };
}

async function runCase({
  cli,
  scenario,
  directory,
  modules,
  functions,
  heapMb,
  workers,
  defaultResources,
  cpuProfile,
  provider,
  sampleMs,
  stopRequested,
}) {
  const repo = path.join(directory, 'repo');
  const store = path.join(directory, 'store');
  const git = await fixture(repo, modules, functions);
  const env = { ...process.env };
  // Isolate GitNexus configuration/registry/credentials; never read a user's real config.
  for (const key of Object.keys(env)) if (key.startsWith('GITNEXUS_')) delete env[key];
  delete env.NODE_OPTIONS;
  Object.assign(env, {
    GITNEXUS_HOME: path.join(directory, 'home'),
    GITNEXUS_STORAGE_PATH: store,
    GITNEXUS_SHARED_STORE: 'off',
    GITNEXUS_WORKER_READY_TIMEOUT_MS: '30000',
  });
  if (!defaultResources) env.GITNEXUS_LBUG_BUFFER_POOL_SIZE = String(256 * 1024 * 1024);
  const http = scenario.startsWith('http-');
  const embedding = http || scenario.startsWith('local-');
  if (http)
    Object.assign(env, {
      GITNEXUS_EMBEDDING_URL: provider.url,
      GITNEXUS_EMBEDDING_MODEL: 'gitnexus-benchmark',
      GITNEXUS_EMBEDDING_DIMS: '256',
      GITNEXUS_EMBEDDING_API_KEY: 'benchmark-only',
      GITNEXUS_EMBEDDING_MAX_ATTEMPTS: '1',
      GITNEXUS_EMBEDDING_SUB_BATCH_SIZE: '16',
    });
  const args = [
    ...(cpuProfile ? ['--cpu-prof', `--cpu-prof-dir=${directory}`] : []),
    cli,
    'analyze',
    repo,
    '--index-only',
  ];
  if (!defaultResources) args.push('--memory-budget', String(heapMb), '--workers', String(workers));
  if (embedding) args.push('--embeddings', '0');
  const counters = provider.begin(
    scenario === 'http-resume' ? Math.max(16, Math.floor((modules * functions) / 3)) : Infinity,
  );
  const invoke = async (name, allowFailure = false) => {
    assert(
      !stopRequested(),
      'Benchmark interrupted between invocations; native children were not signalled',
    );
    const result = await measureProcess(process.execPath, args, {
      cwd: repo,
      env,
      logFile: path.join(directory, `${name}.log`),
      sampleMs,
    });
    if (!allowFailure)
      assert.equal(result.exitCode, 0, `Analyze failed; inspect ${result.logFile}`);
    assert(!result.signal, `Analyze ended with ${result.signal}; inspect ${result.logFile}`);
    assert(!counters.error, counters.error);
    return result;
  };
  let setup;
  if (['noop', 'incremental', 'http-cached', 'http-resume', 'local-cached'].includes(scenario)) {
    setup = await invoke('setup', scenario === 'http-resume');
    if (scenario === 'http-resume') {
      assert(
        counters.rejectedRequests > 0 && counters.acceptedInputs > 0,
        'Resume setup must actually interrupt partially successful work',
      );
      counters.failAfter = Infinity;
    }
    if (scenario === 'incremental') {
      await fs.writeFile(path.join(repo, 'module-0.ts'), moduleText(0, modules, functions, 1));
      git('add', 'module-0.ts');
      git('commit', '-qm', 'one-function edit');
    }
  }
  const beforeMetadata =
    setup && scenario !== 'http-resume'
      ? JSON.parse(await fs.readFile(path.join(store, 'gitnexus.json'), 'utf8'))
      : undefined;
  const before = providerSnapshot(counters);
  const measurement = await invoke('measured');
  const after = providerSnapshot(counters);
  if (scenario === 'http-cached')
    assert.equal(after.acceptedInputs, before.acceptedInputs, 'Cached run made paid requests');
  const metadata = JSON.parse(await fs.readFile(path.join(store, 'gitnexus.json'), 'utf8'));
  assertCompletedCase(scenario, metadata, beforeMetadata);
  const stats = metadata.stats;
  const result = {
    ...measurement,
    setup,
    command: [process.execPath, ...args],
    providerBefore: before,
    providerAfter: after,
    measuredProviderRequests: after.requests - before.requests,
    measuredProviderInputs: after.acceptedInputs - before.acceptedInputs,
    equalWork: {
      files: stats.files,
      nodes: stats.nodes,
      edges: stats.edges,
      embeddings: stats.embeddings ?? 0,
      uniqueInputs: after.uniqueInputs,
      inputFingerprint: after.uniqueInputFingerprint,
    },
    metadata: {
      runnerIdentity: metadata.runnerIdentity,
      graphGeneration: metadata.graphGeneration,
      vectorGeneration: metadata.vectorGeneration,
      embeddingCheckpoint: metadata.embeddingCheckpoint,
      embeddingJob: metadata.embeddingJob,
    },
  };
  await fs.writeFile(
    path.join(directory, 'measurement.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const baseline = JSON.parse(
    await fs.readFile(new URL('./baseline.json', import.meta.url), 'utf8'),
  );
  const { values: v } = parseArgs({
    args: argv,
    options: {
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      output: { type: 'string' },
      scenarios: { type: 'string', default: Object.keys(baseline.scenarios).join(',') },
      pairs: { type: 'string', default: '7' },
      warmups: { type: 'string', default: '1' },
      modules: { type: 'string', default: '64' },
      functions: { type: 'string', default: '16' },
      'heap-mb': { type: 'string', default: '2048' },
      workers: { type: 'string', default: '2' },
      'default-resources': { type: 'boolean', default: false },
      'cpu-profile': { type: 'boolean', default: false },
      'allow-dependency-changes': { type: 'boolean', default: false },
      'sample-ms': { type: 'string', default: '25' },
      'keep-stores': { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      'validate-gate': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  assert(
    !(v.check && v['cpu-profile']),
    'CPU profiles are diagnostic runs, not acceptance timings',
  );
  if (v['validate-gate']) {
    const fixture = { schemaVersion: 1, maxPairedRatio: 1, scenarios: { case: {} } };
    const summary = (ratios) =>
      summarizePairs(ratios.map((candidate) => ({ baseline: 1, candidate })));
    assert.deepEqual(checkPerformance({ case: summary(Array(7).fill(1.1)) }, fixture), {
      failedScenarios: ['case'],
      inconclusiveScenarios: [],
    });
    assert.deepEqual(checkPerformance({ case: summary(Array(7).fill(0.9)) }, fixture), {
      failedScenarios: [],
      inconclusiveScenarios: [],
    });
    const mixed = summary([0.8, 0.9, 0.95, 1, 1.05, 1.1, 1.2]);
    assert.deepEqual(checkPerformance({ case: mixed }, fixture), {
      failedScenarios: [],
      inconclusiveScenarios: ['case'],
    });
    assert(mixed.paired95[0] <= mixed.pairedBootstrap95[0]);
    assert(mixed.paired95[1] >= mixed.pairedBootstrap95[1]);
    assert.throws(() => checkPerformance({ case: summary([1, 1]) }, fixture));
    assert.throws(() => summarizePairs([{ baseline: 0, candidate: 1 }]));
    const runtime = {
      cli: { device: '1', filesystem: '1' },
      nativeEntry: { device: '1', filesystem: '1' },
      lockDigest: 'a',
      nativeEntryDigest: 'a',
    };
    const changed = { ...runtime, lockDigest: 'b', nativeEntryDigest: 'b' };
    assert.throws(() => assertComparableRuntimes(runtime, changed));
    assertComparableRuntimes(runtime, changed, true);
    assert.throws(() =>
      assertComparableRuntimes(
        runtime,
        { ...changed, cli: { device: '2', filesystem: '1' } },
        true,
      ),
    );
    console.log('Paired gate decision checks passed');
    return;
  }
  if (v.help) {
    console.log(`Usage: node bench/analyze-resume/measure.mjs --baseline /repo/gitnexus/dist/cli/index.js --output /tmp/results.json
  --candidate PATH       Defaults to this checkout's built CLI
  --scenarios LIST       ${SCENARIOS.join(',')}
  --pairs 7 --warmups 1   Alternating paired invocations; fewer than seven pairs is smoke-only
  --modules 64 --functions 16 --heap-mb 2048 --workers 2 --sample-ms 25
  --default-resources   Omit heap, worker and native-pool overrides on both sides
  --cpu-profile         Retain per-process/thread CPU profiles; incompatible with --check
  --allow-dependency-changes Compare shipped runtimes, including intentional dependency changes
  --validate-gate       Check decision logic without running benchmarks
  --check               Require the baseline corpus/scenarios and reject detected slowdowns
  --keep-stores          Retain owned index/home artifacts (logs and measurements always retained)
Includes full CLI startup, graph/manifest/native writes and final index work.
HTTP resume requires at least 17 functions to interrupt work after a successful 16-input batch.
It uses a deterministic provider outage, not an unsafe native-process kill.
RSS is sampled Linux process-family RSS; other platforms report it unavailable.
Local scenarios use the installed default model; prewarm its download before timing.
Live-query latency and platform cases remain separate acceptance requirements.`);
    return;
  }
  assert(v.baseline && v.output, '--baseline and --output are required');
  const numbers = {};
  for (const key of [
    'pairs',
    'warmups',
    'modules',
    'functions',
    'heap-mb',
    'workers',
    'sample-ms',
  ]) {
    numbers[key] = Number(v[key]);
    assert(
      Number.isSafeInteger(numbers[key]) && numbers[key] >= (key === 'warmups' ? 0 : 1),
      `Invalid --${key}`,
    );
  }
  assert(numbers.modules >= 2, '--modules must be at least 2');
  const scenarios = v.scenarios.split(',');
  assert(
    scenarios.length &&
      new Set(scenarios).size === scenarios.length &&
      scenarios.every((x) => SCENARIOS.includes(x)),
    'Invalid or repeated scenario',
  );
  assert(
    !scenarios.includes('http-resume') || numbers.modules * numbers.functions > 16,
    'http-resume requires --modules × --functions > 16 for a successful batch before the outage',
  );
  if (v.check) {
    assert(numbers.pairs >= 7 && numbers.warmups >= 1, '--check requires seven pairs and a warmup');
    for (const key of ['modules', 'functions'])
      assert.equal(numbers[key], baseline.settings[key], `--check requires baseline ${key}`);
    assert(
      Object.keys(baseline.scenarios).every((scenario) => scenarios.includes(scenario)),
      '--check requires all baseline scenarios',
    );
    assert.equal(baseline.maxPairedRatio, 1, 'The gate must not allow a performance regression');
  }
  const candidate =
    v.candidate ?? fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
  const clis = { baseline: path.resolve(v.baseline), candidate: path.resolve(candidate) };
  for (const cli of Object.values(clis)) await fs.access(cli);
  const runtime = {
    baseline: await runtimeEnvironment(clis.baseline),
    candidate: await runtimeEnvironment(clis.candidate),
  };
  assertComparableRuntimes(runtime.baseline, runtime.candidate, v['allow-dependency-changes']);
  const output = path.resolve(v.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  // Never overwrite a prior result; evidence files and temporary directories are exclusively owned.
  const resultFile = await fs.open(output, 'wx');
  const work = await fs.mkdtemp(path.join(path.dirname(output), 'analyze-pairs-'));
  const provider = await startProvider();
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    console.error(
      'Stopping between invocations; waiting for the active native CLI to exit normally.',
    );
  };
  process.on('SIGINT', interrupt);
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    work,
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpu: os.cpus()[0]?.model,
      availableParallelism: os.availableParallelism(),
      totalMemory: os.totalmem(),
      settings: numbers,
      resourceProfile: v['default-resources'] ? 'default' : 'explicit-heap-workers-pool',
      cpuProfile: v['cpu-profile'],
      comparison: v['allow-dependency-changes'] ? 'shipped-runtimes' : 'identical-dependencies',
      runtime,
      clis: {},
    },
    limitations: [
      'Synthetic corpus only; stats and deterministic input coverage are checked, not query ranking.',
      'Linux RSS sampling is a lower-bound observation, not a hard memory limit or exact peak.',
      'Disk, phase timings, native reservations and queue peaks are not collected; optional CPU profiles are diagnostic only.',
      'Only the selected scenarios and resource profile were measured; live query latency and Windows require additional validation.',
    ],
    acceptance: 'incomplete',
    samples: [],
    summaries: {},
  };
  const save = async () => {
    const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
    await resultFile.write(bytes, 0, bytes.length, 0);
    await resultFile.truncate(bytes.length);
    await resultFile.sync();
  };
  try {
    for (const [side, cli] of Object.entries(clis)) {
      report.environment.clis[side] = {
        path: cli,
        entryDigest: sha(await fs.readFile(cli)),
        commit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: path.dirname(cli),
          encoding: 'utf8',
        }).trim(),
      };
    }
    await save();
    for (const scenario of scenarios) {
      const pairs = [];
      for (let iteration = -numbers.warmups; iteration < numbers.pairs; iteration++) {
        const ordinal = iteration + numbers.warmups;
        const order = ordinal % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
        const pair = { scenario, iteration, warmup: iteration < 0, order };
        report.samples.push(pair);
        for (const side of order) {
          assert(
            !interrupted,
            'Benchmark interrupted between invocations; partial evidence retained',
          );
          const directory = path.join(work, `${scenario}-${ordinal}-${side}`);
          pair[side] = await runCase({
            cli: clis[side],
            scenario,
            directory,
            modules: numbers.modules,
            functions: numbers.functions,
            heapMb: numbers['heap-mb'],
            workers: numbers.workers,
            defaultResources: v['default-resources'],
            cpuProfile: v['cpu-profile'],
            sampleMs: numbers['sample-ms'],
            provider,
            stopRequested: () => interrupted,
          });
          await save();
          console.log(
            JSON.stringify({
              scenario,
              iteration,
              side,
              elapsedMs: pair[side].elapsedMs,
              requests: pair[side].measuredProviderRequests,
              rss: pair[side].sampledPeakProcessTreeRssBytes,
            }),
          );
          if (!v['keep-stores']) {
            // Only paths created inside this invocation's mkdtemp root are removed.
            await fs.rm(path.join(directory, 'store'), { recursive: true, force: true });
            await fs.rm(path.join(directory, 'home'), { recursive: true, force: true });
          }
        }
        assert.deepEqual(
          pair.candidate.equalWork,
          pair.baseline.equalWork,
          `Unequal work for ${scenario}; inspect retained measurements`,
        );
        if (scenario === 'http-resume') {
          assert.equal(
            pair.candidate.providerAfter.acceptedInputs,
            pair.candidate.providerAfter.uniqueInputs,
            'Resume replayed already accepted embedding inputs',
          );
          assert.equal(
            pair.candidate.measuredProviderInputs,
            pair.candidate.providerAfter.uniqueInputs -
              pair.candidate.providerBefore.acceptedInputs,
            'Resume must request only unfinished embedding inputs',
          );
        }
        const baselineDependencies =
          pair.baseline.metadata.runnerIdentity?.dependencyRuntime?.digest;
        assert(
          /^sha256:[a-f0-9]{64}$/.test(baselineDependencies ?? ''),
          'Baseline dependency receipt missing',
        );
        const candidateDependencies =
          pair.candidate.metadata.runnerIdentity?.dependencyRuntime?.digest;
        assert(
          /^sha256:[a-f0-9]{64}$/.test(candidateDependencies ?? ''),
          'Candidate dependency receipt missing',
        );
        pair.dependenciesMatch = candidateDependencies === baselineDependencies;
        if (!v['allow-dependency-changes'])
          assert(
            pair.dependenciesMatch,
            'Resolved dependency payloads differ; use --allow-dependency-changes to compare shipped runtimes',
          );
        if (iteration >= 0)
          pairs.push({ baseline: pair.baseline.elapsedMs, candidate: pair.candidate.elapsedMs });
      }
      report.summaries[scenario] = summarizePairs(pairs);
      await save();
    }
    if (v.check) {
      report.check = checkPerformance(report.summaries, baseline);
      await save();
      assert.equal(
        report.check.failedScenarios.length,
        0,
        `Performance regression: ${report.check.failedScenarios.join(', ')}; inspect ${output}`,
      );
      if (report.check.inconclusiveScenarios.length)
        console.warn(
          `Inconclusive timings: ${report.check.inconclusiveScenarios.join(', ')}; not proof of equal performance.`,
        );
    }
    console.log(
      JSON.stringify(
        { output, summaries: report.summaries, check: report.check, acceptance: report.acceptance },
        null,
        2,
      ),
    );
  } catch (error) {
    report.error = error.message;
    await save();
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    await provider.close();
    await resultFile.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
