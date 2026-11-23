/** Capture and resolution scaling for Python value references (#3942, #3943). */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SupportedLanguages } from 'gitnexus-shared';
import { emitPythonScopeCaptures } from '../../src/core/ingestion/languages/python/captures.ts';
import { createKnowledgeGraph } from '../../src/core/graph/graph.ts';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.ts';
import { SCOPE_RESOLVERS } from '../../src/core/ingestion/scope-resolution/pipeline/registry.ts';
import { runScopeResolution } from '../../src/core/ingestion/scope-resolution/pipeline/run.ts';
import { parseFilesWithWorkers } from '../../test/helpers/worker-parse.ts';
import { fingerprintIds } from '../lib/route-constant-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIZES = [128, 256, 512];
const RESOLUTION_SIZES = [128, 256, 512, 1024, 2048];
// Protocol: ../lexical-binding-provenance/README.md.
const PROTOCOL = {
  name: 'duration-calibrated-v2',
  targetIterationMs: 500,
  pilotConfirmationBatches: 3,
  maxPilotIterations: 64,
  maxInvocationsPerIteration: 1048576,
  warmup: 5,
  repetitions: 15,
  scalingBudget: 1.8,
  adjacentScalingBudget: 1.5,
};

function corpus(entities) {
  const definitions = [];
  const lines = ['from fastapi import Depends', 'from typing import Annotated'];
  for (let i = 0; i < entities; i++) {
    definitions.push(`TIMEOUT${i} = 30`, `def helper${i}(value):`, '    return value');
    lines.push(
      `from values import TIMEOUT${i}, helper${i}`,
      `class Reader${i}:`,
      `    TIMEOUT${i} = 1`,
      '    def read(self):',
      `        return TIMEOUT${i} + TIMEOUT${i}`,
      '    def member(self):',
      `        return self.TIMEOUT${i}`,
      '    def register(self, items):',
      `        return sorted(items, key=helper${i})`,
      '    def direct(self):',
      `        return helper${i}(1)`,
      `    def injected(self, dep=Depends(helper${i})):`,
      '        return dep',
      `    def annotation(self, dep: Annotated[int, Depends(helper${i})]):`,
      '        return dep',
      `    def shadow(self, helper${i}):`,
      `        return sorted([], key=helper${i})`,
      `    def type_only(self, value: helper${i} | None):`,
      '        return value',
    );
  }
  return [
    { path: 'values.py', content: definitions.join('\n') + '\n' },
    { path: 'readers.py', content: lines.join('\n') + '\n' },
  ];
}

function captureFacts(matches, entities) {
  const reads = matches.filter((m) => /^TIMEOUT\d+$/.test(m['@reference.read.identifier']?.text));
  const values = matches.filter((m) => /^helper\d+$/.test(m['@reference.value-ref']?.text));
  assert.equal(reads.length, entities * 2, 'Missing bare constant reads');
  assert.equal(values.length, entities * 3, 'Callback, metadata and shadow captures changed');
  const identities = matches.map((match) =>
    JSON.stringify(
      Object.keys(match)
        .sort()
        .map((tag) => [tag, match[tag].text, match[tag].range]),
    ),
  );
  return {
    groups: matches.length,
    bareReads: reads.length,
    valueRefs: values.length,
    fingerprint: fingerprintIds(identities),
  };
}

function graphFacts(graph, entities) {
  const actual = [];
  const nodes = [...graph.iterNodes()];
  const edges = [...graph.iterRelationships()];
  for (const edge of edges) {
    if (!['ACCESSES', 'USES', 'CALLS'].includes(edge.type)) continue;
    const target = graph.getNode(edge.targetId);
    if (!/^(TIMEOUT|helper)\d+$/.test(target?.properties.name)) continue;
    const source = graph.getNode(edge.sourceId);
    assert.ok(source && target, 'Dangling reference');
    actual.push(`${source.id}|${edge.type}|${target.id}`);
  }
  const expected = [];
  for (let i = 0; i < entities; i++) {
    expected.push(
      `Method:readers.py:Reader${i}.read#0|ACCESSES|Variable:values.py:TIMEOUT${i}`,
      `Method:readers.py:Reader${i}.read#0|ACCESSES|Variable:values.py:TIMEOUT${i}`,
      `Method:readers.py:Reader${i}.member#0|ACCESSES|Variable:readers.py:TIMEOUT${i}`,
      `Method:readers.py:Reader${i}.register#1|ACCESSES|Function:values.py:helper${i}`,
      `Method:readers.py:Reader${i}.register#1|USES|Function:values.py:helper${i}`,
      `Class:readers.py:Reader${i}|USES|Function:values.py:helper${i}`,
      `Method:readers.py:Reader${i}.direct#0|CALLS|Function:values.py:helper${i}`,
      `Method:readers.py:Reader${i}.injected#1|CALLS|Function:values.py:helper${i}`,
    );
  }
  assert.deepEqual(
    actual.sort(),
    expected.sort(),
    'Value edges, owners or negative controls changed',
  );
  return {
    nodes: nodes.length,
    edges: edges.length,
    accesses: entities * 4,
    uses: entities * 2,
    calls: entities * 2,
    fingerprint: fingerprintIds([
      ...nodes.map((node) => JSON.stringify([node.id, node.label, node.properties])),
      ...edges.map((edge) =>
        JSON.stringify([
          edge.id,
          edge.sourceId,
          edge.targetId,
          edge.type,
          edge.confidence,
          edge.reason,
        ]),
      ),
    ]),
  };
}

