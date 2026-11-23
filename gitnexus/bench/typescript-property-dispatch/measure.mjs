#!/usr/bin/env node
/** Measure property-dispatch expansion independently of TypeScript ingestion fixes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runBenchmarkTool } from '../lib/benchmark-tools.mjs';
import { compareCodeUnits, fingerprintIds } from '../lib/identity-guard.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    root: { type: 'string', default: path.resolve(directory, '../..') },
    check: { type: 'boolean' },
  },
});
const root = path.resolve(values.root);
const runtimeUrl = (file) => pathToFileURL(path.join(root, 'dist', file)).href;
const shapes = [
  { name: 'small', sites: 64, registrations: 8 },
  { name: 'wide', sites: 256, registrations: 8 },
  { name: 'dense', sites: 64, registrations: 32 },
  { name: 'wideDense', sites: 256, registrations: 32 },
  { name: 'overCap', sites: 256, registrations: 33 },
];

function makeFixture(temporary, shape) {
  const repo = path.join(temporary, shape.name);
  fs.mkdirSync(repo);
  const owner = 'export class Worker { execute() {} }\n';
  const registrations = Array.from(
    { length: shape.registrations },
    (_, i) => `function plugin${i}() {}\nexport const hooks${i} = { execute: plugin${i} };\n`,
  );
  const calls = Array.from(
    { length: shape.sites },
    (_, i) => `export function run${i}(worker: Worker) { worker.execute(); }\n`,
  );
  const sources = {
    'worker.ts': owner,
    'hooks.ts':
      registrations.join('') + 'function ready() {}\nexport const controls = { onReady: ready };\n',
    'app.ts':
      "import { Worker } from './worker.js';\n" +
      "import { controls } from './hooks.js';\n" +
      calls.join('') +
      'export function runControl() { controls.onReady(); }\n',
  };
  for (const [file, source] of Object.entries(sources)) {
    fs.writeFileSync(path.join(repo, file), source);
  }
  return {
    repo,
    sourceBytes: Object.values(sources).reduce(
      (total, source) => total + Buffer.byteLength(source),
      0,
    ),
    workload: fingerprintIds(Object.entries(sources).map((entry) => JSON.stringify(entry))),
  };
}

function inspect(graph, shape, cap) {
  const exact = [];
  const speculative = [];
  const registrations = [];
  const control = [];
  for (const edge of graph.iterRelationships()) {
    if (edge.type === 'USES' && edge.reason === 'scope-resolution: value-ref') {
      registrations.push(edge.targetId);
    } else if (edge.type === 'CALLS' && edge.sourceId === 'Function:app.ts:runControl') {
      control.push(edge.targetId);
    } else if (edge.type === 'CALLS' && edge.sourceId.startsWith('Function:app.ts:run')) {
      const pair = `${edge.sourceId}->${edge.targetId}`;
      if (edge.reason === 'property-dispatch') speculative.push(pair);
      else exact.push(pair);
    }
  }
  const expectedExact = [];
  const expectedSpeculative = [];
  const plugins = Array.from(
    { length: shape.registrations },
    (_, i) => `Function:hooks.ts:plugin${i}`,
  );
  for (let i = 0; i < shape.sites; i++) {
    const source = `Function:app.ts:run${i}`;
    expectedExact.push(`${source}->Method:worker.ts:Worker.execute#0`);
    if (shape.registrations <= cap) {
      for (const plugin of plugins) expectedSpeculative.push(`${source}->${plugin}`);
    }
  }
  assert.deepEqual(
    exact.sort(compareCodeUnits),
    expectedExact.sort(compareCodeUnits),
    `${shape.name}: exact receiver targets`,
  );
  assert.deepEqual(
    speculative.sort(compareCodeUnits),
    expectedSpeculative.sort(compareCodeUnits),
    `${shape.name}: speculative target sets`,
  );
  assert.deepEqual(
    registrations.sort(compareCodeUnits),
    [...plugins, 'Function:hooks.ts:ready'].sort(compareCodeUnits),
  );
  assert.deepEqual(control.sort(compareCodeUnits), [
    'Function:hooks.ts:ready',
    'Property:hooks.ts:controls.onReady',
  ]);
  return {
    exact: exact.length,
    speculative: speculative.length,
    registrations: registrations.length,
    control: control.length,
    targets: fingerprintIds([...exact, ...speculative, ...registrations, ...control]),
  };
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-property-dispatch-'));
try {
  const [{ runPipelineFromRepo }, { MAX_PROPERTY_DISPATCH_FANOUT: cap }] = await Promise.all([
    import(runtimeUrl('core/ingestion/pipeline.js')),
    import(runtimeUrl('core/ingestion/scope-resolution/passes/property-dispatch.js')),
  ]);
  assert.equal(cap, 32, 'run with the default GITNEXUS_MAX_PROPERTY_DISPATCH_FANOUT');
  const fixtures = shapes.map((shape) => makeFixture(temporary, shape));
  const reports = shapes.map(({ sites, registrations }, i) => ({
    sites,
    keyRegistrations: registrations,
    sourceBytes: fixtures[i].sourceBytes,
    workload: fixtures[i].workload,
    samplesMs: [],
    graph: undefined,
  }));
  for (let round = 0; round <= 3; round++) {
    for (let offset = 0; offset < shapes.length; offset++) {
      const i = (round + offset) % shapes.length;
      const started = performance.now();
      const output = await runPipelineFromRepo(fixtures[i].repo, () => {}, {
        skipDerivedGraphPhases: true,
        workerPoolSize: 1,
        parseChunkConcurrency: 1,
      });
      const elapsed = performance.now() - started;
      assert.deepEqual(output.scopeExtractionFailures ?? [], []);
      assert.equal(output.usedWorkerPool, true);
      assert.equal(output.reparsedFileCount, 3);
      const graph = inspect(output.graph, shapes[i], cap);
      if (round === 0) reports[i].graph = graph;
      else {
        assert.deepEqual(graph, reports[i].graph);
        reports[i].samplesMs.push(elapsed);
      }
    }
  }
  const contract = {
    cap,
    shapes: Object.fromEntries(
      reports.map(({ samplesMs: _, ...report }, i) => [shapes[i].name, report]),
    ),
  };
  if (values.check) {
    const baseline = JSON.parse(fs.readFileSync(path.join(directory, 'baseline.json'), 'utf8'));
    assert.deepEqual(contract, baseline);
  }
  console.log(
    'TS_PROPERTY_DISPATCH_RESULT ' +
      JSON.stringify({
        revision: runBenchmarkTool('git', ['-C', root, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        peakRssKiB: process.resourceUsage().maxRSS,
        contract,
        timing: Object.fromEntries(reports.map(({ samplesMs }, i) => [shapes[i].name, samplesMs])),
      }),
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
