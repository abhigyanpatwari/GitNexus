#!/usr/bin/env node
/** Build first. Each sample measures real worker parsing, resolution and DB writes. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { evaluateScaling } from '../method-declaration-facts/scaling.mjs';

const script = fileURLToPath(import.meta.url);
const baselinePath = new URL('./baseline.json', import.meta.url);
const { values } = parseArgs({
  options: {
    check: { type: 'boolean' },
    record: { type: 'boolean' },
    root: { type: 'string', default: path.resolve(path.dirname(script), '../..') },
    sizes: { type: 'string', default: '128,512,2048' },
    samples: { type: 'string', default: '3' },
    output: { type: 'string' },
    child: { type: 'string' },
    size: { type: 'string' },
  },
});
const root = path.resolve(values.root);
const load = (name) => import(pathToFileURL(path.join(root, 'dist', name)));
const hash = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const marker = 'JAVA_OVERLOAD_BENCH=';
const shapes = ['spread', 'concentrated'];
const scenarios = ['cold', 'warm', 'changed'];
const metrics = ['wallMs', 'cpuMs', 'scopeWallMs', 'scopeCpuMs', 'heapBytes', 'peakRssBytes'];
const median = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];

async function runtimeFingerprint() {
  const digest = createHash('sha256');
  const dist = path.join(root, 'dist');
  for (const file of (await readdir(dist, { recursive: true }))
    .filter((file) => file.endsWith('.js'))
    .sort()) {
    digest.update(file.replaceAll(path.sep, '/')).update('\0');
    digest.update(await readFile(path.join(dist, file))).update('\0');
  }
  return digest.digest('hex');
}

function corpus(shape, size, changed = false) {
  const files = new Map([
    [
      'Product.java',
      `package bench;
public class Product {
  public void accept(Object value) {}
  public void accept(String value) {}
}
`,
    ],
  ]);
  const expected = [];
  const declarations = [];
  for (let i = 0; i < size; i++) {
    const owner = shape === 'spread' ? `Case${i}` : 'Cases';
    const file = `${owner}.java`;
    const suffix = shape === 'spread' ? '' : `_${i}`;
    const body = `
  String choose${suffix}(Object value) { return "object"; }
  String choose${suffix}(String value) { return "string"; }
  long widen${suffix}(long value) { return value; }
  long widen${suffix}(Integer value) { return 0; }
  Product make${suffix}(Object value) { return null; }
  Product make${suffix}(String value) { return null; }
  void run${suffix}() {
    choose${suffix}(${changed && i === 0 ? '(Object) ' : ''}"text");
    widen${suffix}(1);
    var product = make${suffix}("text");
    product.accept("text");
  }
`;
    if (shape === 'spread')
      files.set(
        file,
        `package clients.p${i}; import bench.Product; public class ${owner} {${body}}\n`,
      );
    else declarations.push(body);
    const caller = `Method:${file}:${owner}.run${suffix}#0`;
    for (const [name, type] of [
      ['choose', changed && i === 0 ? 'Object' : 'String'],
      ['widen', 'long'],
      ['make', 'String'],
    ])
      expected.push([caller, `Method:${file}:${owner}.${name}${suffix}#1~${type}`]);
    expected.push([caller, 'Method:Product.java:Product.accept#1~String']);
  }
  if (shape === 'concentrated')
    files.set('Cases.java', `package bench; public class Cases {${declarations.join('')}}\n`);
  return {
    files,
    expected: expected.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

async function sample(shape, size) {
  assert(shapes.includes(shape) && Number.isSafeInteger(size) && size > 0);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-java-overload-bench-'));
  const repo = path.join(directory, 'repo');
  const input = corpus(shape, size);
  Object.assign(process.env, {
    GITNEXUS_HOME: path.join(directory, 'home'),
    GITNEXUS_SHARED_STORE: 'off',
    GITNEXUS_MEMORY: 'off',
    GITNEXUS_LANG: 'en',
    GITNEXUS_LBUG_BUFFER_POOL_SIZE: '134217728',
    GITNEXUS_LBUG_EXTENSION_INSTALL: 'never',
    XDG_RUNTIME_DIR: path.join(directory, 'runtime'),
    GITNEXUS_MAX_FILE_SIZE: String(
      Math.ceil(
        Math.max(...[...input.files.values()].map((source) => Buffer.byteLength(source))) / 1024,
      ) + 1,
    ),
  });
  delete process.env.GITNEXUS_STORAGE_PATH;
  delete process.env.GITNEXUS_STORAGE_ROOT;
  await mkdir(repo);
  await mkdir(process.env.XDG_RUNTIME_DIR, { mode: 0o700 });
  const { runFullAnalysis } = await load('core/run-analyze.js');
  const { scopeResolutionPhase } = await load('core/ingestion/scope-resolution/pipeline/phase.js');
  const execute = scopeResolutionPhase.execute;
  let scopeWallMs = 0,
    scopeCpuMs = 0,
    scopeRuns = 0;
  scopeResolutionPhase.execute = async function (...args) {
    const cpu = process.cpuUsage(),
      start = performance.now();
    try {
      return await execute.apply(this, args);
    } finally {
      scopeWallMs += performance.now() - start;
      const used = process.cpuUsage(cpu);
      scopeCpuMs += (used.user + used.system) / 1000;
      scopeRuns++;
    }
  };
  try {
    for (const [file, source] of input.files) await writeFile(path.join(repo, file), source);
    const runs = [];
    for (const scenario of scenarios) {
      const fixture = scenario === 'changed' ? corpus(shape, size, true) : input;
      if (scenario === 'changed') {
        const edited = shape === 'spread' ? 'Case0.java' : 'Cases.java';
        await writeFile(path.join(repo, edited), fixture.files.get(edited));
      }
      global.gc();
      scopeWallMs = scopeCpuMs = scopeRuns = 0;
      const cpu = process.cpuUsage(),
        start = performance.now();
      const analysis = await runFullAnalysis(
        repo,
        {
          force: true,
          skipAgentsMd: true,
          skipSkills: true,
          skipFts: true,
          streamGraphEmit: false,
          workerPoolSize: 1,
          maxEntryPointCandidates: 7 * size + 2,
          maxProcesses: 7 * size + 2,
        },
        { onProgress: () => {} },
      );
      const wallMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      const heapBytes = process.memoryUsage().heapUsed;
      const peakRssBytes = process.resourceUsage().maxRSS * 1024;
      const pipeline = analysis.pipelineResult;
      assert(pipeline, 'Missing pipeline output');
      assert.equal(scopeRuns, 1, 'Every analysis must execute scope resolution');
      assert.deepEqual(pipeline.scopeExtractionFailures, []);
      assert.equal(pipeline.unavailableScopeLanguageFiles, 0);
      assert.equal(
        pipeline.processResult?.stats.truncation.truncated,
        false,
        'Process detection must cover the workload',
      );
      const calls = [...pipeline.graph.iterRelationshipsByType('CALLS')]
        .map((edge) => [edge.sourceId, edge.targetId])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      assert.equal(
        calls.length,
        fixture.expected.length,
        `${shape}/${size}/${scenario}: lost calls`,
      );
      assert.equal(
        hash(calls),
        hash(fixture.expected),
        `${shape}/${size}/${scenario}: incorrect overload targets`,
      );
      const methodCount = [...pipeline.graph.iterNodes()].filter(
        (node) => node.label === 'Method',
      ).length;
      assert.equal(methodCount, 7 * size + 2, 'Workload lost method declarations');
      const reparsed = pipeline.reparsedFileCount;
      if (scenario === 'cold') assert.equal(reparsed, input.files.size);
      else if (scenario === 'warm') assert.equal(reparsed, 0);
      else {
        // Cache entries contain chunks: editing one file can reparse its neighbors.
        assert(reparsed > 0, 'The edited source must reach parser workers');
        if (shape === 'spread')
          assert(reparsed < input.files.size, 'The edit must retain cache hits');
      }
      assert.equal(pipeline.parseCacheHitFileCount, input.files.size - reparsed);
      assert.equal(pipeline.usedWorkerPool, scenario !== 'warm');
      assert(
        !pipeline.resolutionOutcomes.some((outcome) => outcome.kind === 'suppressed'),
        'Unexpected suppressed calls',
      );
      runs.push({
        scenario,
        wallMs,
        cpuMs: (used.user + used.system) / 1000,
        scopeWallMs,
        scopeCpuMs,
        heapBytes,
        peakRssBytes,
        correctness: {
          files: input.files.size,
          methods: methodCount,
          calls: calls.length,
          fingerprint: hash(calls),
          reparsed,
          hits: pipeline.parseCacheHitFileCount,
        },
      });
    }
    return { shape, size, corpus: hash([...input.files]), runs };
  } finally {
    scopeResolutionPhase.execute = execute;
    await rm(directory, { recursive: true, force: true });
  }
}

async function measure() {
  assert(!(values.check && values.record), '--check cannot record a baseline');
  assert(!values.record || !process.env.CI, 'CI must not record baselines');
  assert(
    !values.output || path.resolve(values.output) !== fileURLToPath(baselinePath),
    '--output must not overwrite the baseline',
  );
  const sizes = values.sizes.split(',').map(Number),
    samples = Number(values.samples);
  assert(
    sizes.length >= 3 &&
      sizes.every((n, i) => Number.isSafeInteger(n) && n > 0 && (!i || n > sizes[i - 1])),
    'Supply at least three increasing positive sizes',
  );
  assert(
    Number.isSafeInteger(samples) && samples >= (values.check || values.record ? 3 : 1),
    'Checks and baseline recording require at least three samples',
  );
  // Refuse existing files (including symlinks), as in the other ingestion harness.
  if (values.output) await writeFile(values.output, '', { flag: 'wx' });
  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    runtimeSha256: await runtimeFingerprint(),
    workload: { sizes, shapes, scenarios, overloadsPerFamily: 2, callsPerUnit: 4, workers: 1 },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
    },
    samples: [],
    measured: [],
    scaling: {},
  };
  for (let repetition = 0; repetition < samples; repetition++) {
    for (const size of repetition % 2 ? [...sizes].reverse() : sizes) {
      for (const shape of repetition % 2 ? [...shapes].reverse() : shapes) {
        console.error(
          `java-overload-resolution: ${shape}/${size}, sample ${repetition + 1}/${samples}`,
        );
        const output = execFileSync(
          process.execPath,
          ['--expose-gc', script, '--child', shape, '--size', String(size), '--root', root],
          {
            encoding: 'utf8',
            timeout: 300_000,
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, GITNEXUS_MEMORY: 'off' },
          },
        );
        const result = output.split('\n').find((line) => line.startsWith(marker));
        assert(result, 'Child did not report measurements');
        report.samples.push(JSON.parse(result.slice(marker.length)));
        if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
      }
    }
  }
  for (const shape of shapes)
    for (const size of sizes) {
      const group = report.samples.filter((row) => row.shape === shape && row.size === size);
      assert.equal(group.length, samples);
      for (const scenario of scenarios) {
        const rows = group.map((row) => row.runs.find((run) => run.scenario === scenario));
        for (const row of rows) assert.deepEqual(row.correctness, rows[0].correctness);
        report.measured.push({
          shape,
          size,
          scenario,
          corpus: group[0].corpus,
          correctness: rows[0].correctness,
          ...Object.fromEntries(
            metrics.map((metric) => [metric, median(rows.map((row) => row[metric]))]),
          ),
        });
      }
    }
  assert.equal(
    await runtimeFingerprint(),
    report.runtimeSha256,
    'Built runtime changed during measurement',
  );
  for (const shape of shapes)
    for (const scenario of scenarios) {
      report.scaling[`${shape}/${scenario}`] = evaluateScaling(
        report.measured.filter((row) => row.shape === shape && row.scenario === scenario),
        metrics,
      );
    }
  if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ measured: report.measured, scaling: report.scaling }, null, 2));
  if (values.check || values.record) {
    assert(
      Object.values(report.scaling).every((row) => row.passed),
      'Time or memory growth exceeds the 1.5 normalized scaling budget',
    );
    const correctness = report.measured.map(({ shape, size, scenario, corpus, correctness }) => ({
      shape,
      size,
      scenario,
      corpus,
      correctness,
    }));
    if (values.check) {
      const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
      assert.equal(baseline.schemaVersion, report.schemaVersion);
      assert.deepEqual(report.workload, baseline.workload, 'Workload differs from baseline');
      assert.deepEqual(
        correctness,
        baseline.correctness,
        'Semantic or cache results differ from baseline',
      );
    } else {
      await writeFile(
        baselinePath,
        JSON.stringify(
          {
            _note:
              'Measured baseline. --check gates same-run normalized growth at 1.5 and exact call targets/cache counts. Absolute timings and memory are references, not portable budgets.',
            schemaVersion: report.schemaVersion,
            recordedAt: report.recordedAt,
            runtimeSha256: report.runtimeSha256,
            workload: report.workload,
            environment: report.environment,
            correctness,
            measured: report.measured,
            scaling: report.scaling,
          },
          null,
          2,
        ) + '\n',
      );
    }
    console.log(`[java-overload-resolution --${values.record ? 'record' : 'check'}] PASS`);
  }
}

if (values.child)
  console.log(marker + JSON.stringify(await sample(values.child, Number(values.size))));
else await measure();
