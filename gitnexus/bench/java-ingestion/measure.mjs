#!/usr/bin/env node
/** Java provider correctness and bounded scaling. Build the selected runtime first. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const directory = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(directory, 'baseline.json');
const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    root: { type: 'string', default: path.resolve(directory, '../..') },
    output: { type: 'string' },
    check: { type: 'boolean' },
    record: { type: 'boolean' },
    observe: { type: 'boolean' },
    full: { type: 'boolean' },
    samples: { type: 'string' },
    'correctness-only': { type: 'boolean' },
    warmup: { type: 'string' },
    'pipeline-samples': { type: 'string' },
  },
});
if (values.help) {
  console.log(
    `Java ingestion correctness and scaling\n\nUsage: node bench/java-ingestion/measure.mjs [options]\n\n--root PATH         Built gitnexus package to measure (default current package)\n--output PATH       Write JSON to a new file; existing files are refused\n--observe           Record historical failures without certifying correctness\n--correctness-only  One capture/pipeline pass per shape; no timings or scaling claims\n--check             Check reviewed baseline fingerprints and ratio budgets\n--record            Explicitly record baseline only after all checks pass\n--full              Capture: 15 samples/2 warmups; pipeline: 3 samples/1 warmup\n--samples N         Override capture samples (default 5)\n--warmup N          Override capture warmups (default 1)\n--pipeline-samples N Override pipeline samples (default 2)\n--help              Print this help without loading a runtime or timing work`,
  );
  process.exit(0);
}
assert.ok(
  [values.check, values.record, values.observe].filter(Boolean).length <= 1,
  '--check, --record and --observe are mutually exclusive',
);
const positiveInt = (raw, fallback, minimum = 1) => {
  const number = raw === undefined ? fallback : Number(raw);
  assert.ok(Number.isSafeInteger(number) && number >= minimum, `invalid sample count: ${raw}`);
  return number;
};
const correctnessOnly = values['correctness-only'] === true;
assert.ok(
  !correctnessOnly || (!values.check && !values.record),
  '--correctness-only cannot check or record timing baselines',
);
assert.ok(
  !correctnessOnly ||
    (!values.full &&
      values.samples === undefined &&
      values.warmup === undefined &&
      values['pipeline-samples'] === undefined),
  '--correctness-only always executes each arm once; remove timing profile overrides',
);
const execution = {
  captureSamples: correctnessOnly ? 1 : positiveInt(values.samples, values.full ? 15 : 5),
  captureWarmup: correctnessOnly ? 0 : positiveInt(values.warmup, values.full ? 2 : 1, 0),
  pipelineSamples: correctnessOnly
    ? 1
    : positiveInt(values['pipeline-samples'], values.full ? 3 : 2),
  pipelineWarmup: correctnessOnly ? 0 : 1,
};
const profile = correctnessOnly
  ? { capturePasses: 1, pipelinePasses: 1, warmups: 0, timings: 'disabled' }
  : { ...execution, statistic: 'minimum', pipelineCache: 'cold on every pass' };
if (values.check || values.record) {
  assert.ok(
    execution.captureSamples >= 5 && execution.captureWarmup >= 1 && execution.pipelineSamples >= 2,
    'checking/recording requires at least 5 capture samples, 1 warmup and 2 pipeline samples',
  );
  assert.ok(!values.record || !process.env.CI, 'recording a reviewed baseline is disabled in CI');
}
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const shapeNames = ['small', 'large', 'dense'];
const dimensions = { small: [8, 8], large: [32, 8], dense: [32, 64] };
const defaultBudgets = {
  breadthCapturePerUnitGrowth: 2,
  breadthPipelinePerByteGrowth: 2,
  densityCapturePerFieldGrowth: 2,
  densityPipelinePerFieldGrowth: 2,
};
const expectedBaseline = values.check
  ? JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  : undefined;
let outputFd;
if (values.output) outputFd = fs.openSync(path.resolve(values.output), 'wx');
const report = {
  schemaVersion: 1,
  mode: correctnessOnly ? 'correctness-only' : 'measurement',
  complete: false,
  observed: Boolean(values.observe),
  profile,
  measured: {
    capture: 'production emitJavaScopeCaptures with pre-parsed cached trees; parsing excluded',
    pipeline:
      'scan, worker parse, cross-file, scope resolution, MRO and Spring DI; database writes, communities and processes excluded',
  },
  shapes: {},
  ...(correctnessOnly ? {} : { metrics: {} }),
  failures: [],
  runtimeErrors: [],
};
const checkpoint = () => {
  if (outputFd === undefined) return;
  fs.ftruncateSync(outputFd, 0);
  fs.writeSync(outputFd, JSON.stringify(report, null, 2) + '\n', 0, 'utf8');
};
const fail = (message) => {
  if (!report.failures.includes(message)) report.failures.push(message);
};
const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-ingestion-bench-'));
for (const name of ['home', 'tmp']) fs.mkdirSync(path.join(privateRoot, name));
process.env.GITNEXUS_HOME = path.join(privateRoot, 'home');
process.env.TMPDIR = path.join(privateRoot, 'tmp');
for (const name of ['GITNEXUS_STORAGE_PATH', 'GITNEXUS_STORAGE_ROOT', 'GITNEXUS_SHARED_STORE'])
  delete process.env[name];

// Fingerprint inputs must not depend on the runtime's default collation.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function workload(shape, input) {
  const files = Object.entries(input.files).sort(([a], [b]) => byCodeUnit(a, b));
  const stats = {
    ...input.stats,
    files: files.length,
    sourceBytes: files.reduce((total, [, source]) => total + Buffer.byteLength(source), 0),
    expectations: input.expectations.length,
    positiveCases: input.expectations.filter((item) => item.targetIds.length > 0).length,
    negativeCases: input.expectations.filter((item) => item.targetIds.length === 0).length,
  };
  for (const name of ['files', 'sourceBytes', 'expectations', 'positiveCases', 'negativeCases'])
    assert.equal(stats[name], input.stats[name], `independent corpus ${name} mismatch`);
  assert.equal(stats.units, dimensions[shape][0], `${shape}: unit workload changed`);
  assert.equal(
    stats.densityFieldsPerUnit,
    dimensions[shape][1],
    `${shape}: density workload changed`,
  );
  assert.ok(
    stats.units >= 1 && stats.files >= stats.units + 2 && stats.sourceBytes >= stats.units * 512,
    'corpus source workload floor not met',
  );
  assert.ok(
    stats.positiveCases >= stats.units * 4 && stats.negativeCases >= stats.units * 2,
    'positive/negative case workload floor not met',
  );
  const sources = new Set();
  for (const expectation of input.expectations) {
    assert.ok(['CALLS', 'INJECTS'].includes(expectation.relation));
    assert.equal(
      new Set(expectation.targetIds).size,
      expectation.targetIds.length,
      'duplicate expected target',
    );
    const identity = JSON.stringify([
      expectation.sourceId,
      expectation.relation,
      expectation.members ?? null,
    ]);
    assert.ok(!sources.has(identity), 'duplicate expectation');
    sources.add(identity);
  }
  return { stats, corpusFingerprint: hash([files, input.expectations, stats]) };
}

function captureSignature(groups) {
  const counts = {
    matches: 0,
    scopes: 0,
    typeBindings: 0,
    nameClaims: 0,
    lexicalNames: 0,
    syntheticMethodCandidates: 0,
  };
  for (const [, matches] of groups)
    for (const match of matches) {
      counts.matches++;
      if (
        ['@scope.module', '@scope.class', '@scope.function', '@scope.block'].some(
          (tag) => match[tag],
        )
      )
        counts.scopes++;
      if (match['@type-binding.name']) counts.typeBindings++;
      if (match['@declaration.method'] && match['@declaration.is-synthetic']?.text === 'true')
        counts.syntheticMethodCandidates++;
      counts.nameClaims += JSON.parse(match['@scope.name-claims']?.text ?? '[]').length;
      counts.lexicalNames += JSON.parse(match['@scope.lexical-names']?.text ?? '[]').length;
    }
  return { ...counts, fingerprint: hash(groups) };
}

function correctness(input, result) {
  const edges = [...result.graph.iterRelationships()];
  const bySource = new Map();
  for (const edge of edges) {
    const key = JSON.stringify([edge.sourceId, edge.type]);
    const bucket = bySource.get(key) ?? [];
    bucket.push(edge.targetId);
    bySource.set(key, bucket);
  }
  const rows = [];
  const errors = [];
  const features = {};
  let passedCases = 0;
  for (const expectation of input.expectations) {
    const all = bySource.get(JSON.stringify([expectation.sourceId, expectation.relation])) ?? [];
    const actual = [
      ...new Set(
        all.filter(
          (target) =>
            !expectation.members ||
            expectation.members.includes(result.graph.getNode(target)?.properties.name),
        ),
      ),
    ].sort();
    const wanted = [...expectation.targetIds].sort();
    const forbidden = (expectation.forbiddenTargetIds ?? []).filter((target) =>
      all.includes(target),
    );
    const sourceExists = result.graph.getNode(expectation.sourceId) !== undefined;
    const passed = sourceExists && isDeepStrictEqual(actual, wanted) && forbidden.length === 0;
    const feature = (features[expectation.feature ?? 'unspecified'] ??= { cases: 0, passed: 0 });
    feature.cases++;
    if (passed) feature.passed++;
    if (!sourceExists) errors.push(`missing source ${expectation.sourceId}`);
    if (!isDeepStrictEqual(actual, wanted) || forbidden.length)
      errors.push(
        JSON.stringify({
          id: expectation.id,
          feature: expectation.feature,
          sourceId: expectation.sourceId,
          relation: expectation.relation,
          expected: wanted,
          actual,
          forbidden,
        }),
      );
    else if (sourceExists) passedCases++;
    rows.push([expectation.sourceId, expectation.relation, expectation.members ?? null, actual]);
  }
  if (result.scopeExtractionFailures?.length || result.unavailableScopeLanguageFiles)
    errors.push('scope extraction was incomplete');
  const danglingEdges = edges.filter(
    (edge) => !result.graph.getNode(edge.sourceId) || !result.graph.getNode(edge.targetId),
  ).length;
  if (danglingEdges)
    errors.push(`${danglingEdges} graph relationships have missing endpoint identities`);
  const allNodes = [...result.graph.iterNodes()];
  const syntheticAccessorMethods = allNodes.filter(
    (node) => node.label === 'Method' && node.properties.synthetic === 'lombok',
  ).length;
  if (syntheticAccessorMethods !== input.stats.syntheticAccessorMethods)
    errors.push(
      `synthetic accessor workload: ${syntheticAccessorMethods} != ${input.stats.syntheticAccessorMethods}`,
    );
  const nodes = allNodes.map((node) => node.id).sort();
  const triples = edges
    .map((edge) => [edge.sourceId, edge.type, edge.targetId])
    .sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)));
  return {
    cases: rows.length,
    passedCases,
    nodes: nodes.length,
    edges: edges.length,
    danglingEdges,
    syntheticAccessorMethods,
    features,
    semanticFingerprint: hash(rows),
    graphFingerprint: hash([nodes, triples]),
    errors,
  };
}

/** Recording provenance for the committed baseline: digests, Node version/ABI,
 * platform/arch and the git head. Machine-specific locations (checkout root,
 * Node executable, dist, manifest and lockfile paths) are never persisted;
 * `--check` reads only `shapes` and `budgets`. */
