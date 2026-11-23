#!/usr/bin/env node
/** Measure exact TypeScript and JavaScript ingestion targets using a built GitNexus package. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { runBenchmarkTool } from '../lib/benchmark-tools.mjs';
import { compareCodeUnits, fingerprintIds } from '../lib/identity-guard.mjs';
import { addModuleFixtures, barrelEdit } from './module-fixtures.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    root: { type: 'string', default: path.resolve(directory, '../..') },
    check: { type: 'boolean' },
    observe: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(`Usage: node bench/typescript-ingestion/measure.mjs [--root PATH] [--check | --observe]
Build the selected GitNexus checkout first. The report includes exact receiver and
module targets, capture and cold-pipeline samples, and a durable parse-cache replay.
--check verifies the reviewed fingerprints and normalized growth budgets.
--observe reports historical target mismatches without failing on them.`);
  process.exit(0);
}
assert.ok(!(values.check && values.observe), '--check and --observe are mutually exclusive');

const runtime = path.resolve(values.root);
const runtimeUrl = (file) => pathToFileURL(path.join(runtime, 'dist', file)).href;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-ts-ingestion-'));
const mapCases = [
  [
    'ordinary',
    'for (const [key, value] of entries) { key.save(); value.save(); }',
    ['Key', 'Value'],
  ],
  ['elision', 'for (const [, /* omitted key */ value] of entries) value.save();', ['Value']],
  ['nested', 'for (const [{ pair: [a, b] }, value] of entries) value.save();', ['Value']],
  ['defaultKey', 'for (const [key = new Key(), value,] of entries) value.save();', ['Value']],
  ['asyncElision', 'for await (const [, value] of entries) value.save();', ['Value']],
  ['otherIterable', 'for (const [, value] of entries) value.save();', []],
];
const guardCases = [
  ['guarded', 'if (repo instanceof Key) repo.save();', ['Key.save']],
  ['afterGuard', 'if (repo instanceof Key) void repo; repo.save();', []],
  ['elseGuard', 'if (repo instanceof Key) void repo; else repo.save();', []],
  [
    'afterWrite',
    'if (repo instanceof Key) { repo.prepare(); repo = new Value(); repo.save(); }',
    ['Key.prepare'],
  ],
  [
    'shadowWrite',
    'if (repo instanceof Key) { { let repo: Value = new Value(); repo = new Value(); repo.save(); } repo.prepare(); }',
    ['Key.prepare', 'Value.save'],
  ],
];
const trackedMembers = new Set(['save', 'prepare']);
const shapes = [
  { name: 'small', modules: 8, batches: 2 },
  { name: 'wide', modules: 32, batches: 2 },
  { name: 'dense', modules: 32, batches: 8 },
];
const captureSamples = 5;
const pipelineSamples = 3;
const pipelineOptions = {
  skipDerivedGraphPhases: true,
  workerPoolSize: 1,
  parseChunkConcurrency: 1,
};

