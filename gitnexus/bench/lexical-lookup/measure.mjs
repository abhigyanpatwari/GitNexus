// Build both runtimes, then run with Node:
// measure.mjs BASE_RUNTIME CANDIDATE_RUNTIME BASE_CORPUS CANDIDATE_CORPUS OUTPUT [fresh|persistent] [PAIRS]
// Corpus checkouts must be clean/disposable and at the same commit. OUTPUT must not exist.
// For gate evidence, set GITNEXUS_LEXICAL_BENCH_SCREEN=0; PAIRS defaults to 9.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
assert(
  args.length >= 5 && args.slice(0, 5).every((value) => value !== ''),
  'Expected BASE_RUNTIME CANDIDATE_RUNTIME BASE_CORPUS CANDIDATE_CORPUS OUTPUT [fresh|persistent]',
);
const [baselineRuntime, candidateRuntime, baseline, candidate, output] = args
  .slice(0, 5)
  .map((value) => path.resolve(value));
const lifecycle = args[5] ?? 'fresh';
const pairs = Number(args[6] ?? 9);
assert(Number.isSafeInteger(pairs) && pairs > 0, 'Pairs must be a positive integer');
const workers = Number(process.env.GITNEXUS_LEXICAL_BENCH_WORKERS ?? 16);
const heapMiB = Number(process.env.GITNEXUS_LEXICAL_BENCH_HEAP_MIB ?? 8192);
const screenSetting = process.env.GITNEXUS_LEXICAL_BENCH_SCREEN ?? '1';
const baseFirstSetting = process.env.GITNEXUS_LEXICAL_BENCH_BASE_FIRST ?? '1';
assert(Number.isSafeInteger(workers) && workers > 0, 'Workers must be a positive integer');
assert(Number.isSafeInteger(heapMiB) && heapMiB > 0, 'Heap MiB must be a positive integer');
assert(['0', '1'].includes(screenSetting), 'Screen must be 0 or 1');
assert(['0', '1'].includes(baseFirstSetting), 'Base first must be 0 or 1');
const screen = screenSetting === '1';
const baseFirst = baseFirstSetting === '1';
assert(
  ['fresh', 'persistent'].includes(lifecycle),
  `Lifecycle must be fresh or persistent; received ${JSON.stringify(lifecycle)}`,
);
assert.notEqual(baseline, candidate, 'BASE_CORPUS and CANDIDATE_CORPUS must differ');
const isWorker = process.env.GITNEXUS_LEXICAL_BENCH_WORKER === '1';
let runFullAnalysis, initLbug, executeQuery, closeLbug;
if (!isWorker) assert(!fs.existsSync(output), 'Output already exists');
const control = 'gitnexus/src/semantic-bench-control.ts';
const source =
  'export class SemanticBenchStore { save(): void {} load(): void {} }\nexport function semanticBenchUse(s: SemanticBenchStore) { s.save(); }\n';
const head = (repo) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(head(baseline), head(candidate));
for (const repo of isWorker ? [] : [baseline, candidate]) {
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }),
    '',
    'Checkout must be clean',
  );
  assert(!fs.existsSync(path.join(repo, control)));
}
fs.mkdirSync(output, { recursive: true });
process.env.GITNEXUS_HOME = path.join(output, 'home');
process.env.GITNEXUS_STORAGE_ROOT = path.join(output, 'indexes');
delete process.env.GITNEXUS_STORAGE_PATH;
process.env.GITNEXUS_SHARED_STORE = 'off';
process.env.PROF_SCOPE_RESOLUTION = '1';
const records = [];
if (isWorker) {
  const runtime = process.env.GITNEXUS_BENCH_RUNTIME;
  ({ runFullAnalysis } = await import(path.join(runtime, 'gitnexus/dist/core/run-analyze.js')));
  ({ initLbug, executeQuery, closeLbug } = await import(
    path.join(runtime, 'gitnexus/dist/core/lbug/lbug-adapter.js')
  ));
  const { configureLoggerSink } = await import(path.join(runtime, 'gitnexus/dist/core/logger.js'));
  configureLoggerSink({
    destination: {
      write(line) {
        try {
          records.push(JSON.parse(line));
        } catch {
          /* non-JSON diagnostic */
        }
        process.stderr.write(line);
      },
    },
  });
}
const results = [];
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
const digest = (rows) => {
  const hash = createHash('sha256');
  for (const row of rows.sort()) hash.update(row).update('\n');
  return { count: rows.length, sha256: hash.digest('hex') };
};

