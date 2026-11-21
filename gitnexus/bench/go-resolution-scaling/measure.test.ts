import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, vi } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

// Time the production calls on the model and graph supplied by the real pipeline.
// Retain only numbers: keeping even one mock call's arguments pins the entire graph.
const ownership: { ms: number; defs: number; methods: number; fields: number }[] = [];
const callable: { ms: number; deferred: number; iterations: number; resolved: number }[] = [];
type BucketCounts = { lookups: number; entriesReturned: number };
let warmupBuckets: BucketCounts | undefined;

vi.mock(
  import('../../src/core/ingestion/scope-resolution/pipeline/reconcile-ownership.js'),
  async (original) => {
    const actual = await original();
    return {
      ...actual,
      reconcileOwnership(files, model) {
        const counts = warmupBuckets;
        const restores: (() => void)[] = [];
        try {
          if (counts) {
            for (const registry of [model.fields, model.types, model.methods]) {
              const lookup = registry.lookupAllByOwner;
              registry.lookupAllByOwner = (owner, name) => {
                const bucket = lookup.call(registry, owner, name);
                counts.lookups++;
                counts.entriesReturned += bucket.length;
                return bucket;
              };
              restores.push(() => {
                registry.lookupAllByOwner = lookup;
              });
            }
          }
          const start = performance.now();
          const result = actual.reconcileOwnership(files, model);
          const ms = performance.now() - start;
          ownership.push({
            ms,
            defs: files.reduce((n, file) => n + file.localDefs.length, 0),
            methods: result.methodsRegistered,
            fields: result.fieldsRegistered,
          });
          return result;
        } finally {
          for (const restore of restores) restore();
        }
      },
    };
  },
);

vi.mock(
  import('../../src/core/ingestion/scope-resolution/passes/callable-value-flow.js'),
  async (original) => {
    const actual = await original();
    return {
      ...actual,
      emitCallableValueFlow(input) {
        const start = performance.now();
        const result = actual.emitCallableValueFlow(input);
        const ms = performance.now() - start;
        assert.ok(input.deferredIndirectSites, 'expected deferred sites from the collection pass');
        callable.push({
          ms,
          deferred: input.deferredIndirectSites.size,
          iterations: result.iterations,
          resolved: result.resolvedInvokes,
        });
        return result;
      },
    };
  },
);

const groupName = (i: number) => `service${String(i).padStart(6, '0')}`;

function writeFixture(root: string, packages: number) {
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
      ['package sdk', 'func Apply(f func(int) int, value int) int { return f(value) }', ''].join(
        '\n',
      ),
    );
  }
}

async function measure(root: string, packages: number) {
  ownership.length = 0;
  callable.length = 0;
  const { graph } = await runPipelineFromRepo(root, () => {}, {
    workerPoolSize: 1,
    skipGraphPhases: true,
  });
  assert.equal(ownership.length, 1, 'expected one ownership reconciliation');
  assert.equal(callable.length, 1, 'expected one callable-flow pass');
  const [owner] = ownership;
  const [flow] = callable;
  assert.equal(owner.methods, packages, 'one owned Run method per Client');
  assert.equal(owner.fields, packages, 'one owned ID field per Client');
  assert.equal(flow.deferred, packages);
  assert.equal(flow.resolved, packages);
  assert.ok(flow.iterations > 0);

  const expected = new Set(Array.from({ length: packages }, (_, i) => groupName(i) + '/apply.go'));
  for (const edge of graph.iterRelationshipsByType('CALLS')) {
    if (edge.reason !== 'callable-value-flow') continue;
    const source = graph.getNode(edge.sourceId)?.properties;
    const target = graph.getNode(edge.targetId)?.properties;
    assert.ok(source?.filePath, `missing callable-flow caller: ${edge.sourceId}`);
    assert.ok(target, `missing callable-flow target: ${edge.targetId}`);
    assert.equal(source.name, 'Apply');
    assert.equal(target.name, 'Step');
    assert.ok(
      expected.delete(source.filePath),
      `unexpected or duplicate caller: ${source.filePath}`,
    );
    assert.equal(target.filePath, source.filePath.replace(/apply\.go$/, 'client.go'));
  }
  assert.equal(expected.size, 0, 'expected a cross-file callback edge in every package');
  return { owner, flow };
}

function median(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2;
}

// Least-squares slope of log(time) against log(files), using every measured size.
function exponent(files: number[], times: number[]) {
  assert.ok(
    times.every((ms) => ms > 0),
    'each median must be positive to calculate an exponent',
  );
  const x = files.map(Math.log);
  const y = times.map(Math.log);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const mx = mean(x);
  const my = mean(y);
  return (
    x.reduce((s, xi, i) => s + (xi - mx) * (y[i] - my), 0) /
    x.reduce((s, xi) => s + (xi - mx) ** 2, 0)
  );
}

it('measures Go ownership reconciliation and deferred callable flow across package counts', async () => {
  const sizes = (process.env.GO_BENCH_PACKAGES ?? '64,128,256,512,1024').split(',').map(Number);
  const reps = Number(process.env.GO_BENCH_REPS ?? 5);
  assert.ok(
    sizes.length >= 2 &&
      sizes.every((n, i) => Number.isSafeInteger(n) && n > 0 && (!i || n > sizes[i - 1])),
    'provide increasing positive package counts',
  );
  assert.ok(Number.isSafeInteger(reps) && reps > 0, 'provide a positive repetition count');
  const root = mkdtempSync(join(tmpdir(), 'gitnexus-go-scaling-'));
  try {
    const cases = sizes.map((packages) => {
      const dir = join(root, String(packages));
      mkdirSync(dir);
      writeFixture(dir, packages);
      return {
        dir,
        packages,
        buckets: { lookups: 0, entriesReturned: 0 },
        samples: [] as Awaited<ReturnType<typeof measure>>[],
      };
    });
    for (let round = 0; round <= reps; round++) {
      for (let i = 0; i < cases.length; i++) {
        const c = cases[(round + i) % cases.length];
        warmupBuckets = round === 0 ? c.buckets : undefined;
        const sample = await measure(c.dir, c.packages);
        if (round > 0) c.samples.push(sample);
      }
    }
    const rows = cases.map(({ packages, buckets, samples }) => {
      assert.ok(buckets.lookups > 0, 'expected owner lookups in the instrumented warmup');
      const ownerMs = samples.map((s) => s.owner.ms);
      const flowMs = samples.map((s) => s.flow.ms);
      const { owner, flow } = samples[0];
      for (const s of samples) {
        assert.equal(s.owner.defs, owner.defs);
        assert.equal(s.flow.iterations, flow.iterations);
      }
      return {
        files: packages * 2,
        defs: owner.defs,
        ...buckets,
        deferred: flow.deferred,
        iterations: flow.iterations,
        ownerMedianMs: median(ownerMs),
        flowMedianMs: median(flowMs),
        ownerMs,
        flowMs,
      };
    });
    const files = rows.map((r) => r.files);
    process.stdout.write(
      'GO_RESOLUTION_SCALING ' +
        JSON.stringify({
          node: process.version,
          rows,
          ownerExponent: exponent(
            files,
            rows.map((r) => r.ownerMedianMs),
          ),
          flowExponent: exponent(
            files,
            rows.map((r) => r.flowMedianMs),
          ),
        }) +
        '\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