function makeFixture(shape, parsers) {
  const root = path.join(temporary, shape.name);
  fs.mkdirSync(root);
  const sources = new Map([
    [
      'owners.ts',
      'export class Key { kind = "key" as const; pair: [number, number] = [1, 2]; prepare() {} save() {} }\n' +
        'export class Value { kind = "value" as const; prepare() {} save() {} }\n',
    ],
  ]);
  const expected = new Map();
  const families = new Map();
  const expectTargets = (caller, family, targets) => {
    assert.ok(!expected.has(caller), `duplicate caller: ${caller}`);
    expected.set(caller, targets);
    families.set(caller, family);
  };
  for (let i = 0; i < shape.modules; i++) {
    const file = `cases${i}.ts`;
    const declarations = ["import { Key, Value } from './owners.js';"];
    for (let batch = 0; batch < shape.batches; batch++) {
      for (const [kind, body, owners] of mapCases) {
        const caller = `${kind}${batch}`;
        const iterable = kind === 'otherIterable' ? 'Iterable<[Key, Value]>' : 'Map<Key, Value>';
        const asyncPrefix = kind === 'asyncElision' ? 'async ' : '';
        declarations.push(
          `export ${asyncPrefix}function ${caller}(entries: ${iterable}) { ${body} }`,
        );
        expectTargets(
          `Function:${file}:${caller}`,
          'map',
          owners.map((owner) => `Method:owners.ts:${owner}.save#0`),
        );
      }
      for (const [kind, body, members] of guardCases) {
        const caller = `${kind}${batch}`;
        declarations.push(`export function ${caller}(repo: Key | Value) { ${body} }`);
        expectTargets(
          `Function:${file}:${caller}`,
          'instanceof',
          members.map((member) => `Method:owners.ts:${member}#0`),
        );
      }
    }
    sources.set(file, declarations.join('\n') + '\n');
  }
  addModuleFixtures(sources, expectTargets, shape.modules, shape.batches);
  const inputs = [];
  let sourceBytes = 0;
  let loops = 0;
  let guards = 0;
  for (const [file, source] of sources) {
    fs.writeFileSync(path.join(root, file), source);
    sourceBytes += Buffer.byteLength(source);
    const mode = file.endsWith('.ts') ? 'typescript' : 'javascript';
    const tree = parsers[mode].parse(source);
    assert.ok(
      tree && (!tree.rootNode.hasError || /^ts\d+-type(?:-namespace|s)\.ts$/.test(file)),
      `${file} must parse`,
    );
    loops += tree.rootNode.descendantsOfType('for_in_statement').length;
    guards += tree.rootNode.descendantsOfType('if_statement').length;
    inputs.push({ file, source, tree, mode });
  }
  assert.equal(loops, shape.modules * shape.batches * mapCases.length);
  assert.equal(guards, shape.modules * shape.batches * guardCases.length);
  return {
    root,
    inputs,
    expected,
    families,
    workload: {
      files: inputs.length,
      loops,
      guards,
      moduleCases: expected.size - loops - guards,
      cases: expected.size,
      sourceBytes,
      expectedEdges: [...expected.values()].flat().length,
      fingerprint: fingerprintIds([...sources, ...expected].map((row) => JSON.stringify(row))),
    },
  };
}

function inspectTargets(result, expected, families) {
  assert.deepEqual(result.scopeExtractionFailures ?? [], []);
  const actual = new Map();
  for (const edge of result.graph.iterRelationships()) {
    const source = result.graph.getNode(edge.sourceId);
    const target = result.graph.getNode(edge.targetId);
    assert.ok(source && target, `dangling ${edge.id}`);
    if (edge.type !== 'CALLS') continue;
    const family = families.get(edge.sourceId);
    const moduleCase = family === 'tsModules' || family === 'jsModules';
    if (family === undefined || (!moduleCase && !trackedMembers.has(target.properties.name)))
      continue;
    const targets = actual.get(edge.sourceId) ?? [];
    targets.push(edge.targetId);
    actual.set(edge.sourceId, targets);
  }
  const mismatches = [];
  const byFamily = {};
  for (const caller of new Set([...expected.keys(), ...actual.keys()])) {
    const observed = (actual.get(caller) ?? []).sort(compareCodeUnits);
    const wanted = [...(expected.get(caller) ?? [])].sort(compareCodeUnits);
    const family = families.get(caller);
    const counts = (byFamily[family] ??= {
      cases: 0,
      exact: 0,
      missingEdges: 0,
      unexpectedEdges: 0,
    });
    counts.cases++;
    counts.missingEdges += wanted.filter((target) => !observed.includes(target)).length;
    counts.unexpectedEdges += observed.filter((target) => !wanted.includes(target)).length;
    if (isDeepStrictEqual(observed, wanted)) counts.exact++;
    else mismatches.push({ caller, expected: wanted, observed });
  }
  return {
    fingerprint: fingerprintIds([...actual].map((row) => JSON.stringify(row))),
    resolvedEdges: [...actual.values()].flat().length,
    mismatchCount: mismatches.length,
    byFamily,
    examples: mismatches.slice(0, 4),
  };
}

function graphFingerprint(graph) {
  const nodes = [...graph.iterNodes()].map((node) => node.id);
  const edges = [...graph.iterRelationships()].map((edge) =>
    JSON.stringify([
      edge.id,
      edge.type,
      edge.sourceId,
      edge.targetId,
      edge.reason,
      edge.confidence,
    ]),
  );
  return fingerprintIds([...nodes, ...edges]);
}

