#!/usr/bin/env node
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { mock } = require('node:test');
const { parseArgs } = require('node:util');

const packageCounts = [512, 1024, 2048, 4096];
const repetitions = 5;
const groupName = (i) => `service${String(i).padStart(6, '0')}`;

function writeFixture(root, packages) {
  mkdirSync(root);
  writeFileSync(join(root, 'go.mod'), 'module example.com/sdk\n\ngo 1.22\n');
  for (let i = 0; i < packages; i++) {
    const dir = join(root, groupName(i));
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'client.go'),
      [
        'package sdk',
        'type Client struct { ID int }',
        'func Step(value int) int { return value + 1 }',
        'func (c *Client) Run() int { return Apply(Step, c.ID) }',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'apply.go'),
      'package sdk\nfunc Apply(f func(int) int, value int) int { return f(value) }\n',
    );
  }
}

// Install timers before importing the pipeline. Both wrappers call the built
// implementation with the pipeline's own inputs. Keep only numbers per run.
async function loadPipeline() {
  const ownershipPath =
    '../../dist/core/ingestion/scope-resolution/pipeline/reconcile-ownership.js';
  const flowPath = '../../dist/core/ingestion/scope-resolution/passes/callable-value-flow.js';
  const ownership = await import(ownershipPath);
  const flow = await import(flowPath);
  assert.equal(typeof mock.module, 'function', 'run Node with --experimental-test-module-mocks');
  let sample;
  mock.module(ownershipPath, {
    namedExports: {
      ...ownership,
      reconcileOwnership(files, model) {
        assert.equal(sample.ownership, undefined, 'expected one ownership pass');
        const restore = [];
        try {
          if (sample.work) {
            for (const registry of [model.fields, model.types, model.methods]) {
              const lookup = registry.lookupAllByOwner;
              registry.lookupAllByOwner = (owner, name) => {
                const entries = lookup.call(registry, owner, name);
                sample.work.lookups++;
                sample.work.entriesReturned += entries.length;
                return entries;
              };
              restore.push(() => {
                registry.lookupAllByOwner = lookup;
              });
            }
          }
          const start = performance.now();
          const result = ownership.reconcileOwnership(files, model);
          sample.ownership = performance.now() - start;
          assert.equal(result.methodsRegistered, sample.packages);
          assert.equal(result.fieldsRegistered, sample.packages);
          return result;
        } finally {
          for (const reset of restore) reset();
        }
      },
    },
  });
  mock.module(flowPath, {
    namedExports: {
      ...flow,
      emitCallableValueFlow(input) {
        assert.equal(sample.callableFlow, undefined, 'expected one callable-flow pass');
        assert.equal(input.deferredIndirectSites.size, sample.packages);
        const start = performance.now();
        const result = flow.emitCallableValueFlow(input);
        sample.callableFlow = performance.now() - start;
        sample.iterations = result.iterations;
        assert.equal(result.resolvedInvokes, sample.packages);
        assert.ok(result.iterations > 0);
        return result;
      },
    },
  });
  const { runPipelineFromRepo } = await import('../../dist/core/ingestion/pipeline.js');
  return async (dir, packages, work) => {
    sample = { packages, work };
    const { graph } = await runPipelineFromRepo(dir, () => {}, {
      workerPoolSize: 1,
      skipGraphPhases: true,
    });
    assert.ok(sample.ownership > 0 && sample.callableFlow > 0, 'both passes must be measured');
    verifyCallbacks(graph, packages);
    return sample;
  };
}