async function sample(repo, isCandidate, name) {
  process.env.GITNEXUS_EXPERIMENTAL_SEMANTIC_CACHE = '0';
  global.gc?.();
  records.length = 0;
  const logs = [];
  const progress = [];
  const loadBefore = os.loadavg();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const result = await runFullAnalysis(
    repo,
    {
      skipAgentsMd: true,
      skipSkills: true,
      workerPoolSize: workers,
      verbose: true,
    },
    {
      onProgress(phase, percent, message) {
        if (progress.at(-1)?.phase !== phase)
          progress.push({ ms: performance.now() - started, phase, percent, message });
      },
      onLog(message) {
        logs.push(message);
      },
    },
  );
  const ms = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  // Process-lifetime high-water mark captured before this sample's verification.
  // Earlier samples can set it; this is not an interval peak or a memory delta.
  const analysisPeakRssKiB = process.resourceUsage().maxRSS;
  assert(!result.alreadyUpToDate, 'A no-op is not an edit benchmark');
  assert(!result.graphWriteCollapsed);
  assert(!result.ftsSkipped, 'This benchmark includes FTS');
  const graph = result.pipelineResult.graph;
  const nodes = [],
    edges = [];
  for (const node of graph.iterNodes()) {
    // Derived clustering is stochastic; compare all source/semantic properties.
    if (['Community', 'Process', 'Folder'].includes(node.label)) continue;
    nodes.push(JSON.stringify(canonical(node)));
  }
  let controlCalls = 0;
  for (const edge of graph.iterRelationships()) {
    if (['MEMBER_OF', 'STEP_IN_PROCESS', 'CONTAINS'].includes(edge.type)) continue;
    edges.push(JSON.stringify(canonical(edge)));
    if (edge.type === 'CALLS' && edge.sourceId.includes('semanticBenchUse')) controlCalls++;
  }
  assert(controlCalls > 0, 'The changed call must resolve');
  const expectedTarget = fs.readFileSync(path.join(repo, control), 'utf8').includes('s.load()')
    ? 'load'
    : 'save';
  let persistedTargets;
  try {
    await initLbug(path.join(result.storagePath, 'lbug'), { skipFts: true });
    persistedTargets = await executeQuery(
      "MATCH (a:Function)-[r:CodeRelation]->(b:Method) WHERE a.name = 'semanticBenchUse' AND r.type = 'CALLS' RETURN b.name AS target",
    );
    assert.deepEqual(
      persistedTargets.map((row) => row.target),
      [expectedTarget],
      'Persisted call must follow the edit',
    );
  } finally {
    await closeLbug();
  }
  const report = {
    name,
    variant: isCandidate ? 'candidate' : 'baseline',
    ms,
    cpuMs: (cpu.user + cpu.system) / 1000,
    analysisPeakRssKiB,
    storagePath: result.storagePath,
    loadBefore,
    loadAfter: os.loadavg(),
    maxRssKiB: process.resourceUsage().maxRSS,
    stats: result.stats,
    incremental: result.incrementalStats,
    rebuildReasons: result.rebuildReasons,
    reparsedFiles: result.pipelineResult.reparsedFileCount,
    cachedFiles: result.pipelineResult.parseCacheHitFileCount,
    graph: { nodes: digest(nodes), edges: digest(edges) },
    logs,
    progress,
    persistedTargets,
    records: [...records],
  };
  console.log(
    'LEXICAL_BENCH ' +
      JSON.stringify({ name, ms, incremental: report.incremental, graph: report.graph }),
  );
  return report;
}