function median(samples) {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

try {
  const [
    { emitTsScopeCaptures },
    { getTsParser },
    { emitJsScopeCaptures },
    { getJsParser },
    { runPipelineFromRepo },
    parseCache,
    parsedFileStore,
    { resolveParseCacheIdentity },
  ] = await Promise.all([
    import(runtimeUrl('core/ingestion/languages/typescript/captures.js')),
    import(runtimeUrl('core/ingestion/languages/typescript/query.js')),
    import(runtimeUrl('core/ingestion/languages/javascript/captures.js')),
    import(runtimeUrl('core/ingestion/languages/javascript/query.js')),
    import(runtimeUrl('core/ingestion/pipeline.js')),
    import(runtimeUrl('storage/parse-cache.js')),
    import(runtimeUrl('storage/parsedfile-store.js')),
    import(runtimeUrl('core/parse-cache-identity.js')),
  ]);
  const parsers = { typescript: getTsParser(), javascript: getJsParser('input.mjs') };
  const emitCaptures = { typescript: emitTsScopeCaptures, javascript: emitJsScopeCaptures };
  const fixtures = shapes.map((shape) => makeFixture(shape, parsers));
  const results = fixtures.map((fixture) => ({
    workload: fixture.workload,
    captureMs: [],
    pipelineMs: [],
  }));

  // Rotate shape order between rounds and keep fixture assembly and checks outside timers.
  for (let round = 0; round <= captureSamples; round++) {
    for (let offset = 0; offset < fixtures.length; offset++) {
      const index = (round + offset) % fixtures.length;
      const { inputs } = fixtures[index];
      const started = performance.now();
      const groups = inputs.map(({ source, file, tree, mode }) =>
        emitCaptures[mode](source, file, tree),
      );
      const elapsed = performance.now() - started;
      if (round > 0) results[index].captureMs.push(elapsed);
      if (round === captureSamples) {
        results[index].captureFingerprint = fingerprintIds(
          groups.map((matches, fileIndex) => JSON.stringify([inputs[fileIndex].file, matches])),
        );
        results[index].tupleBindings = groups
          .flat()
          .filter((match) => match['@type-binding.map-tuple-entry']).length;
        results[index].narrowingBindings = groups
          .flat()
          .filter((match) => match['@type-binding.instanceof-narrow']).length;
      }
    }
  }
  for (let round = 0; round <= pipelineSamples; round++) {
    for (let offset = 0; offset < fixtures.length; offset++) {
      const index = (round + offset) % fixtures.length;
      const { root, inputs, expected, families } = fixtures[index];
      const started = performance.now();
      const pipeline = await runPipelineFromRepo(root, () => {}, pipelineOptions);
      const elapsed = performance.now() - started;
      assert.equal(pipeline.reparsedFileCount, inputs.length);
      assert.equal(pipeline.usedWorkerPool, true);
      const quality = inspectTargets(pipeline, expected, families);
      if (round > 0) results[index].pipelineMs.push(elapsed);
      if (round === 0) {
        results[index].quality = quality;
        results[index].graphFingerprint = graphFingerprint(pipeline.graph);
      } else assert.deepEqual(quality, results[index].quality, 'repeated pipeline target drift');
    }
  }

  const storage = path.join(temporary, 'cache');
  fs.mkdirSync(storage);
  const identity = resolveParseCacheIdentity(runtimeUrl('core/run-analyze.js'));
  assert.ok(identity.ok, identity.reason);
  const cache = parseCache.emptyParseCache(identity.identity, {
    storagePath: storage,
    writeStoragePath: storage,
  });
  const replayFixture = fixtures[0];
  const cold = await runPipelineFromRepo(replayFixture.root, () => {}, {
    ...pipelineOptions,
    parseCache: cache,
  });
  const keys = await parseCache.saveParseCache(storage, cache);
  await parsedFileStore.mergeStagedDurableParsedFileStore(
    storage,
    storage,
    identity.identity.base,
    new Set(keys),
  );
  const restored = await parseCache.loadParseCache(storage, identity.identity, storage);
  const warm = await runPipelineFromRepo(replayFixture.root, () => {}, {
    ...pipelineOptions,
    parseCache: restored,
  });
  const replay = {
    coldParsed: cold.reparsedFileCount,
    warmParsed: warm.reparsedFileCount,
    cacheHits: warm.parseCacheHitFileCount,
  };
  assert.deepEqual(replay, {
    coldParsed: replayFixture.inputs.length,
    warmParsed: 0,
    cacheHits: replayFixture.inputs.length,
  });
  assert.equal(cold.usedWorkerPool, true);
  assert.equal(warm.usedWorkerPool, false);
  assert.equal(
    graphFingerprint(cold.graph),
    graphFingerprint(warm.graph),
    'warm graph differs from cold graph',
  );
  assert.deepEqual(
    inspectTargets(warm, replayFixture.expected, replayFixture.families),
    results[0].quality,
  );

  // Change a tuple position and a guard owner in one file, then reuse the other files.
  const changedFile = path.join(replayFixture.root, 'cases0.ts');
  const source = fs.readFileSync(changedFile, 'utf8');
  const edited = source
    .replace(mapCases[1][1], 'for (const [key] of entries) key.save();')
    .replace(guardCases[0][1], 'if (repo instanceof Value) repo.save();');
  assert.notEqual(edited, source);
  fs.writeFileSync(changedFile, edited);
  const barrelPath = path.join(replayFixture.root, barrelEdit.file);
  const barrel = fs.readFileSync(barrelPath, 'utf8');
  assert.ok(barrel.includes(barrelEdit.from));
  fs.writeFileSync(barrelPath, barrel.replace(barrelEdit.from, barrelEdit.to));
  const incremental = await runPipelineFromRepo(replayFixture.root, () => {}, {
    ...pipelineOptions,
    parseCache: await parseCache.loadParseCache(storage, identity.identity, storage),
  });
  const clean = await runPipelineFromRepo(replayFixture.root, () => {}, pipelineOptions);
  assert.equal(incremental.reparsedFileCount, 2);
  assert.equal(incremental.parseCacheHitFileCount, replayFixture.inputs.length - 2);
  assert.equal(graphFingerprint(incremental.graph), graphFingerprint(clean.graph));
  const editedTargets = [...incremental.graph.iterRelationships()]
    .filter(
      (edge) =>
        edge.type === 'CALLS' &&
        ['Function:cases0.ts:elision0', 'Function:cases0.ts:guarded0', barrelEdit.caller].includes(
          edge.sourceId,
        ),
    )
    .map((edge) => [edge.sourceId, edge.targetId])
    .sort((a, b) => compareCodeUnits(a[0], b[0]) || compareCodeUnits(a[1], b[1]));
  const expectedEdits = [
    ['Function:cases0.ts:elision0', 'Method:owners.ts:Key.save#0'],
    ['Function:cases0.ts:guarded0', 'Method:owners.ts:Value.save#0'],
    [barrelEdit.caller, barrelEdit.target],
  ];
  replay.editedTargets = editedTargets;
  replay.editedParsed = incremental.reparsedFileCount;
  replay.editedCacheHits = incremental.parseCacheHitFileCount;

  const growth = {};
  for (const [label, left, right] of [
    ['breadth', 0, 1],
    ['density', 1, 2],
  ]) {
    const before = results[left];
    const after = results[right];
    const caseGrowth = after.workload.cases / before.workload.cases;
    for (const [metric, samples] of [
      ['Capture', 'captureMs'],
      ['ColdPipeline', 'pipelineMs'],
    ]) {
      growth[`${label}${metric}PerCase`] =
        median(after[samples]) / median(before[samples]) / caseGrowth;
    }
  }
  const errors = results.flatMap((result, i) =>
    result.quality.mismatchCount > 0
      ? [`${shapes[i].name}: ${result.quality.mismatchCount} wrong or missing target sets`]
      : [],
  );
  if (!isDeepStrictEqual(editedTargets, expectedEdits)) errors.push('edited target mismatch');
  const contract = Object.fromEntries(
    results.map(
      (
        {
          workload,
          tupleBindings,
          narrowingBindings,
          quality,
          captureFingerprint,
          graphFingerprint,
        },
        i,
      ) => [
        shapes[i].name,
        {
          workload,
          tupleBindings,
          narrowingBindings,
          captureFingerprint,
          graphFingerprint,
          targetFingerprint: quality.fingerprint,
          resolvedEdges: quality.resolvedEdges,
        },
      ],
    ),
  );
  if (values.check) {
    const baseline = JSON.parse(fs.readFileSync(path.join(directory, 'baseline.json'), 'utf8'));
    assert.equal(baseline.version, 3);
    if (!isDeepStrictEqual(contract, baseline.shapes))
      errors.push('workload or target fingerprint drift');
    for (const [metric, ratio] of Object.entries(growth)) {
      const budget = baseline.budgets[metric];
      if (!Number.isFinite(budget) || !Number.isFinite(ratio) || ratio > budget)
        errors.push(`${metric}: ${ratio} exceeds ${budget}`);
    }
  }

  console.log(
    'TS_INGESTION_RESULT ' +
      JSON.stringify({
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        revision: runBenchmarkTool('git', ['-C', runtime, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        parseIdentity: identity.identity.base,
        peakRssKiB: process.resourceUsage().maxRSS,
        results: Object.fromEntries(results.map((result, i) => [shapes[i].name, result])),
        contract,
        growth,
        replay,
        errors,
      }),
  );
  if (errors.length > 0 && !values.observe) process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
