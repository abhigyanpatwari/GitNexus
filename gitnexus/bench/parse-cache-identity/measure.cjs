#!/usr/bin/env node
// Run after building both checkouts:
// node bench/parse-cache-identity/measure.cjs --baseline-root /path/to/baseline/gitnexus
// Optional: --samples 7 --output bench/parse-cache-identity/baseline.json
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');
const args = process.argv.slice(2);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const samples = Number(value('--samples', '7'));
if (!Number.isInteger(samples) || samples < 3 || samples > 100)
  throw new Error('--samples must be 3..100');
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samplesMs: values,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
};

async function fingerprint(root, source) {
  const tree = source ? 'src' : 'dist';
  const ext = source ? 'ts' : 'js';
  const { resolveParseCacheIdentity } = await import(
    pathToFileURL(path.join(root, tree, `core/parse-cache-identity.${ext}`))
  );
  const entry = pathToFileURL(path.join(root, tree, `core/run-analyze.${ext}`)).href;
  const values = [];
  let identity;
  for (let i = 0; i <= Math.max(samples, 40); i++) {
    const start = performance.now();
    const result = resolveParseCacheIdentity(entry);
    values.push(performance.now() - start);
    if (!result.ok) throw new Error(result.reason);
    identity = result.identity;
  }
  return { coldMs: values[0], warm: summary(values.slice(1)), identity };
}

async function analysis(root) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-bench-parse-identity-'));
  try {
    const repo = path.join(temp, 'repo');
    process.env.GITNEXUS_HOME = path.join(temp, 'home');
    process.env.GITNEXUS_SHARED_STORE = 'off';
    process.env.GITNEXUS_LBUG_BUFFER_POOL_SIZE = '134217728';
    process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
    process.env.GITNEXUS_MEMORY = 'off';
    await fs.mkdir(repo);
    await fs.writeFile(path.join(repo, '.gitignore'), '.gitnexus/\n');
    for (let i = 0; i < 64; i++)
      await fs.writeFile(
        path.join(repo, `module-${i}.ts`),
        `export function value${i}(input: number) { return input + ${i}; }\n`,
      );
    const git = (...argv) => execFileSync('git', argv, { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
    git('add', '-A');
    git(
      '-c',
      'user.name=benchmark',
      '-c',
      'user.email=benchmark@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture',
    );
    const { runFullAnalysis } = await import(
      pathToFileURL(path.join(root, 'dist/core/run-analyze.js'))
    );
    const run = (force) =>
      runFullAnalysis(
        repo,
        { force, skipAgentsMd: true, skipSkills: true, skipFts: true, workerPoolSize: 1 },
        { onProgress() {} },
      );
    const coldStart = performance.now();
    const cold = await run(false);
    const coldMs = performance.now() - coldStart;
    const fastPath = [],
      replay = [];
    for (let i = 0; i < samples; i++) {
      let start = performance.now();
      const fresh = await run(false);
      fastPath.push(performance.now() - start);
      if (!fresh.alreadyUpToDate)
        throw new Error('Unchanged fixture did not take freshness fast path');
      start = performance.now();
      const warm = await run(true);
      replay.push(performance.now() - start);
      if (
        warm.pipelineResult?.reparsedFileCount !== 0 ||
        warm.pipelineResult?.parseCacheHitFileCount !== 64
      )
        throw new Error('Benchmark did not replay all 64 cached files');
    }
    const freshCliFastPath = [];
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      const output = execFileSync(
        process.execPath,
        [
          path.join(root, 'dist/cli/index.js'),
          'analyze',
          repo,
          '--index-only',
          '--skip-fts',
          '--workers',
          '1',
        ],
        { cwd: repo, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      );
      freshCliFastPath.push(performance.now() - start);
      if (!output.includes('Already up to date'))
        throw new Error('Fresh CLI process did not take the unchanged-repository fast path');
    }
    return {
      fixture: { files: 64, language: 'TypeScript', workers: 1 },
      coldMs,
      parsedFiles: cold.pipelineResult?.reparsedFileCount,
      fastPath: summary(fastPath),
      replay: summary(replay),
      freshCliFastPath: summary(freshCliFastPath),
    };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

(async () => {
  if (args.includes('--child')) {
    const root = path.resolve(value('--root'));
    const result =
      value('--child') === 'analysis'
        ? await analysis(root)
        : await fingerprint(root, args.includes('--source'));
    console.log('BENCH_RESULT=' + JSON.stringify(result));
    return;
  }
  const candidate = path.resolve(__dirname, '../..');
  const baseline = value('--baseline-root');
  if (!baseline) throw new Error('Supply a built pre-change checkout with --baseline-root');
  const child = (mode, root, source = false) => {
    const stdout = execFileSync(
      process.execPath,
      [
        ...(source ? ['--import', path.join(candidate, 'node_modules/tsx/dist/loader.mjs')] : []),
        __filename,
        '--child',
        mode,
        '--root',
        path.resolve(root),
        '--samples',
        String(samples),
        ...(source ? ['--source'] : []),
      ],
      {
        encoding: 'utf8',
        timeout: 600_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GITNEXUS_MEMORY: 'off' },
      },
    );
    const line = stdout.split('\n').find((line) => line.startsWith('BENCH_RESULT='));
    if (!line) throw new Error('Benchmark child returned no measurements');
    return JSON.parse(line.slice('BENCH_RESULT='.length));
  };
  const result = {
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
    },
    baselineRevision: value('--baseline-revision', 'unspecified; supply --baseline-revision'),
    candidateRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: candidate,
      encoding: 'utf8',
    }).trim(),
    candidateDirty:
      execFileSync('git', ['status', '--porcelain'], { cwd: candidate, encoding: 'utf8' }).trim()
        .length > 0,
    identity: {
      distribution: child('identity', candidate),
      source: child('identity', candidate, true),
    },
    baseline: child('analysis', baseline),
    candidate: child('analysis', candidate),
  };
  result.budgets = {
    warmIdentityP95LimitMs: 50,
    warmIdentityPass: Object.values(result.identity).every((entry) => entry.warm.p95Ms <= 50),
    replayMedianLimitPercent: 5,
    replayMedianDeltaPercent:
      100 * (result.candidate.replay.medianMs / result.baseline.replay.medianMs - 1),
  };
  result.budgets.replayPass = result.budgets.replayMedianDeltaPercent <= 5;
  result.freshCliFastPathMedianDeltaPercent =
    100 *
    (result.candidate.freshCliFastPath.medianMs / result.baseline.freshCliFastPath.medianMs - 1);
  const json = JSON.stringify(result, null, 2) + '\n';
  if (value('--output')) await fs.writeFile(value('--output'), json);
  process.stdout.write(json);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