// Separate runtimes isolate implementation and JIT state. Fresh mode exits
// after every sample; persistent mode retains a process across real edits.
function worker(repo, isCandidate) {
  let child, pending, exited;
  const start = () => {
    child = fork(fileURLToPath(import.meta.url), process.argv.slice(2), {
      execArgv: [`--max-old-space-size=${heapMiB}`, '--expose-gc'],
      env: {
        ...process.env,
        GITNEXUS_LEXICAL_BENCH_WORKER: '1',
        GITNEXUS_BENCH_RUNTIME: isCandidate ? candidateRuntime : baselineRuntime,
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    exited = new Promise((resolve) => child.once('exit', resolve));
    child.on('message', (message) => {
      const current = pending;
      pending = undefined;
      if (message.error) current?.reject(new Error(message.error));
      else current?.resolve(message.report);
    });
    child.on('error', (error) => pending?.reject(error));
    child.on('exit', (code) => pending?.reject(new Error(`Benchmark worker exited: ${code}`)));
  };
  const close = async () => {
    if (!child) return;
    if (child.connected) child.disconnect();
    const code = await exited;
    child = undefined;
    assert.equal(code, 0, 'Worker must exit normally after analysis');
  };
  return {
    async run(name) {
      assert(!pending, 'Samples must run serially');
      if (!child) start();
      const report = await new Promise((resolve, reject) => {
        pending = { resolve, reject };
        child.send({ repo, reuse: isCandidate, name });
      });
      results.push(report);
      fs.writeFileSync(
        path.join(output, 'results.json'),
        JSON.stringify(
          {
            head: head(repo),
            node: process.version,
            lifecycle,
            pairs,
            workers,
            heapMiB,
            screen,
            baseFirst,
            baselineRuntime,
            candidateRuntime,
            results,
          },
          null,
          2,
        ),
      );
      if (lifecycle === 'fresh') await close();
      return report;
    },
    close,
  };
}

if (isWorker) {
  process.on('message', async ({ repo, reuse: isCandidate, name }) => {
    try {
      process.send({ report: await sample(repo, isCandidate, name) });
    } catch (error) {
      process.send({ error: error.stack ?? String(error) });
    }
  });
} else {
  const beforeWorker = worker(baseline, false);
  const afterWorker = worker(candidate, true);
  try {
    for (const repo of [baseline, candidate]) {
      fs.mkdirSync(path.dirname(path.join(repo, control)), { recursive: true });
      fs.writeFileSync(path.join(repo, control), source);
    }
    let beforeSeed, afterSeed;
    if (baseFirst) {
      beforeSeed = await beforeWorker.run('baseline-seed');
      afterSeed = await afterWorker.run('candidate-seed');
    } else {
      afterSeed = await afterWorker.run('candidate-seed');
      beforeSeed = await beforeWorker.run('baseline-seed');
    }
    assert.deepEqual(afterSeed.graph, beforeSeed.graph, 'Seed semantic graphs differ');
    for (let pair = 1; pair <= pairs; pair++) {
      const text = pair % 2 ? source.replace('s.save()', 's.load()') : source;
      for (const repo of [baseline, candidate]) fs.writeFileSync(path.join(repo, control), text);
      // Alternate ordering to reduce warm-up/load bias. Both indexes see a real edit.
      let before, after;
      if (Boolean(pair % 2) === baseFirst) {
        before = await beforeWorker.run(`baseline-${pair}`);
        after = await afterWorker.run(`candidate-${pair}`);
      } else {
        after = await afterWorker.run(`candidate-${pair}`);
        before = await beforeWorker.run(`baseline-${pair}`);
      }
      assert.deepEqual(
        after.graph,
        before.graph,
        'Semantic graph differs from a full semantic pass',
      );
      for (const entry of [before, after]) {
        assert.equal(entry.incremental?.writeMode, 'incremental');
        assert.equal(entry.incremental?.changedFiles, 1);
        assert.deepEqual(entry.rebuildReasons, []);
      }
      if (screen && pair === 1 && after.ms >= before.ms) {
        console.log('SCREEN REJECTED: no end-to-end improvement; stopping after one pair.');
        break;
      }
    }
  } finally {
    const closed = await Promise.allSettled([beforeWorker.close(), afterWorker.close()]);
    for (const repo of [baseline, candidate]) fs.rmSync(path.join(repo, control), { force: true });
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
}