async function resolutionOperation(files) {
  const raw = [];
  const parsed = await parseFilesWithWorkers(files, { poolSize: 1, outRawResults: raw });
  assert.equal(parsed.data.parsedFiles.length, files.length, 'Scope extraction omitted a file');
  const nodes = [...parsed.graph.iterNodes()];
  const edges = [...parsed.graph.iterRelationships()];
  const symbols = raw.flatMap((chunk) => chunk.symbols);
  const resolver = SCOPE_RESOLVERS.get(SupportedLanguages.Python);
  assert.ok(resolver);
  return {
    prepare() {
      // Resolution mutates graph, model and ParsedFiles. Never reuse resolved state.
      const graph = createKnowledgeGraph();
      for (const node of structuredClone(nodes)) graph.addNode(node);
      for (const edge of structuredClone(edges)) graph.addRelationship(edge);
      for (const file of files)
        graph.addNode({
          id: `File:${file.path}`,
          label: 'File',
          properties: { name: file.path, filePath: file.path },
        });
      const model = createSemanticModel();
      for (const symbol of structuredClone(symbols)) {
        model.symbols.add(symbol.filePath, symbol.name, symbol.nodeId, symbol.type, symbol);
      }
      const preExtractedParsedFiles = new Map(
        structuredClone(parsed.data.parsedFiles).map((file) => [file.filePath, file]),
      );
      return {
        graph,
        model,
        files,
        preExtractedParsedFiles,
        onResolved: ({ parsedFiles }) => {
          assert.equal(parsedFiles.length, files.length, 'Resolution omitted files');
          for (const file of parsedFiles) {
            assert.equal(
              file,
              preExtractedParsedFiles.get(file.filePath),
              'Resolution reparsed a worker result',
            );
          }
        },
      };
    },
    run(input) {
      runScopeResolution(input, resolver);
      return input.graph;
    },
  };
}

function measure({ prepare, run }, verify, verifyOnly) {
  const initial = verify(run(prepare()));
  if (verifyOnly) return { facts: initial };
  let last;
  const iteration = (invocations) => {
    let workMs = 0;
    const wallStart = performance.now();
    for (let i = 0; i < invocations; i++) {
      const input = prepare();
      const start = performance.now();
      last = run(input);
      workMs += performance.now() - start;
    }
    return { invocations, workMs, wallMs: performance.now() - wallStart };
  };
  const pilotIterations = [];
  let invocations = 1;
  let confirmations = 0;
  for (let i = 0; i < PROTOCOL.maxPilotIterations; i++) {
    const pilot = iteration(invocations);
    const qualified = pilot.workMs >= PROTOCOL.targetIterationMs;
    pilotIterations.push({ ...pilot, qualified });
    if (qualified) {
      if (++confirmations === PROTOCOL.pilotConfirmationBatches) break;
    } else {
      confirmations = 0;
      if (invocations >= PROTOCOL.maxInvocationsPerIteration) break;
      invocations *= 2;
    }
  }
  assert.equal(confirmations, PROTOCOL.pilotConfirmationBatches, 'Pilot calibration exhausted');
  const warmupIterations = Array.from({ length: PROTOCOL.warmup }, () => iteration(invocations));
  const measuredIterations = Array.from({ length: PROTOCOL.repetitions }, () =>
    iteration(invocations),
  );
  const samplesMs = measuredIterations.map(({ workMs }) => workMs / invocations);
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const meanMs = samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length;
  const facts = verify(last);
  assert.deepEqual(facts, initial, 'Fresh invocations produced different outputs');
  return {
    facts,
    timing: {
      invocationsPerIteration: invocations,
      pilotIterations,
      warmupIterations,
      measuredIterations,
      samplesMs,
      minMs: sorted[0],
      medianMs: sorted[Math.floor(sorted.length / 2)],
      meanMs,
      standardDeviationMs: Math.sqrt(
        samplesMs.reduce((sum, ms) => sum + (ms - meanMs) ** 2, 0) / (samplesMs.length - 1),
      ),
    },
  };
}