function verifyCallbacks(graph, packages) {
  const expected = new Set(Array.from({ length: packages }, (_, i) => groupName(i) + '/apply.go'));
  for (const edge of graph.iterRelationshipsByType('CALLS')) {
    if (edge.reason !== 'callable-value-flow') continue;
    const source = graph.getNode(edge.sourceId)?.properties;
    const target = graph.getNode(edge.targetId)?.properties;
    assert.equal(source?.name, 'Apply');
    assert.equal(target?.name, 'Step');
    assert.ok(
      expected.delete(source.filePath),
      `unexpected or duplicate caller: ${source.filePath}`,
    );
    assert.equal(target.filePath, source.filePath.replace(/apply\.go$/, 'client.go'));
  }
  assert.equal(expected.size, 0, 'expected one cross-file callback per package');
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measure(root) {
  const run = await loadPipeline();
  const cases = packageCounts.map((packages) => {
    const dir = join(root, String(packages));
    writeFixture(dir, packages);
    return {
      dir,
      packages,
      work: { lookups: 0, entriesReturned: 0 },
      ownership: [],
      callableFlow: [],
    };
  });
  // Rotate size order. Instrument lookups only in the untimed warmup.
  for (let round = 0; round <= repetitions; round++) {
    for (let i = 0; i < cases.length; i++) {
      const c = cases[(round + i) % cases.length];
      const sample = await run(c.dir, c.packages, round === 0 ? c.work : undefined);
      if (round === 0) {
        assert.ok(c.work.lookups > 0, 'expected ownership lookups during warmup');
        c.work.iterations = sample.iterations;
      } else {
        assert.equal(sample.iterations, c.work.iterations);
        c.ownership.push(sample.ownership);
        c.callableFlow.push(sample.callableFlow);
      }
    }
  }
  return cases.map(({ packages, work, ownership, callableFlow }) => ({
    files: packages * 2,
    work,
    medianMs: { ownership: median(ownership), callableFlow: median(callableFlow) },
    samplesMs: { ownership, callableFlow },
  }));
}

function compare(rows, baseline) {
  assert.deepEqual(
    rows.map((row) => row.files),
    baseline.expectedFiles,
    'incomplete size sweep',
  );
  const comparisons = [];
  const errors = [];
  for (const [i, row] of rows.entries()) {
    for (const metric of ['lookups', 'entriesReturned', 'iterations']) {
      const limit = baseline.maxWorkPerFile[metric];
      assert.ok(Number.isFinite(limit) && limit >= 0, `invalid work budget for ${metric}`);
      assert.ok(
        Number.isSafeInteger(row.work[metric]) && row.work[metric] >= 0,
        `invalid ${metric}`,
      );
      if (row.work[metric] > row.files * limit) {
        errors.push(
          `${row.files} files: ${row.work[metric]} ${metric} exceeds ${row.files * limit}`,
        );
      }
    }
    // Check adjacent sizes and the full span so a slowdown at one size or
    // repeated smaller slowdowns cannot hide behind an average.
    for (const smaller of rows.slice(0, i)) {
      const timePerFileGrowth = {};
      for (const pass of ['ownership', 'callableFlow']) {
        const factor = row.medianMs[pass] / smaller.medianMs[pass] / (row.files / smaller.files);
        const limit = baseline.maxTimePerFileGrowth[pass];
        assert.ok(Number.isFinite(limit) && limit > 0, `invalid timing budget for ${pass}`);
        timePerFileGrowth[pass] = factor;
        if (!(factor <= limit)) {
          errors.push(
            `${pass}, ${smaller.files} -> ${row.files} files: time per file grew ${factor.toFixed(2)}x (limit ${limit}x)`,
          );
        }
      }
      comparisons.push({ fromFiles: smaller.files, toFiles: row.files, timePerFileGrowth });
    }
  }
  return { comparisons, errors };
}

async function main() {
  const { values } = parseArgs({
    options: { check: { type: 'boolean' }, output: { type: 'string' } },
  });
  const baseline = require('./baseline.json');
  const root = mkdtempSync(join(tmpdir(), 'gitnexus-go-scaling-'));
  try {
    const rows = await measure(root);
    const report = { node: process.version, rows, ...compare(rows, baseline) };
    const json = JSON.stringify(report, null, 2) + '\n';
    if (values.output) writeFileSync(values.output, json);
    process.stdout.write(json);
    if (values.check && report.errors.length) process.exitCode = 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