function portableRuntime({ runnerIdentity, git }) {
  const { runtime, invokedArtifact, build, dependencyRuntime } = runnerIdentity;
  return {
    runnerIdentity: {
      schemaVersion: runnerIdentity.schemaVersion,
      runtime: {
        version: runtime.version,
        platform: runtime.platform,
        architecture: runtime.architecture,
        modulesAbi: runtime.modulesAbi,
        libc: runtime.libc,
      },
      cliVersion: runnerIdentity.cliVersion,
      invokedArtifact: { digest: invokedArtifact.digest },
      build: { kind: build.kind, canonicalization: build.canonicalization, digest: build.digest },
      dependencyRuntime: {
        canonicalization: dependencyRuntime.canonicalization,
        packageCount: dependencyRuntime.packageCount,
        artifactCount: dependencyRuntime.artifactCount,
        digest: dependencyRuntime.digest,
      },
    },
    git,
  };
}

function stable(shape, name, actual) {
  const previous = report.shapes[shape][name];
  if (previous === undefined) report.shapes[shape][name] = actual;
  else if (!isDeepStrictEqual(previous, actual))
    fail(`${shape}: ${name} changed between identical passes`);
}

try {
  const root = fs.realpathSync(path.resolve(values.root));
  const load = (relative) => import(pathToFileURL(path.join(root, 'dist', relative)).href);
  const identity = await load('core/analyzer-identity.js');
  const entry = pathToFileURL(path.join(root, 'dist/cli/index.js')).href;
  const identityOptions = { cacheDirectory: path.join(privateRoot, 'identity') };
  const runnerIdentity = identity.resolveAnalyzerRunnerIdentity(entry, identityOptions);
  let git;
  try {
    git = {
      head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      statusDigest: hash(
        execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=normal'], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        }),
      ),
    };
  } catch {
    git = { status: 'unavailable' };
  }
  report.runtime = { root, runnerIdentity, git };
  const [captureApi, query, resolverApi, pipeline, corpusApi] = await Promise.all([
    load('core/ingestion/languages/java/captures.js'),
    load('core/ingestion/languages/java/query.js'),
    load('core/ingestion/languages/java/scope-resolver.js'),
    load('core/ingestion/pipeline.js'),
    import('./corpus.mjs'),
  ]);
  const prepared = new Map();
  for (const shape of shapeNames) {
    const input = corpusApi.createJavaIngestionCorpus({ shape });
    const contract = workload(shape, input);
    report.shapes[shape] = {
      workload: contract.stats,
      corpusFingerprint: contract.corpusFingerprint,
      ...(correctnessOnly ? {} : { captureSamplesMs: [], pipelineSamplesMs: [] }),
    };
    const fixture = path.join(privateRoot, shape);
    const trees = [];
    let declaredFields = 0;
    for (const [file, content] of Object.entries(input.files).sort(([a], [b]) =>
      byCodeUnit(a, b),
    )) {
      assert.ok(
        !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'),
        'escaping fixture path',
      );
      const destination = path.join(fixture, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
      if (file.endsWith('.java')) {
        const tree = query.getJavaParser().parse(content);
        assert.ok(tree && !tree.rootNode.hasError, `${shape}/${file}: Java AST parse error`);
        for (const field of tree.rootNode.descendantsOfType('field_declaration'))
          declaredFields += field.namedChildren.filter(
            (child) => child.type === 'variable_declarator',
          ).length;
        trees.push({ file, content, tree });
      }
    }
    assert.equal(
      declaredFields,
      input.stats.declaredFields,
      `${shape}: independent AST field workload mismatch`,
    );
    prepared.set(shape, { input, fixture, trees });
  }
  // Rotate workloads by round to reduce a fixed small/large/dense ordering bias.
  for (const phase of ['capture', 'pipeline']) {
    const samples = phase === 'capture' ? execution.captureSamples : execution.pipelineSamples;
    const warmup = phase === 'capture' ? execution.captureWarmup : execution.pipelineWarmup;
    for (let round = 0; round < warmup + samples; round++) {
      for (let offset = 0; offset < shapeNames.length; offset++) {
        const shape = shapeNames[(round + offset) % shapeNames.length];
        const { input, fixture, trees } = prepared.get(shape);
        try {
          resolverApi.javaScopeResolver.loadResolutionConfig?.(fixture);
          if (phase === 'capture') {
            const start = correctnessOnly ? undefined : performance.now();
            const groups = trees.map(({ file, content, tree }) => [
              file,
              captureApi.emitJavaScopeCaptures(content, file, tree),
            ]);
            const elapsed = correctnessOnly ? undefined : performance.now() - start;
            const signature = captureSignature(groups);
            stable(shape, 'capture', signature);
            if (signature.typeBindings < input.stats.declaredFields)
              fail(`${shape}: declared-field capture floor not met`);
            if (
              signature.syntheticMethodCandidates !==
              input.stats.provisionalSyntheticAccessorMethods
            )
              fail(`${shape}: provisional synthetic-method capture workload mismatch`);
            if (signature.nameClaims < (input.stats.nameClaimsLowerBound ?? 1))
              fail(`${shape}: name-claim workload floor not met`);
            if (!correctnessOnly && round >= warmup)
              report.shapes[shape].captureSamplesMs.push(elapsed);
          } else {
            const store = fs.mkdtempSync(path.join(privateRoot, 'pass-'));
            try {
              const start = correctnessOnly ? undefined : performance.now();
              const result = await pipeline.runPipelineFromRepo(fixture, () => {}, {
                skipDerivedGraphPhases: true,
                workerPoolSize: 1,
                parseChunkConcurrency: 1,
                parsedFileStorePath: path.join(store, 'parsed-files'),
              });
              const elapsed = correctnessOnly ? undefined : performance.now() - start;
              const quality = correctness(input, result);
              stable(shape, 'quality', quality);
              for (const error of quality.errors) fail(`${shape}: ${error}`);
              if (
                !result.usedWorkerPool ||
                result.reparsedFileCount !== trees.length ||
                (result.parseCacheHitFileCount ?? 0) !== 0
              )
                fail(`${shape}: pipeline must cold-parse every Java fixture file`);
              if (result.communityResult || result.processResult)
                fail(`${shape}: excluded derived phases unexpectedly ran`);
              if (!correctnessOnly && round >= warmup)
                report.shapes[shape].pipelineSamplesMs.push(elapsed);
            } finally {
              fs.rmSync(store, { recursive: true, force: true });
            }
          }
        } catch (error) {
          report.runtimeErrors.push({
            shape,
            phase,
            round,
            message: error instanceof Error ? error.message : String(error),
          });
          if (!values.observe) throw error;
        }
        checkpoint();
      }
    }
  }
  if (!correctnessOnly)
    for (const shape of shapeNames) {
      const row = report.shapes[shape];
      row.captureMs = row.captureSamplesMs.length ? Math.min(...row.captureSamplesMs) : null;
      row.pipelineMs = row.pipelineSamplesMs.length ? Math.min(...row.pipelineSamplesMs) : null;
    }
  const growth = (a, b, cost, work) => {
    const first = report.shapes[a],
      last = report.shapes[b];
    return last[cost] / first[cost] / (work(last) / work(first));
  };
  if (!correctnessOnly)
    report.metrics = {
      breadthCapturePerUnitGrowth: growth(
        'small',
        'large',
        'captureMs',
        (row) => row.workload.units,
      ),
      breadthPipelinePerByteGrowth: growth(
        'small',
        'large',
        'pipelineMs',
        (row) => row.workload.sourceBytes,
      ),
      densityCapturePerFieldGrowth: growth(
        'large',
        'dense',
        'captureMs',
        (row) => row.workload.declaredFields,
      ),
      densityPipelinePerFieldGrowth: growth(
        'large',
        'dense',
        'pipelineMs',
        (row) => row.workload.declaredFields,
      ),
    };
  if (!correctnessOnly) report.workloadGrowth = {};
  if (!correctnessOnly)
    for (const [name, first, last] of [
      ['breadth', 'small', 'large'],
      ['density', 'large', 'dense'],
    ]) {
      const before = report.shapes[first],
        after = report.shapes[last];
      report.workloadGrowth[name] = {
        units: after.workload.units / before.workload.units,
        sourceBytes: after.workload.sourceBytes / before.workload.sourceBytes,
        declaredFields: after.workload.declaredFields / before.workload.declaredFields,
        captureMatches: after.capture?.matches / before.capture?.matches,
        nameClaims: after.capture?.nameClaims / before.capture?.nameClaims,
        lexicalNames: after.capture?.lexicalNames / before.capture?.lexicalNames,
      };
    }
  const contracts = Object.fromEntries(
    shapeNames.map((shape) => {
      const { workload, corpusFingerprint, capture, quality } = report.shapes[shape];
      return [shape, { workload, corpusFingerprint, capture, quality }];
    }),
  );
  const budgets = expectedBaseline?.budgets ?? defaultBudgets;
  if (!correctnessOnly)
    for (const [name, budget] of Object.entries(budgets))
      if (!Number.isFinite(report.metrics[name]) || report.metrics[name] > budget)
        fail(`${name}: ${report.metrics[name]} exceeds ${budget}`);
  if (expectedBaseline && !isDeepStrictEqual(contracts, expectedBaseline.shapes))
    fail('reviewed workload/capture/target fingerprint drift');
  identity.finalizeAnalyzerRunnerIdentity(entry, runnerIdentity, identityOptions);
  report.complete = true;
  report.scaling = correctnessOnly ? 'not measured' : 'ratio budgets checked';
  report.pass = report.failures.length === 0 && report.runtimeErrors.length === 0;
  if (!correctnessOnly) report.peakProcessRssBytes = process.resourceUsage().maxRSS * 1024;
  if (values.record) {
    assert.ok(report.pass, 'refusing to record a failing correctness or scaling run');
    let linked = false;
    try {
      linked = fs.lstatSync(baselinePath).isSymbolicLink();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    assert.ok(!linked, 'baseline symlink refused');
    // Write an exclusively created sibling, then rename it over the baseline:
    // rename replaces whatever leaf is there (even a symlink planted after the
    // check above) and never writes through it.
    const temporary = path.join(directory, `.baseline.${randomBytes(8).toString('hex')}.tmp`);
    const temporaryFd = fs.openSync(temporary, 'wx', 0o644);
    try {
      try {
        fs.writeFileSync(
          temporaryFd,
          JSON.stringify(
            {
              schemaVersion: 1,
              shapes: contracts,
              budgets,
              profile,
              recordedRuntime: portableRuntime(report.runtime),
            },
            null,
            2,
          ) + '\n',
        );
      } finally {
        fs.closeSync(temporaryFd);
      }
      fs.renameSync(temporary, baselinePath);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }
  if (!report.pass && !values.observe) process.exitCode = 1;
} catch (error) {
  report.pass = false;
  report.runtimeErrors.push({ message: error instanceof Error ? error.message : String(error) });
  if (!values.observe) process.exitCode = 1;
} finally {
  checkpoint();
  if (outputFd !== undefined) fs.closeSync(outputFd);
  fs.rmSync(privateRoot, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