export async function measurePythonValueReferences({
  check = false,
  verifyOnly = false,
  captureSizes = SIZES,
  resolutionSizes = RESOLUTION_SIZES,
} = {}) {
  for (const sizes of [captureSizes, resolutionSizes]) {
    assert.ok(
      sizes.length >= 3 &&
        sizes.every((n, i) => Number.isSafeInteger(n) && n > 0 && (i === 0 || n > sizes[i - 1])),
      'Use at least three increasing positive integer sizes',
    );
  }
  if (check) {
    assert.deepEqual(captureSizes, SIZES, '--check requires the capture baseline workload');
    assert.deepEqual(
      resolutionSizes,
      RESOLUTION_SIZES,
      '--check requires the resolution baseline workload',
    );
  }
  assert.ok(!(check && verifyOnly), '--check requires timing');
  const report = {
    protocol: PROTOCOL,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      loadAverage: os.loadavg(),
    },
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: HERE, encoding: 'utf8' }).trim(),
    dirty:
      execFileSync('git', ['status', '--porcelain'], { cwd: HERE, encoding: 'utf8' }).trim()
        .length > 0,
    sourceHashes: Object.fromEntries(
      [
        '../../src/core/ingestion/languages/python/captures.ts',
        '../../src/core/ingestion/languages/python/query.ts',
        '../../src/core/ingestion/languages/python/import-target.ts',
        '../../src/core/ingestion/languages/python/lexical-bindings.ts',
        '../../src/core/ingestion/languages/python/import-claims.ts',
        '../../src/core/ingestion/languages/python/attribute-references.ts',
        '../../../gitnexus-shared/src/scope-resolution/registries/lookup-core.ts',
        '../../dist/core/ingestion/workers/parse-worker.js',
        '../../dist/core/ingestion/languages/python/captures.js',
        '../../dist/core/ingestion/languages/python/query.js',
        '../../dist/core/ingestion/languages/python/import-target.js',
        '../../dist/core/ingestion/languages/python/lexical-bindings.js',
        '../../dist/core/ingestion/languages/python/import-claims.js',
        '../../dist/core/ingestion/languages/python/attribute-references.js',
        '../../../gitnexus-shared/dist/scope-resolution/registries/lookup-core.js',
      ].map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(resolve(HERE, file)))
          .digest('hex'),
      ]),
    ),
    sizes: { captures: captureSizes, resolution: resolutionSizes },
    arms: { captures: [], resolution: [] },
    errors: [],
  };
  const baseline = check
    ? JSON.parse(readFileSync(resolve(HERE, 'value-references-baseline.json'), 'utf8'))
    : {};
  for (const entities of [...new Set([...captureSizes, ...resolutionSizes])].sort(
    (a, b) => a - b,
  )) {
    const files = corpus(entities);
    const inputBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
    if (captureSizes.includes(entities))
      report.arms.captures.push({
        entities,
        inputBytes,
        ...measure(
          {
            prepare: () => undefined,
            run: () => emitPythonScopeCaptures(files[1].content, files[1].path),
          },
          (matches) => captureFacts(matches, entities),
          verifyOnly,
        ),
      });
    if (resolutionSizes.includes(entities)) {
      const operation = await resolutionOperation(files);
      report.arms.resolution.push({
        entities,
        inputBytes,
        ...measure(operation, (graph) => graphFacts(graph, entities), verifyOnly),
      });
    }
    process.stderr.write(
      `[python value references] ${entities} entities verified${verifyOnly ? '' : ' and measured'}\n`,
    );
  }
  for (const [arm, rows] of Object.entries(report.arms)) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (check && row.facts.fingerprint !== baseline[arm]?.[row.entities])
        report.errors.push(`${arm}/${row.entities}: fingerprint drift`);
      if (verifyOnly || i === 0) continue;
      const small = rows[0];
      row.scaling = Object.fromEntries(
        ['minMs', 'medianMs'].map((key) => [
          key,
          row.timing[key] / small.timing[key] / (row.entities / small.entities),
        ]),
      );
      for (const [stat, ratio] of Object.entries(row.scaling)) {
        if (!Number.isFinite(ratio) || ratio > PROTOCOL.scalingBudget)
          report.errors.push(
            `${arm}/${row.entities}/${stat}: scaling ${ratio} exceeds ${PROTOCOL.scalingBudget}`,
          );
      }
      const previous = rows[i - 1];
      row.adjacentScaling = Object.fromEntries(
        ['minMs', 'medianMs'].map((key) => [
          key,
          row.timing[key] / previous.timing[key] / (row.entities / previous.entities),
        ]),
      );
      for (const [stat, ratio] of Object.entries(row.adjacentScaling)) {
        if (!Number.isFinite(ratio) || ratio > PROTOCOL.adjacentScalingBudget)
          report.errors.push(
            `${arm}/${row.entities}/${stat}: adjacent scaling ${ratio} exceeds ${PROTOCOL.adjacentScalingBudget}`,
          );
      }
    }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean' },
      verify: { type: 'boolean' },
      sizes: { type: 'string' },
      output: { type: 'string' },
    },
  });
  const report = await measurePythonValueReferences({
    check: values.check,
    verifyOnly: values.verify,
    captureSizes: values.sizes?.split(',').map(Number),
    resolutionSizes: values.sizes?.split(',').map(Number),
  });
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(values.output, json);
  process.stdout.write(json);
  if (values.check && report.errors.length) process.exitCode = 1;
}
